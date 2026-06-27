'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const crypto = require('crypto');

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
    // Sessions expire after 24h
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
// SYSTEM METRICS (live)
// ============================================================
function execShell(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            resolve(err ? '' : stdout.trim());
        });
    });
}

async function getLiveMetrics() {
    const [cpu, memInfo, loadAvg, uptime] = await Promise.all([
        execShell("top -bn1 | grep 'Cpu(s)' | sed \"s/.*, *\\([0-9.]*\\)%* id.*/\\1/\" | awk '{print 100 - $1}'"),
        execShell("free -m | awk 'NR==2{printf \"%s %s %s\", $2, $3, $4}'"),
        execShell("cat /proc/loadavg"),
        execShell("cat /proc/uptime | awk '{print int($1)}'"),
    ]);

    const [memTotal, memUsed, memFree] = (memInfo || '0 0 0').split(' ').map(Number);
    const memPct = memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(1) : 0;

    const loads = (loadAvg || '0 0 0').split(' ');

    return {
        cpu: parseFloat(cpu) || 0,
        memory: {
            total: memTotal,
            used: memUsed,
            free: memFree,
            percent: parseFloat(memPct),
        },
        load: {
            '1m': parseFloat(loads[0]) || 0,
            '5m': parseFloat(loads[1]) || 0,
            '15m': parseFloat(loads[2]) || 0,
        },
        uptime: parseInt(uptime) || 0,
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
// API HANDLERS
// ============================================================
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
            version: '1.0.0',
            hostname: require('os').hostname(),
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
        const total = queryDbOne('SELECT COUNT(*) as cnt FROM events' + (params.length > 2 ? '' : ''));
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
        const changes = queryDb(
            "SELECT * FROM integrity_changes ORDER BY timestamp DESC LIMIT 50"
        );
        const baseline = queryDbOne('SELECT COUNT(*) as cnt FROM integrity_baseline');
        send200(res, {
            changes,
            baselineCount: baseline ? baseline.cnt : 0,
        });
    },

    'GET /api/summary': async (req, res) => {
        const now = Math.floor(Date.now() / 1000);
        const day = now - 86400;
        const hour = now - 3600;

        const [metrics, disks] = await Promise.all([getLiveMetrics(), getDiskMetrics()]);
        const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');

        const stats = {
            events_1h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?', [hour]) || {}).cnt,
            events_24h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?', [day]) || {}).cnt,
            critical_24h: (queryDbOne('SELECT COUNT(*) as cnt FROM events WHERE severity=4 AND timestamp > ?', [day]) || {}).cnt,
            failed_logins_1h: (queryDbOne("SELECT COUNT(*) as cnt FROM events WHERE module='SSH' AND event_type='FAILED_LOGIN' AND timestamp > ?", [hour]) || {}).cnt,
            integrity_changes_24h: (queryDbOne("SELECT COUNT(*) as cnt FROM events WHERE module='INTEGRITY' AND timestamp > ?", [day]) || {}).cnt,
        };

        // Recent events
        const recentEvents = queryDb(
            'SELECT id, module, event_type, severity, title, timestamp FROM events ORDER BY timestamp DESC LIMIT 10'
        );

        // Module breakdown
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
                // Write to writable db instance for acknowledge
                const writeDb = new Database(DB_FILE);
                writeDb.prepare('UPDATE events SET acknowledged=1 WHERE id=?').run(id);
                writeDb.close();
                send200(res, { ok: true });
            } catch (err) {
                send500(res, err.message);
            }
        });
    },
};

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
    // Prevent path traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
        send403(res);
        return;
    }

    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            // SPA fallback
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
    // CORS preflight
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

    // API routes
    if (urlPath.startsWith('/api/')) {
        // Public endpoints
        const isPublic = urlPath === '/api/login';
        if (!isPublic && !isAuthenticated(req)) {
            send401(res, 'Authentication required');
            return;
        }

        const routeKey = `${req.method} ${urlPath}`;

        // Find route (support path params by matching prefix)
        const handler = apiRoutes[routeKey] ||
            Object.entries(apiRoutes).find(([k]) => urlPath.startsWith(k.split(' ')[1]))?.[1];

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

    // Static files (auth check for non-login)
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
    // Validate session for WS connections
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/lsm_session=([a-f0-9]+)/);
    if (config.WEB_AUTH_ENABLED === 'true' && (!match || !validateSession(match[1]))) {
        ws.close(4001, 'Unauthorized');
        return;
    }

    clients.add(ws);
    console.log(`WebSocket client connected (total: ${clients.size})`);

    ws.on('close', () => {
        clients.delete(ws);
    });

    ws.on('error', () => {
        clients.delete(ws);
    });

    // Send initial summary
    sendSummaryToClient(ws);
});

function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, timestamp: Date.now() });
    for (const client of clients) {
        if (client.readyState === 1) {
            client.send(msg);
        }
    }
}

async function sendSummaryToClient(ws) {
    try {
        const metrics = await getLiveMetrics();
        const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');
        ws.send(JSON.stringify({
            type: 'init',
            data: { metrics, riskScore: riskRow ? riskRow.score : 0 },
            timestamp: Date.now(),
        }));
    } catch { /* ignore */ }
}

// ============================================================
// REAL-TIME PUSH (poll db every 5s for new events)
// ============================================================
let lastEventId = (queryDbOne('SELECT COALESCE(MAX(id),0) as id FROM events') || {}).id || 0;

async function pushUpdates() {
    try {
        // New events
        const newEvents = queryDb('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 20', [lastEventId]);
        if (newEvents.length > 0) {
            lastEventId = newEvents[newEvents.length - 1].id;
            broadcast('new_events', newEvents);
        }

        // Live metrics
        if (clients.size > 0) {
            const metrics = await getLiveMetrics();
            const riskRow = queryDbOne('SELECT score FROM risk_scores ORDER BY timestamp DESC LIMIT 1');
            broadcast('metrics_update', {
                ...metrics,
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
    console.log(`Linux Security Monitor Web Dashboard`);
    console.log(`Listening on http://${HOST}:${PORT}`);
    console.log(`Auth: ${config.WEB_AUTH_ENABLED === 'true' ? 'enabled' : 'disabled'}`);
});

// Push updates every 5 seconds
setInterval(pushUpdates, 5000);

// Reload config every 60 seconds
setInterval(loadConfig, 60000);

// Re-init DB connection every 5 minutes (WAL mode can timeout)
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
