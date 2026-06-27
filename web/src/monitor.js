'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const crypto = require('crypto');
const os = require('os');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG_FILE = '/opt/linux-security-monitor/config/monitor.conf';
const DB_FILE = process.env.LSM_DB_FILE || '/var/lib/lsm/lsm.db';
const PORT = parseInt(process.env.WEB_PORT || '8443', 10);
const HOST = process.env.WEB_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let config = {
    WEB_AUTH_ENABLED: 'true',
    WEB_USERNAME: 'admin',
    WEB_PASSWORD_HASH: '',
    WEB_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    LOG_LEVEL: 'INFO',
};

function loadConfig() {
    try {
        const content = fs.readFileSync(CONFIG_FILE, 'utf8');
        content.split('\n').forEach(line => {
            const match = line.match(/^(\w+)="?([^"#]*)"?\s*$/);
            if (match) {
                config[match[1]] = match[2].trim();
            }
        });
    } catch {
        // Use defaults
    }
}
loadConfig();

// ============================================================
// DATABASE
// ============================================================
const Database = require('better-sqlite3');
let db;

function initDb() {
    try {
        db = new Database(DB_FILE, { readonly: true });
        db.pragma('journal_mode = WAL');
    } catch (err) {
        console.error('DB init error:', err.message);
        db = null;
    }
}
initDb();

function queryDb(sql, params = []) {
    if (!db) return [];
    try {
        return db.prepare(sql).all(...params);
    } catch (err) {
        console.error('DB query error:', err.message, sql);
        return [];
    }
}

function queryDbOne(sql, params = []) {
    if (!db) return null;
    try {
        return db.prepare(sql).get(...params);
    } catch {
        return null;
    }
}

// ============================================================
// AUTHENTICATION
// ============================================================
const sessions = new Map();

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, created: Date.now() });
    return token;
}

function validateSession(token) {
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.created > 86400000) {
        sessions.delete(token);
        return null;
    }
    return session;
}

function getSessionToken(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/lsm_session=([a-f0-9]+)/);
    return match ? match[1] : null;
}

function isAuthenticated(req) {
    if (config.WEB_AUTH_ENABLED !== 'true') return true;
    const token = getSessionToken(req);
    return token ? !!validateSession(token) : false;
}

// ============================================================
// SHELL EXEC HELPER
// ============================================================
function execShell(cmd, timeoutMs = 8000) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
            resolve(err ? '' : stdout.trim());
        });
    });
}

// ============================================================
// SYSTEM METRICS (live)
// ============================================================
async function getLiveMetrics() {
    const [cpu, memInfo, swapInfo, loadAvg, uptime] = await Promise.all([
        execShell("top -bn1 | grep 'Cpu(s)' | sed \"s/.*, *\\([0-9.]*\\)%* id.*/\\1/\" | awk '{print 100 - $1}'"),
        execShell("free -m | awk 'NR==2{printf \"%s %s %s\", $2, $3, $4}'"),
        execShell("free -m | awk 'NR==3{printf \"%s %s\", $2, $3}'"),
        execShell("cat /proc/loadavg"),
        execShell("cat /proc/uptime | awk '{print int($1)}'"),
    ]);

    const [memTotal, memUsed, memFree] = (memInfo || '0 0 0').split(' ').map(Number);
    const memPct = memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(1) : 0;
    const [swapTotal, swapUsed] = (swapInfo || '0 0').split(' ').map(Number);
    const swapPct = swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(1) : 0;

    const loads = (loadAvg || '0 0 0').split(' ');

    return {
        cpu: parseFloat(cpu) || 0,
        memory: {
            total: memTotal,
            used: memUsed,
            free: memFree,
            percent: parseFloat(memPct),
        },
        swap: {
            total: swapTotal,
            used: swapUsed,
            percent: parseFloat(swapPct),
        },
        load: {
            '1m': parseFloat(loads[0]) || 0,
            '5m': parseFloat(loads[1]) || 0,
            '15m': parseFloat(loads[2]) || 0,
        },
        uptime: parseInt(uptime) || 0,
        hostname: os.hostname(),
    };
}

async function getDiskMetrics() {
    const output = await execShell("df -h --output=source,size,used,avail,pcent,target 2>/dev/null | tail -n +2 | grep -v tmpfs");
    return output.split('\n').filter(Boolean).map(line => {
        const parts = line.trim().split(/\s+/);
        return {
            device: parts[0],
            size: parts[1],
            used: parts[2],
            avail: parts[3],
            percent: parseInt(parts[4]) || 0,
            mount: parts[5],
        };
    });
}

// ============================================================
// NETWORK METRICS
// ============================================================
// Store previous /proc/net/dev readings for delta calculation
let prevNetStats = null;
let prevNetTime = null;

function parseNetDev(raw) {
    const stats = {};
    const lines = raw.split('\n').slice(2);
    for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.trim().split(/\s+/);
        const iface = parts[0].replace(':', '');
        if (iface === 'lo') continue;
        stats[iface] = {
            rx_bytes: parseInt(parts[1]) || 0,
            rx_packets: parseInt(parts[2]) || 0,
            tx_bytes: parseInt(parts[9]) || 0,
            tx_packets: parseInt(parts[10]) || 0,
        };
    }
    return stats;
}

async function getNetworkLive() {
    const [netDev, ssSummary, established, timeWait, listening, topIps] = await Promise.all([
        execShell('cat /proc/net/dev'),
        execShell('ss -s 2>/dev/null'),
        execShell("ss -tn state established 2>/dev/null | wc -l"),
        execShell("ss -tn state time-wait 2>/dev/null | wc -l"),
        execShell("ss -tn 2>/dev/null | grep LISTEN | wc -l"),
        execShell("ss -tn state established 2>/dev/null | awk 'NR>1{print $5}' | sed 's/:[^:]*$//' | sort | uniq -c | sort -rn | head 10"),
    ]);

    const currentStats = parseNetDev(netDev);
    const now = Date.now();
    let deltas = {};

    if (prevNetStats && prevNetTime) {
        const elapsed = (now - prevNetTime) / 1000;
        for (const iface of Object.keys(currentStats)) {
            if (prevNetStats[iface]) {
                deltas[iface] = {
                    rx_bps: Math.max(0, (currentStats[iface].rx_bytes - prevNetStats[iface].rx_bytes) / elapsed),
                    tx_bps: Math.max(0, (currentStats[iface].tx_bytes - prevNetStats[iface].tx_bytes) / elapsed),
                };
            }
        }
    }

    prevNetStats = currentStats;
    prevNetTime = now;

    // Parse top IPs
    const topIpsList = topIps.split('\n').filter(Boolean).map(line => {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        return m ? { count: parseInt(m[1]), ip: m[2] } : null;
    }).filter(Boolean);

    return {
        interfaces: currentStats,
        deltas,
        connections: {
            established: Math.max(0, parseInt(established) - 1),
            time_wait: Math.max(0, parseInt(timeWait) - 1),
            listening: parseInt(listening) || 0,
        },
        ss_summary: ssSummary,
        top_ips: topIpsList,
    };
}

// ============================================================
// PM2
// ============================================================
async function getPm2List() {
    const [jlist, nodeVer, pm2Ver] = await Promise.all([
        execShell('pm2 jlist 2>/dev/null'),
        execShell('node --version 2>/dev/null'),
        execShell('pm2 --version 2>/dev/null'),
    ]);

    let apps = [];
    try {
        apps = JSON.parse(jlist || '[]');
    } catch {
        apps = [];
    }

    return {
        apps,
        node_version: nodeVer || 'N/A',
        pm2_version: pm2Ver || 'N/A',
        total: apps.length,
        online: apps.filter(a => a.pm2_env && a.pm2_env.status === 'online').length,
        offline: apps.filter(a => !a.pm2_env || a.pm2_env.status !== 'online').length,
    };
}

async function getPm2Logs(id) {
    return execShell(`pm2 logs ${id} --lines 100 --nostream --no-color 2>/dev/null`, 15000);
}

async function pm2Action(id, action) {
    const allowed = ['restart', 'stop', 'start', 'reload'];
    if (!allowed.includes(action)) throw new Error('Invalid action');
    return execShell(`pm2 ${action} ${id} 2>&1`, 15000);
}

// ============================================================
// DOCKER
// ============================================================
async function getDockerInfo() {
    const [containers, stats] = await Promise.all([
        execShell("docker ps -a --format '{{json .}}' 2>/dev/null"),
        execShell("docker stats --no-stream --format '{{json .}}' 2>/dev/null"),
    ]);

    const parseJsonLines = (raw) => raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const containerList = parseJsonLines(containers);
    const statsList = parseJsonLines(stats);

    // Merge stats into containers
    const statsMap = {};
    for (const s of statsList) {
        statsMap[s.Name || s.ID] = s;
    }

    const merged = containerList.map(c => ({
        ...c,
        stats: statsMap[c.Names] || statsMap[c.ID] || null,
    }));

    return {
        available: containerList.length > 0 || containers !== '',
        containers: merged,
    };
}

// ============================================================
// SERVICES
// ============================================================
const MONITORED_SERVICES = ['ssh', 'nginx', 'pm2-root', 'docker', 'postgresql', 'redis', 'mysql', 'fail2ban'];

async function getServicesStatus() {
    const checks = await Promise.all(
        MONITORED_SERVICES.map(async (svc) => {
            const [active, since] = await Promise.all([
                execShell(`systemctl is-active ${svc} 2>/dev/null`),
                execShell(`systemctl show ${svc} --property=ActiveEnterTimestamp 2>/dev/null`),
            ]);
            const sinceMatch = since.match(/ActiveEnterTimestamp=(.+)/);
            return {
                name: svc,
                status: active.trim() || 'unknown',
                active: active.trim() === 'active',
                since: sinceMatch ? sinceMatch[1].trim() : null,
            };
        })
    );
    return checks;
}

// ============================================================
// PROCESSES
// ============================================================
async function getTopProcesses() {
    const output = await execShell("ps aux --sort=-%cpu | head -21 | tail -20");
    return output.split('\n').filter(Boolean).map(line => {
        const parts = line.trim().split(/\s+/);
        return {
            user: parts[0],
            pid: parseInt(parts[1]) || 0,
            cpu: parseFloat(parts[2]) || 0,
            mem: parseFloat(parts[3]) || 0,
            vsz: parts[4],
            rss: parts[5],
            stat: parts[7],
            time: parts[9],
            command: parts.slice(10).join(' ').substring(0, 120),
        };
    });
}

// ============================================================
// DISK I/O
// ============================================================
async function getDiskIO() {
    const [iostat, diskstats] = await Promise.all([
        execShell('iostat -x 1 1 2>/dev/null'),
        execShell('cat /proc/diskstats'),
    ]);
    return { iostat: iostat || diskstats, diskstats };
}

// ============================================================
// SSL CERTIFICATES
// ============================================================
async function getSslInfo() {
    const confFiles = await execShell("find /etc/nginx/sites-enabled/ -name '*.conf' 2>/dev/null");
    const serverNames = await execShell(
        "find /etc/nginx/sites-enabled/ -type f 2>/dev/null | xargs grep -h 'server_name' 2>/dev/null | grep -v '#'"
    );

    const domains = new Set();
    const nameRegex = /server_name\s+([^;]+);/g;
    let m;
    while ((m = nameRegex.exec(serverNames)) !== null) {
        m[1].trim().split(/\s+/).forEach(d => {
            if (d && d !== '_' && !d.startsWith('*') && d.includes('.')) {
                domains.add(d);
            }
        });
    }

    const results = await Promise.all(Array.from(domains).slice(0, 10).map(async (domain) => {
        const out = await execShell(
            `echo | timeout 5 openssl s_client -connect ${domain}:443 -servername ${domain} 2>/dev/null | openssl x509 -noout -dates 2>/dev/null`,
            10000
        );
        let notBefore = null, notAfter = null, daysLeft = null;
        if (out) {
            const nb = out.match(/notBefore=(.+)/);
            const na = out.match(/notAfter=(.+)/);
            if (nb) notBefore = nb[1].trim();
            if (na) {
                notAfter = na[1].trim();
                const expiry = new Date(notAfter);
                daysLeft = Math.floor((expiry - Date.now()) / 86400000);
            }
        }
        return {
            domain,
            not_before: notBefore,
            not_after: notAfter,
            days_left: daysLeft,
            status: daysLeft === null ? 'unknown' : daysLeft < 0 ? 'expired' : daysLeft < 14 ? 'critical' : daysLeft < 30 ? 'warning' : 'ok',
        };
    }));

    return results;
}

// ============================================================
// NGINX STATS
// ============================================================
async function getNginxStats() {
    const raw = await execShell('tail -1000 /var/log/nginx/access.log 2>/dev/null');
    const lines = raw.split('\n').filter(Boolean);
    const statusCodes = {};
    let totalTime = 0, timeCount = 0;
    const ips = {};
    const reqPerMinute = {};

    for (const line of lines) {
        // Parse status code
        const statusM = line.match(/" (\d{3}) /);
        if (statusM) {
            statusCodes[statusM[1]] = (statusCodes[statusM[1]] || 0) + 1;
        }
        // Parse response time (if present)
        const timeM = line.match(/(\d+\.\d+)$/);
        if (timeM) {
            totalTime += parseFloat(timeM[1]);
            timeCount++;
        }
        // Parse IP
        const ipM = line.match(/^(\S+)/);
        if (ipM) {
            ips[ipM[1]] = (ips[ipM[1]] || 0) + 1;
        }
        // Minute bucket
        const timeStampM = line.match(/\[(\d{2}\/\w+\/\d{4}:\d{2}:\d{2})/);
        if (timeStampM) {
            const bucket = timeStampM[1].substring(0, 16);
            reqPerMinute[bucket] = (reqPerMinute[bucket] || 0) + 1;
        }
    }

    const topIps = Object.entries(ips).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ip, count]) => ({ ip, count }));
    const avgTime = timeCount > 0 ? (totalTime / timeCount).toFixed(3) : null;

    return {
        total_lines: lines.length,
        status_codes: statusCodes,
        avg_response_time: avgTime,
        top_ips: topIps,
        req_per_minute: reqPerMinute,
    };
}

// ============================================================
// COMBINED FULL SYSTEM ENDPOINT
// ============================================================
async function getFullSystemData() {
    const [metrics, disks, network, pm2, docker, services, processes, ssl, nginx] = await Promise.all([
        getLiveMetrics(),
        getDiskMetrics(),
        getNetworkLive(),
        getPm2List().catch(() => ({ apps: [], error: true })),
        getDockerInfo().catch(() => ({ available: false, containers: [] })),
        getServicesStatus().catch(() => []),
        getTopProcesses().catch(() => []),
        getSslInfo().catch(() => []),
        getNginxStats().catch(() => ({})),
    ]);

    const now = Math.floor(Date.now() / 1000);
    const day = now - 86400;
    const hour = now - 3600;

    const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');
    const stats = {
        events_1h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?', [hour]) || {}).cnt || 0,
        events_24h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?', [day]) || {}).cnt || 0,
        critical_24h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE severity=4 AND timestamp > ?', [day]) || {}).cnt || 0,
        failed_logins_24h: (queryDbOne("SELECT COUNT(*) as cnt FROM events WHERE module='SSH' AND event_type='FAILED_LOGIN' AND timestamp > ?", [day]) || {}).cnt || 0,
        integrity_changes_24h: (queryDbOne("SELECT COUNT(*) as cnt FROM events WHERE module='INTEGRITY' AND timestamp > ?", [day]) || {}).cnt || 0,
    };

    const recentEvents = queryDb(
        'SELECT id, module, event_type, severity, title, timestamp, source_ip FROM events ORDER BY timestamp DESC LIMIT 10'
    );

    return {
        timestamp: now,
        metrics,
        disks,
        network,
        pm2,
        docker,
        services,
        processes: processes.slice(0, 20),
        ssl,
        nginx,
        riskScore: riskRow ? riskRow.score : 0,
        stats,
        recentEvents,
    };
}

// ============================================================
// API HANDLERS
// ============================================================

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

const apiRoutes = {
    'GET /api/status': async (req, res) => {
        const metrics = await getLiveMetrics();
        const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');
        const score = riskRow ? riskRow.score : 0;
        const criticalEvents = queryDbOne(
            "SELECT COUNT(*) as cnt FROM events WHERE severity=4 AND timestamp > strftime('%s','now','-1 hour')"
        );
        send200(res, {
            status: 'ok',
            version: '2.0.0',
            hostname: os.hostname(),
            metrics,
            riskScore: score,
            criticalEvents: criticalEvents ? criticalEvents.cnt : 0,
        });
    },

    'GET /api/events': (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const severity = url.searchParams.get('severity');
        const module = url.searchParams.get('module');
        const since = url.searchParams.get('since');

        let sql = 'SELECT * FROM events WHERE 1=1';
        const params = [];

        if (severity) { sql += ' AND severity=?'; params.push(parseInt(severity)); }
        if (module)   { sql += ' AND module=?';   params.push(module.toUpperCase()); }
        if (since)    { sql += ' AND timestamp > ?'; params.push(parseInt(since)); }

        sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const events = queryDb(sql, params);
        const total = queryDbOne('SELECT COUNT(*) as cnt FROM events');
        send200(res, { events, total: total ? total.cnt : 0, limit, offset });
    },

    'GET /api/metrics': (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const name = url.searchParams.get('name') || 'cpu_usage';
        const hours = parseInt(url.searchParams.get('hours') || '24');
        const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

        const rows = queryDb(
            'SELECT timestamp, metric_value, tags FROM metrics WHERE metric_name=? AND timestamp > ? ORDER BY timestamp ASC',
            [name, cutoff]
        );
        send200(res, { name, data: rows });
    },

    'GET /api/metrics/live': async (req, res) => {
        const [metrics, disks] = await Promise.all([getLiveMetrics(), getDiskMetrics()]);
        send200(res, { ...metrics, disks, timestamp: Math.floor(Date.now() / 1000) });
    },

    'GET /api/risk': (req, res) => {
        const hours = 24;
        const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
        const history = queryDb(
            'SELECT timestamp, score FROM risk_scores WHERE timestamp > ? ORDER BY timestamp ASC',
            [cutoff]
        );
        const current = queryDbOne('SELECT * FROM risk_scores ORDER BY timestamp DESC LIMIT 1');
        send200(res, { current, history });
    },

    'GET /api/integrity': (req, res) => {
        const changes = queryDb("SELECT * FROM integrity_changes ORDER BY timestamp DESC LIMIT 50");
        const baseline = queryDbOne('SELECT COUNT(*) as cnt FROM integrity_baseline');
        send200(res, { changes, baselineCount: baseline ? baseline.cnt : 0 });
    },

    'GET /api/summary': async (req, res) => {
        const now = Math.floor(Date.now() / 1000);
        const day = now - 86400;
        const hour = now - 3600;

        const [metrics, disks] = await Promise.all([getLiveMetrics(), getDiskMetrics()]);
        const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');

        const stats = {
            events_1h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?', [hour]) || {}).cnt || 0,
            events_24h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?', [day]) || {}).cnt || 0,
            critical_24h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE severity=4 AND timestamp > ?', [day]) || {}).cnt || 0,
            failed_logins_1h: (queryDbOne("SELECT COUNT(*) as cnt FROM events WHERE module='SSH' AND event_type='FAILED_LOGIN' AND timestamp > ?", [hour]) || {}).cnt || 0,
            failed_logins_24h: (queryDbOne("SELECT COUNT(*) as cnt FROM events WHERE module='SSH' AND event_type='FAILED_LOGIN' AND timestamp > ?", [day]) || {}).cnt || 0,
            integrity_changes_24h: (queryDbOne("SELECT COUNT(*) as cnt FROM events WHERE module='INTEGRITY' AND timestamp > ?", [day]) || {}).cnt || 0,
        };

        const recentEvents = queryDb(
            'SELECT id, module, event_type, severity, title, timestamp FROM events ORDER BY timestamp DESC LIMIT 10'
        );

        const moduleStats = queryDb(
            'SELECT module, COUNT(*) as cnt FROM events WHERE timestamp > ? GROUP BY module ORDER BY cnt DESC',
            [day]
        );

        send200(res, {
            timestamp: now,
            riskScore: riskRow ? riskRow.score : 0,
            metrics,
            disks,
            stats,
            recentEvents,
            moduleStats,
        });
    },

    'GET /api/modules': (req, res) => {
        const modules = queryDb('SELECT DISTINCT module FROM events ORDER BY module');
        send200(res, { modules: modules.map(r => r.module) });
    },

    // ---- NEW ENDPOINTS ----

    'GET /api/network/live': async (req, res) => {
        const data = await getNetworkLive();
        send200(res, data);
    },

    'GET /api/pm2': async (req, res) => {
        const data = await getPm2List();
        send200(res, data);
    },

    'GET /api/docker': async (req, res) => {
        const data = await getDockerInfo();
        send200(res, data);
    },

    'GET /api/services': async (req, res) => {
        const data = await getServicesStatus();
        send200(res, { services: data });
    },

    'GET /api/processes': async (req, res) => {
        const data = await getTopProcesses();
        send200(res, { processes: data });
    },

    'GET /api/disk/io': async (req, res) => {
        const data = await getDiskIO();
        send200(res, data);
    },

    'GET /api/ssl': async (req, res) => {
        const data = await getSslInfo();
        send200(res, { certificates: data });
    },

    'GET /api/nginx/stats': async (req, res) => {
        const data = await getNginxStats();
        send200(res, data);
    },

    'GET /api/system/full': async (req, res) => {
        const data = await getFullSystemData();
        send200(res, data);
    },

    // ---- AUTH ----

    'POST /api/login': (req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            try {
                const { username, password } = JSON.parse(body);
                const expectedHash = config.WEB_PASSWORD_HASH || hashPassword('admin');
                const providedHash = hashPassword(password || '');

                if (username === (config.WEB_USERNAME || 'admin') && providedHash === expectedHash) {
                    const token = createSession(username);
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Set-Cookie': `lsm_session=${token}; HttpOnly; Path=/; Max-Age=86400`,
                    });
                    res.end(JSON.stringify({ ok: true, token }));
                } else {
                    send401(res, 'Invalid credentials');
                }
            } catch {
                send400(res, 'Invalid request body');
            }
        });
    },

    'POST /api/logout': (req, res) => {
        const token = getSessionToken(req);
        if (token) sessions.delete(token);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'lsm_session=; HttpOnly; Path=/; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
    },

    'POST /api/events/acknowledge': (req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            try {
                const { id } = JSON.parse(body);
                const writeDb = new Database(DB_FILE);
                writeDb.prepare('UPDATE events SET acknowledged=1 WHERE id=?').run(id);
                writeDb.close();
                send200(res, { ok: true });
            } catch (err) {
                send500(res, err.message);
            }
        });
    },

    'POST /api/process/kill': async (req, res) => {
        if (!isAuthenticated(req)) { send401(res, 'Authentication required'); return; }
        try {
            const body = await readBody(req);
            const pid = parseInt(body.pid);
            if (!pid || isNaN(pid) || pid <= 1) {
                send400(res, 'Invalid PID');
                return;
            }
            const result = await execShell(`kill -9 ${pid} 2>&1`);
            send200(res, { ok: true, output: result });
        } catch (err) {
            send500(res, err.message);
        }
    },
};

// Dynamic PM2 routes (with path params)
async function handlePm2LogsRoute(req, res, id) {
    if (!isAuthenticated(req)) { send401(res, 'Authentication required'); return; }
    const logs = await getPm2Logs(id);
    send200(res, { id, logs });
}

async function handlePm2ActionRoute(req, res, id) {
    if (!isAuthenticated(req)) { send401(res, 'Authentication required'); return; }
    try {
        const body = await readBody(req);
        const action = body.action;
        if (!action) { send400(res, 'action required'); return; }
        const result = await pm2Action(id, action);
        send200(res, { ok: true, output: result });
    } catch (err) {
        send500(res, err.message);
    }
}

function send200(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}
function send400(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}
function send401(res, msg) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}
function send403(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
}
function send404(res) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
}
function send500(res, msg) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

// ============================================================
// STATIC FILE SERVER
// ============================================================
const MIME_TYPES = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff2':'font/woff2',
};

function serveStatic(req, res) {
    let urlPath = new URL(req.url, 'http://localhost').pathname;
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
        send403(res);
        return;
    }

    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
                if (e2) { send404(res); return; }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(d2);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
}

// ============================================================
// HTTP REQUEST HANDLER
// ============================================================
function handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    const urlPath = new URL(req.url, 'http://localhost').pathname;

    if (urlPath.startsWith('/api/')) {
        const isPublic = urlPath === '/api/login';
        if (!isPublic && !isAuthenticated(req)) {
            send401(res, 'Authentication required');
            return;
        }

        // Dynamic PM2 routes
        const pm2LogsMatch = urlPath.match(/^\/api\/pm2\/([^/]+)\/logs$/);
        if (pm2LogsMatch && req.method === 'GET') {
            Promise.resolve(handlePm2LogsRoute(req, res, pm2LogsMatch[1])).catch(err => send500(res, err.message));
            return;
        }
        const pm2ActionMatch = urlPath.match(/^\/api\/pm2\/([^/]+)\/action$/);
        if (pm2ActionMatch && req.method === 'POST') {
            Promise.resolve(handlePm2ActionRoute(req, res, pm2ActionMatch[1])).catch(err => send500(res, err.message));
            return;
        }

        const routeKey = `${req.method} ${urlPath}`;
        const handler = apiRoutes[routeKey];

        if (handler) {
            Promise.resolve(handler(req, res)).catch(err => {
                console.error('API error:', err);
                send500(res, 'Internal server error');
            });
        } else {
            send404(res);
        }
        return;
    }

    if (!isAuthenticated(req) && urlPath !== '/login.html') {
        res.writeHead(302, { Location: '/login.html' });
        res.end();
        return;
    }

    serveStatic(req, res);
}

// ============================================================
// HTTP SERVER
// ============================================================
const server = http.createServer(handleRequest);

// ============================================================
// WEBSOCKET SERVER
// ============================================================
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws, req) => {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/lsm_session=([a-f0-9]+)/);
    if (config.WEB_AUTH_ENABLED === 'true' && (!match || !validateSession(match[1]))) {
        ws.close(4001, 'Unauthorized');
        return;
    }

    clients.add(ws);
    console.log(`WebSocket client connected (total: ${clients.size})`);

    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });

    sendInitToClient(ws);
});

function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, timestamp: Date.now() });
    for (const client of clients) {
        if (client.readyState === 1) {
            client.send(msg);
        }
    }
}

async function sendInitToClient(ws) {
    try {
        const [metrics, disks] = await Promise.all([getLiveMetrics(), getDiskMetrics()]);
        const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');
        ws.send(JSON.stringify({
            type: 'init',
            data: { metrics, disks, riskScore: riskRow ? riskRow.score : 0 },
            timestamp: Date.now(),
        }));
    } catch { /* ignore */ }
}

// ============================================================
// REAL-TIME PUSH
// ============================================================
let lastEventId = (queryDbOne('SELECT COALESCE(MAX(id),0) as id FROM events') || {}).id || 0;

async function pushUpdates() {
    try {
        const newEvents = queryDb('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 20', [lastEventId]);
        if (newEvents.length > 0) {
            lastEventId = newEvents[newEvents.length - 1].id;
            broadcast('new_events', newEvents);
        }

        if (clients.size > 0) {
            const [metrics, disks, network] = await Promise.all([
                getLiveMetrics(),
                getDiskMetrics(),
                getNetworkLive().catch(() => null),
            ]);
            const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');

            // Quick PM2 summary (non-blocking)
            let pm2Summary = null;
            try {
                const jlist = await execShell('pm2 jlist 2>/dev/null');
                const apps = JSON.parse(jlist || '[]');
                pm2Summary = {
                    total: apps.length,
                    online: apps.filter(a => a.pm2_env && a.pm2_env.status === 'online').length,
                };
            } catch { /* ignore */ }

            broadcast('metrics_update', {
                ...metrics,
                disks,
                network_delta: network ? network.deltas : null,
                network_connections: network ? network.connections : null,
                pm2_summary: pm2Summary,
                riskScore: riskRow ? riskRow.score : 0,
                timestamp: Math.floor(Date.now() / 1000),
            });
        }
    } catch (err) {
        console.error('Push update error:', err.message);
    }
}

// ============================================================
// START
// ============================================================
server.listen(PORT, HOST, () => {
    console.log('NOC Dashboard - Linux Security Monitor v2.0');
    console.log(`Listening on http://${HOST}:${PORT}`);
    console.log(`Auth: ${config.WEB_AUTH_ENABLED === 'true' ? 'enabled' : 'disabled'}`);
});

setInterval(pushUpdates, 5000);
setInterval(loadConfig, 60000);
setInterval(() => {
    try { if (db) db.close(); } catch { /* ignore */ }
    initDb();
}, 300000);

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    try { if (db) db.close(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    try { if (db) db.close(); } catch { /* ignore */ }
    process.exit(0);
});

module.exports = { server };
