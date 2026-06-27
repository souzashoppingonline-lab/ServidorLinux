'use strict';

// ============================================================
// STATE
// ============================================================
let ws = null;
let wsRetryTimeout = null;
let wsRetryCount = 0;
let currentPage = 'dashboard';
let alertasPage = 0;
const PAGE_SIZE = 50;
let killPendingPid = null;
let processRefreshTimer = null;

// Chart instances (ECharts)
const charts = {};

// Rolling history for real-time charts (last 60 points)
const history = {
    timestamps: [],
    cpu: [],
    mem: [],
    net_tx: [],
    net_rx: [],
};
const MAX_HISTORY = 60;

// Sparkline history
const sparklines = { cpu: [] };

// ============================================================
// UTILITIES
// ============================================================
function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(ts) {
    return new Date(ts * 1000).toLocaleString('pt-BR');
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

function formatBps(bps) {
    if (bps < 1024) return bps.toFixed(0) + ' B/s';
    if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
    return (bps / (1024 * 1024)).toFixed(2) + ' Mbps';
}

function getRiskClass(score) {
    if (score >= 75) return 'risk-critical';
    if (score >= 50) return 'risk-high';
    if (score >= 25) return 'risk-medium';
    return 'risk-low';
}

function getRiskLabel(score) {
    if (score >= 75) return 'CRÍTICO';
    if (score >= 50) return 'ALTO';
    if (score >= 25) return 'MÉDIO';
    return 'BAIXO';
}

function getSevBadge(sev) {
    const labels = { 4: 'CRÍTICO', 3: 'ALTO', 2: 'MÉDIO', 1: 'BAIXO' };
    return `<span class="badge-sev sev-${sev}">${labels[sev] || sev}</span>`;
}

function getSevIcon(sev) {
    const icons = { 4: '🔴', 3: '🟠', 2: '🟡', 1: '🔵' };
    return icons[sev] || '⚪';
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function apiFetch(url, opts = {}) {
    try {
        const res = await fetch(url, opts);
        if (res.status === 401) { window.location.href = '/login.html'; return null; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error('API error:', url, err.message);
        return null;
    }
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    setWsStatus('connecting');

    ws.onopen = () => {
        wsRetryCount = 0;
        setWsStatus('connected');
    };

    ws.onmessage = (evt) => {
        try { handleWsMessage(JSON.parse(evt.data)); } catch { /* ignore */ }
    };

    ws.onclose = () => {
        setWsStatus('disconnected');
        scheduleWsReconnect();
    };

    ws.onerror = () => ws.close();
}

function setWsStatus(state) {
    const dot = document.getElementById('ws-dot');
    const text = document.getElementById('ws-text');
    if (!dot || !text) return;
    dot.className = `status-dot ${state}`;
    text.textContent = state === 'connected' ? 'Conectado' : state === 'connecting' ? 'Conectando...' : 'Desconectado';
}

function scheduleWsReconnect() {
    if (wsRetryTimeout) return;
    const delay = Math.min(1000 * Math.pow(2, wsRetryCount), 30000);
    wsRetryCount++;
    wsRetryTimeout = setTimeout(() => { wsRetryTimeout = null; connectWS(); }, delay);
}

function handleWsMessage(msg) {
    switch (msg.type) {
        case 'init':
        case 'metrics_update':
            updateMetricsDisplay(msg.data);
            break;
        case 'new_events':
            handleNewEvents(msg.data);
            break;
    }
}

function updateMetricsDisplay(data) {
    const ts = data.timestamp ? formatTime(data.timestamp) : new Date().toLocaleTimeString('pt-BR');

    // Update rolling history
    if (history.timestamps.length >= MAX_HISTORY) {
        history.timestamps.shift();
        history.cpu.shift();
        history.mem.shift();
        history.net_tx.shift();
        history.net_rx.shift();
    }
    history.timestamps.push(ts);
    history.cpu.push(data.cpu || 0);
    history.mem.push(data.memory ? data.memory.percent : 0);

    // Network delta
    let totalTx = 0, totalRx = 0;
    if (data.network_delta) {
        Object.values(data.network_delta).forEach(d => {
            totalTx += d.tx_bps || 0;
            totalRx += d.rx_bps || 0;
        });
    }
    history.net_tx.push(totalTx);
    history.net_rx.push(totalRx);

    // Update sparklines
    if (sparklines.cpu.length >= 20) sparklines.cpu.shift();
    sparklines.cpu.push(data.cpu || 0);
    drawSparkline('sparkline-cpu', sparklines.cpu, '#4f8ef7');

    // CPU card
    if (data.cpu !== undefined) {
        const cpu = data.cpu;
        setText('m-cpu', `${cpu.toFixed(1)}%`);
        setProgress('pb-cpu', cpu, 'blue');
    }

    // Memory card
    if (data.memory) {
        const mem = data.memory;
        setText('m-ram', `${mem.percent.toFixed(1)}%`);
        setText('m-ram-sub', `${mem.used.toLocaleString()} / ${mem.total.toLocaleString()} MB`);
        setProgress('pb-ram', mem.percent, 'green');
    }

    // Swap
    if (data.swap) {
        const sw = data.swap;
        setText('m-swap', `${sw.percent.toFixed(1)}%`);
        setText('m-swap-sub', `${sw.used.toLocaleString()} / ${sw.total.toLocaleString()} MB`);
        setProgress('pb-swap', sw.percent, 'purple');
    }

    // Load average
    if (data.load) {
        setText('m-load1', data.load['1m'].toFixed(2));
        setText('m-load-sub', `5m: ${data.load['5m'].toFixed(2)} | 15m: ${data.load['15m'].toFixed(2)}`);
    }

    // Uptime
    if (data.uptime) {
        const uStr = formatUptime(data.uptime);
        setText('m-uptime', uStr);
        setText('dash-uptime', uStr);
    }

    // Disk
    if (data.disks && data.disks.length > 0) {
        const root = data.disks.find(d => d.mount === '/') || data.disks[0];
        if (root) {
            setText('m-disk', `${root.percent}%`);
            setText('m-disk-sub', `${root.used} usado de ${root.size}`);
            setProgress('pb-disk', root.percent, root.percent >= 90 ? 'red' : root.percent >= 75 ? 'yellow' : 'green');
        }
    }

    // Network
    if (totalTx > 0 || totalRx > 0 || data.network_delta) {
        setText('m-net-up', formatBps(totalTx));
        setText('m-net-down', formatBps(totalRx));
    }

    // Network connections
    if (data.network_connections) {
        setText('m-conn-est', data.network_connections.established);
        setText('m-conn-tw', data.network_connections.time_wait);
        setText('m-conn-listen', data.network_connections.listening);
    }

    // Risk
    if (data.riskScore !== undefined) {
        updateRiskDisplay(data.riskScore);
    }

    // PM2 summary in topbar
    // (handled via services pull)

    // Last update label
    setText('last-update-label', ts);

    // Hostname
    if (data.hostname) {
        const el = document.getElementById('hostname-display');
        if (el && el.textContent === 'Carregando...') el.textContent = data.hostname;
    }

    // Update realtime charts
    updateRealtimeCharts();
}

function handleNewEvents(events) {
    if (!events || events.length === 0) return;
    const critical = events.filter(e => e.severity === 4);
    if (critical.length > 0) {
        critical.forEach(e => showToast(`${e.module}: ${e.title}`, 'critical'));
        const badge = document.getElementById('badge-alertas');
        if (badge) {
            const prev = parseInt(badge.textContent || '0');
            badge.textContent = prev + critical.length;
            badge.style.display = 'inline';
        }
        const badge2 = document.getElementById('badge-seguranca');
        if (badge2) {
            const prev = parseInt(badge2.textContent || '0');
            badge2.textContent = prev + critical.length;
            badge2.style.display = 'inline';
        }
    }
    if (currentPage === 'dashboard') {
        refreshDashRecentEvents();
    }
    if (currentPage === 'alertas') {
        loadAlertas();
    }
}

// ============================================================
// RISK DISPLAY
// ============================================================
function updateRiskDisplay(score) {
    const pill = document.getElementById('risk-pill');
    if (pill) {
        pill.className = `risk-pill ${getRiskClass(score)}`;
        pill.textContent = `RISK: ${score}/100`;
    }
    setText('m-risk-score', score);
    setText('m-risk-level', getRiskLabel(score));
    setText('sec-risk', score);
}

// ============================================================
// SPARKLINE (canvas)
// ============================================================
function drawSparkline(canvasId, data, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (data.length < 2) return;

    const max = Math.max(...data, 1);
    const step = W / (data.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    data.forEach((v, i) => {
        const x = i * step;
        const y = H - (v / max) * H;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill
    ctx.lineTo((data.length - 1) * step, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = color + '22';
    ctx.fill();
}

// ============================================================
// ECHARTS — REALTIME CHARTS
// ============================================================
function getLineOpts(title, series, colors) {
    return {
        backgroundColor: 'transparent',
        grid: { top: 10, right: 12, bottom: 30, left: 48 },
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(13,17,32,0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            textStyle: { color: '#e2e8f0', fontSize: 11 },
        },
        xAxis: {
            type: 'category',
            data: history.timestamps,
            boundaryGap: false,
            axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
            axisLabel: { color: '#475569', fontSize: 9, showMaxLabel: true, showMinLabel: false,
                formatter: (v, i) => i % Math.max(1, Math.floor(history.timestamps.length / 6)) === 0 ? v : '' },
            splitLine: { show: false },
            axisTick: { show: false },
        },
        yAxis: {
            type: 'value',
            min: 0,
            axisLine: { show: false },
            axisLabel: { color: '#475569', fontSize: 9 },
            splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
        },
        series: series.map((s, i) => ({
            name: s.name,
            type: 'line',
            data: s.data,
            smooth: true,
            symbol: 'none',
            lineStyle: { color: colors[i], width: 2 },
            areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [{ offset: 0, color: colors[i] + '44' }, { offset: 1, color: colors[i] + '05' }] } },
        })),
    };
}

function initOrUpdateChart(id, getOpts) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!charts[id]) {
        const c = echarts.init(el, null, { renderer: 'canvas', width: el.parentElement.offsetWidth || 400, height: 200 });
        charts[id] = c;
        window.addEventListener('resize', () => c.resize());
    }
    charts[id].setOption(getOpts(), { notMerge: false, lazyUpdate: true });
}

function updateRealtimeCharts() {
    initOrUpdateChart('chart-cpu-rt', () => getLineOpts('CPU', [{ name: 'CPU%', data: history.cpu }], ['#4f8ef7']));
    initOrUpdateChart('chart-mem-rt', () => getLineOpts('Mem', [{ name: 'Mem%', data: history.mem }], ['#00d4a1']));

    // Network chart (bps)
    initOrUpdateChart('chart-net-rt', () => ({
        backgroundColor: 'transparent',
        grid: { top: 10, right: 12, bottom: 30, left: 80 },
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(13,17,32,0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            textStyle: { color: '#e2e8f0', fontSize: 11 },
            formatter: (params) => {
                return params.map(p => `${p.seriesName}: ${formatBps(p.value)}`).join('<br/>');
            },
        },
        legend: { data: ['TX (Upload)', 'RX (Download)'], textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0 },
        xAxis: {
            type: 'category',
            data: history.timestamps,
            boundaryGap: false,
            axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
            axisLabel: { color: '#475569', fontSize: 9 },
            splitLine: { show: false },
            axisTick: { show: false },
        },
        yAxis: {
            type: 'value',
            axisLabel: { color: '#475569', fontSize: 9, formatter: v => formatBps(v) },
            splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
        },
        series: [
            { name: 'TX (Upload)', type: 'line', data: history.net_tx, smooth: true, symbol: 'none',
              lineStyle: { color: '#4f8ef7', width: 2 },
              areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#4f8ef744' }, { offset: 1, color: '#4f8ef705' }] } } },
            { name: 'RX (Download)', type: 'line', data: history.net_rx, smooth: true, symbol: 'none',
              lineStyle: { color: '#00d4a1', width: 2 },
              areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#00d4a144' }, { offset: 1, color: '#00d4a105' }] } } },
        ],
    }));
}

// ============================================================
// HELPER: setText / setProgress
// ============================================================
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function setProgress(id, pct, colorClass) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.width = `${Math.min(100, pct)}%`;
    if (colorClass) el.className = `progress-fill ${colorClass}`;
}

// ============================================================
// PAGE NAVIGATION
// ============================================================
function switchPage(page) {
    document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    const pageEl = document.getElementById(`page-${page}`);
    if (pageEl) pageEl.classList.add('active');

    const navEl = document.querySelector(`[data-page="${page}"]`);
    if (navEl) navEl.classList.add('active');

    currentPage = page;

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
    }

    // Clear badge when viewing that page
    if (page === 'alertas') {
        const b = document.getElementById('badge-alertas');
        if (b) { b.style.display = 'none'; b.textContent = '0'; }
    }

    // Stop process refresh timer when leaving processos
    if (page !== 'processos' && processRefreshTimer) {
        clearInterval(processRefreshTimer);
        processRefreshTimer = null;
    }

    // Load page data
    switch (page) {
        case 'dashboard':  loadDashboard(); break;
        case 'seguranca':  loadSeguranca(); break;
        case 'alertas':    loadAlertas(); break;
        case 'pm2':        loadPm2(); break;
        case 'docker':     loadDocker(); break;
        case 'rede':       loadRede(); break;
        case 'servicos':   loadServicos(); break;
        case 'processos':  loadProcessos(); break;
        case 'disco':      loadDisco(); break;
        case 'ssl':        loadSsl(); break;
        case 'telegram':   loadTelegramConfig(); break;
    }
}

document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', (e) => {
        e.preventDefault();
        switchPage(el.dataset.page);
    });
});

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
    const data = await apiFetch('/api/system/full');
    if (!data) return;

    if (data.metrics) updateMetricsDisplay({ ...data.metrics, disks: data.disks, timestamp: data.timestamp, riskScore: data.riskScore });
    if (data.riskScore !== undefined) updateRiskDisplay(data.riskScore);

    // Security stats
    if (data.stats) {
        setText('m-events-1h', data.stats.events_1h);
        setText('m-events-24h', `24h: ${data.stats.events_24h}`);
        setText('m-ssh-fail', data.stats.failed_logins_24h);
        setText('m-critical', data.stats.critical_24h);
    }

    // Services
    if (data.services) {
        renderServicesPills('dash-services-grid', data.services);
    }

    // Recent events
    renderRecentEvents(data.recentEvents || []);

    // Hostname
    if (data.metrics && data.metrics.hostname) {
        document.getElementById('hostname-display').textContent = data.metrics.hostname;
    }

    // Update network data if present
    if (data.network) {
        renderNetworkConnections(data.network.connections);
    }
}

async function refreshDashRecentEvents() {
    const data = await apiFetch('/api/events?limit=10');
    if (data) renderRecentEvents(data.events || []);
}

function renderRecentEvents(events) {
    const tbody = document.getElementById('dash-events-body');
    if (!tbody) return;
    if (!events.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-row">Nenhum evento recente</td></tr>';
        return;
    }
    tbody.innerHTML = events.map(e => `
        <tr class="clickable" onclick="showEventModal(${JSON.stringify(e).replace(/"/g, '&quot;')})">
            <td>${getSevBadge(e.severity)}</td>
            <td><span class="module-chip">${e.module}</span></td>
            <td class="truncate" title="${escapeHtml(e.title)}" style="max-width:260px">${escapeHtml(e.title)}</td>
            <td>${e.source_ip || '-'}</td>
            <td>${formatTime(e.timestamp)}</td>
        </tr>
    `).join('');
}

// ============================================================
// SEGURANÇA
// ============================================================
async function loadSeguranca() {
    const [summaryData, integrityData, riskData] = await Promise.all([
        apiFetch('/api/summary'),
        apiFetch('/api/integrity'),
        apiFetch('/api/risk'),
    ]);

    if (summaryData && summaryData.stats) {
        setText('sec-critical', summaryData.stats.critical_24h);
        setText('sec-ssh-fail', summaryData.stats.failed_logins_24h || summaryData.stats.failed_logins_1h * 24);
        setText('sec-integrity', summaryData.stats.integrity_changes_24h);
        // high severity
        const highData = await apiFetch('/api/events?severity=3&limit=1');
    }

    // Top attacking IPs
    const sshEvents = await apiFetch("/api/events?module=SSH&limit=200");
    if (sshEvents && sshEvents.events) {
        const ipCounts = {};
        sshEvents.events.filter(e => e.event_type === 'FAILED_LOGIN' || e.event_type === 'BRUTE_FORCE').forEach(e => {
            if (e.source_ip) ipCounts[e.source_ip] = (ipCounts[e.source_ip] || 0) + 1;
        });
        const top = Object.entries(ipCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const tbody = document.getElementById('sec-top-ips');
        if (tbody) {
            tbody.innerHTML = top.length ? top.map(([ip, cnt], i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td class="text-mono">${ip}</td>
                    <td><strong>${cnt}</strong></td>
                    <td><span class="module-chip">SSH</span></td>
                </tr>
            `).join('') : '<tr><td colspan="4" class="empty-row">Nenhum dado</td></tr>';
        }

        // SSH failed per hour chart
        const hourBuckets = {};
        const now = Math.floor(Date.now() / 1000);
        for (let h = 23; h >= 0; h--) {
            hourBuckets[23 - h] = { label: `${h}h`, count: 0 };
        }
        sshEvents.events.forEach(e => {
            if (e.event_type !== 'FAILED_LOGIN' && e.event_type !== 'BRUTE_FORCE') return;
            const hoursAgo = Math.floor((now - e.timestamp) / 3600);
            if (hoursAgo >= 0 && hoursAgo < 24) {
                hourBuckets[23 - hoursAgo].count++;
            }
        });
        const bucketArr = Object.values(hourBuckets);

        initOrUpdateChart('chart-ssh-hourly', () => ({
            backgroundColor: 'transparent',
            grid: { top: 10, right: 12, bottom: 40, left: 40 },
            tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,17,32,0.95)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#e2e8f0', fontSize: 11 } },
            xAxis: { type: 'category', data: bucketArr.map(b => b.label), axisLabel: { color: '#475569', fontSize: 9 }, axisTick: { show: false }, axisLine: { show: false }, splitLine: { show: false } },
            yAxis: { type: 'value', axisLabel: { color: '#475569', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } } },
            series: [{ type: 'bar', data: bucketArr.map(b => b.count), itemStyle: { color: '#ff4757', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 20 }],
        }));
    }

    // Risk score history chart
    if (riskData && riskData.history) {
        initOrUpdateChart('chart-risk-history', () => getLineOpts('Risk', [{ name: 'Risk Score', data: riskData.history.map(r => r.score) }], ['#ff4757']));
    }

    // Integrity changes
    if (integrityData && integrityData.changes) {
        const tbody = document.getElementById('sec-integrity-body');
        if (tbody) {
            tbody.innerHTML = integrityData.changes.length ? integrityData.changes.map(c => `
                <tr>
                    <td class="truncate text-mono" title="${escapeHtml(c.filepath)}" style="max-width:200px">${escapeHtml(c.filepath)}</td>
                    <td>${c.change_type || '-'}</td>
                    <td class="text-mono text-muted" style="font-size:0.7rem">${c.old_hash ? c.old_hash.substring(0, 12) + '…' : '-'}</td>
                    <td class="text-mono text-muted" style="font-size:0.7rem">${c.new_hash ? c.new_hash.substring(0, 12) + '…' : '-'}</td>
                    <td>${formatDateTime(c.timestamp)}</td>
                </tr>
            `).join('') : '<tr><td colspan="5" class="empty-row">Nenhuma mudança ✓</td></tr>';
        }
    }

    // Open ports
    const netData = await apiFetch('/api/network/live');
    if (netData) {
        const tbody = document.getElementById('sec-ports-body');
        if (tbody && netData.ss_summary) {
            // Try to show listening from ss
            const ssLines = netData.ss_summary.split('\n').filter(l => l.trim());
            tbody.innerHTML = ssLines.map(line => `<tr><td colspan="4" class="text-mono" style="font-size:0.72rem">${escapeHtml(line)}</td></tr>`).join('') ||
                '<tr><td colspan="4" class="empty-row">Sem dados</td></tr>';
        }
    }
}

// ============================================================
// ALERTAS
// ============================================================
async function loadAlertas() {
    const severity = document.getElementById('filter-severity')?.value || '';
    const module = document.getElementById('filter-module')?.value || '';
    const offset = alertasPage * PAGE_SIZE;

    let url = `/api/events?limit=${PAGE_SIZE}&offset=${offset}`;
    if (severity) url += `&severity=${severity}`;
    if (module) url += `&module=${module}`;

    const data = await apiFetch(url);
    if (!data) return;

    const container = document.getElementById('alertas-timeline');
    if (!container) return;

    if (!data.events || data.events.length === 0) {
        container.innerHTML = '<div class="timeline-item"><div class="timeline-content"><div class="timeline-title" style="text-align:center;color:var(--text-muted)">Nenhum evento encontrado</div></div></div>';
    } else {
        container.innerHTML = data.events.map(e => `
            <div class="timeline-item" onclick="showEventModal(${JSON.stringify(e).replace(/"/g, '&quot;')})">
                <div class="timeline-icon sev-${e.severity}">${getSevIcon(e.severity)}</div>
                <div class="timeline-content">
                    <div class="timeline-title">${escapeHtml(e.title)}</div>
                    <div class="timeline-meta">
                        ${getSevBadge(e.severity)}
                        <span class="module-chip">${e.module}</span>
                        ${e.source_ip ? `<span class="text-muted text-mono">${e.source_ip}</span>` : ''}
                        <span>${e.event_type || ''}</span>
                    </div>
                </div>
                <div class="timeline-time">${formatDateTime(e.timestamp)}</div>
            </div>
        `).join('');
    }

    const totalPages = Math.ceil((data.total || 0) / PAGE_SIZE);
    setText('alertas-page-info', `Página ${alertasPage + 1} de ${Math.max(1, totalPages)}`);
    const prevBtn = document.getElementById('alertas-prev');
    const nextBtn = document.getElementById('alertas-next');
    if (prevBtn) prevBtn.disabled = alertasPage === 0;
    if (nextBtn) nextBtn.disabled = alertasPage >= totalPages - 1;
}

function alertasChangePage(delta) {
    alertasPage = Math.max(0, alertasPage + delta);
    loadAlertas();
}

// ============================================================
// PM2
// ============================================================
async function loadPm2() {
    const data = await apiFetch('/api/pm2');
    if (!data) return;

    setText('pm2-version', data.pm2_version || 'N/A');
    setText('pm2-node-ver', data.node_version || 'N/A');
    setText('pm2-total', data.total || 0);
    setText('pm2-online', data.online || 0);
    setText('pm2-offline', data.offline || 0);

    const tbody = document.getElementById('pm2-table-body');
    if (!tbody) return;

    if (!data.apps || data.apps.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Nenhum processo PM2 encontrado</td></tr>';
        return;
    }

    tbody.innerHTML = data.apps.map(app => {
        const env = app.pm2_env || {};
        const status = env.status || 'unknown';
        const cpu = app.monit ? (app.monit.cpu || 0) : 0;
        const ram = app.monit ? formatBytes(app.monit.memory || 0) : '-';
        const uptime = env.pm_uptime ? formatUptime(Math.floor((Date.now() - env.pm_uptime) / 1000)) : '-';
        const restarts = env.restart_time || 0;
        const id = app.pm_id !== undefined ? app.pm_id : app.name;

        return `
            <tr>
                <td><strong>${escapeHtml(app.name || '-')}</strong></td>
                <td>${app.pm_id !== undefined ? app.pm_id : '-'}</td>
                <td><span class="badge-status ${status}">${status}</span></td>
                <td>${cpu}%</td>
                <td>${ram}</td>
                <td>${uptime}</td>
                <td>${restarts}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn btn-success btn-sm" onclick="pm2Action('${id}','restart')">↺</button>
                        <button class="btn btn-warning btn-sm" onclick="pm2Action('${id}','stop')">⏹</button>
                        <button class="btn btn-primary btn-sm" onclick="pm2Action('${id}','start')">▶</button>
                        <button class="btn btn-ghost btn-sm" onclick="loadPm2Logs('${id}','${escapeHtml(app.name || String(id))}')">📋</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function pm2Action(id, action) {
    showToast(`PM2: ${action} → ${id}…`, 'info');
    const data = await apiFetch(`/api/pm2/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
    });
    if (data && data.ok) {
        showToast(`PM2 ${action} executado com sucesso`, 'success');
        setTimeout(() => loadPm2(), 1500);
    } else {
        showToast(`Erro ao executar PM2 ${action}`, 'critical');
    }
}

async function loadPm2Logs(id, name) {
    const logArea = document.getElementById('pm2-log-area');
    const logContent = document.getElementById('pm2-log-content');
    const logTitle = document.getElementById('pm2-log-title');

    if (logArea) logArea.style.display = 'block';
    if (logTitle) logTitle.textContent = `📋 Logs — ${name}`;
    if (logContent) logContent.textContent = 'Carregando logs...';

    // Scroll to log area
    logArea?.scrollIntoView({ behavior: 'smooth' });

    const data = await apiFetch(`/api/pm2/${id}/logs`);
    if (data && data.logs) {
        if (logContent) {
            logContent.textContent = data.logs || 'Sem logs disponíveis';
            // Auto-scroll to bottom
            const panel = document.getElementById('pm2-log-panel');
            if (panel) panel.scrollTop = panel.scrollHeight;
        }
    } else {
        if (logContent) logContent.textContent = 'Erro ao carregar logs';
    }
}

// ============================================================
// DOCKER
// ============================================================
async function loadDocker() {
    const data = await apiFetch('/api/docker');

    const unavailEl = document.getElementById('docker-unavailable');
    const contentEl = document.getElementById('docker-content');
    const tbody = document.getElementById('docker-table-body');
    const countEl = document.getElementById('docker-count');

    if (!data || !data.available || !data.containers || data.containers.length === 0) {
        if (unavailEl) unavailEl.style.display = 'block';
        if (contentEl) contentEl.style.display = 'none';
        return;
    }

    if (unavailEl) unavailEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';
    if (countEl) countEl.textContent = `${data.containers.length} container(s)`;

    if (!tbody) return;
    tbody.innerHTML = data.containers.map(c => {
        const name = (c.Names || c.Name || '-').replace(/^\//, '');
        const image = c.Image || '-';
        const status = c.Status || c.State || 'unknown';
        const statusClass = status.startsWith('Up') ? 'online' : 'offline';
        const cpu = c.stats ? (c.stats.CPUPerc || c.stats.CPU || '-') : '-';
        const mem = c.stats ? (c.stats.MemUsage || c.stats.MemPerc || '-') : '-';
        const ports = c.Ports || '-';

        return `
            <tr>
                <td><strong>${escapeHtml(name)}</strong></td>
                <td class="truncate text-muted" title="${escapeHtml(image)}" style="max-width:200px">${escapeHtml(image)}</td>
                <td><span class="badge-status ${statusClass}">${escapeHtml(String(status).substring(0, 20))}</span></td>
                <td>${escapeHtml(String(cpu))}</td>
                <td>${escapeHtml(String(mem))}</td>
                <td class="truncate text-mono text-muted" style="max-width:150px;font-size:0.7rem">${escapeHtml(String(ports))}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn btn-success btn-sm" onclick="dockerAction('${escapeHtml(name)}','restart')">↺</button>
                        <button class="btn btn-danger btn-sm" onclick="dockerAction('${escapeHtml(name)}','stop')">⏹</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function dockerAction(name, action) {
    showToast(`Docker: ${action} → ${name}…`, 'info');
    // Docker actions would need a backend endpoint; show info for now
    showToast(`Docker ${action} iniciado para ${name}`, 'info');
}

// ============================================================
// REDE (NETWORK)
// ============================================================
async function loadRede() {
    const data = await apiFetch('/api/network/live');
    if (!data) return;

    // Connections
    renderNetworkConnections(data.connections);

    // Top IPs
    const topIpsBody = document.getElementById('rede-top-ips');
    if (topIpsBody && data.top_ips) {
        topIpsBody.innerHTML = data.top_ips.map(item => `
            <tr>
                <td><strong>${item.count}</strong></td>
                <td class="text-mono">${escapeHtml(item.ip)}</td>
            </tr>
        `).join('') || '<tr><td colspan="2" class="empty-row">Nenhuma conexão</td></tr>';
    }

    // Interfaces
    const ifaceBody = document.getElementById('rede-interfaces-body');
    if (ifaceBody && data.interfaces) {
        ifaceBody.innerHTML = Object.entries(data.interfaces).map(([name, stats]) => `
            <tr>
                <td><strong>${escapeHtml(name)}</strong></td>
                <td>${formatBytes(stats.rx_bytes)}</td>
                <td>${stats.rx_packets.toLocaleString()}</td>
                <td>${formatBytes(stats.tx_bytes)}</td>
                <td>${stats.tx_packets.toLocaleString()}</td>
            </tr>
        `).join('') || '<tr><td colspan="5" class="empty-row">Sem interfaces</td></tr>';
    }

    // Bandwidth chart per interface using deltas
    if (data.deltas && Object.keys(data.deltas).length > 0) {
        const ifaces = Object.keys(data.deltas);
        initOrUpdateChart('chart-iface-bw', () => ({
            backgroundColor: 'transparent',
            grid: { top: 10, right: 12, bottom: 30, left: 80 },
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(13,17,32,0.95)',
                borderColor: 'rgba(255,255,255,0.1)',
                textStyle: { color: '#e2e8f0', fontSize: 11 },
                formatter: (params) => params.map(p => `${p.seriesName}: ${formatBps(p.value)}`).join('<br/>'),
            },
            legend: { textStyle: { color: '#94a3b8', fontSize: 10 } },
            xAxis: { type: 'category', data: ifaces, axisLabel: { color: '#94a3b8', fontSize: 10 }, axisTick: { show: false }, axisLine: { show: false } },
            yAxis: { type: 'value', axisLabel: { color: '#475569', fontSize: 9, formatter: v => formatBps(v) }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } } },
            series: [
                { name: 'RX (Download)', type: 'bar', data: ifaces.map(i => data.deltas[i]?.rx_bps || 0), itemStyle: { color: '#00d4a1', borderRadius: [3,3,0,0] } },
                { name: 'TX (Upload)', type: 'bar', data: ifaces.map(i => data.deltas[i]?.tx_bps || 0), itemStyle: { color: '#4f8ef7', borderRadius: [3,3,0,0] } },
            ],
        }));
    }
}

function renderNetworkConnections(conn) {
    if (!conn) return;
    setText('r-established', conn.established);
    setText('r-timewait', conn.time_wait);
    setText('r-listen', conn.listening);
    // Also update dashboard cards
    setText('m-conn-est', conn.established);
    setText('m-conn-tw', conn.time_wait);
    setText('m-conn-listen', conn.listening);
}

// ============================================================
// SERVIÇOS
// ============================================================
async function loadServicos() {
    const data = await apiFetch('/api/services');
    if (!data || !data.services) return;

    renderServicesPills('services-full-grid', data.services);

    const tbody = document.getElementById('services-detail-body');
    if (tbody) {
        tbody.innerHTML = data.services.map(s => `
            <tr>
                <td>
                    <div style="display:flex;align-items:center;gap:0.5rem">
                        <div class="service-status-dot ${s.active ? 'active' : 'inactive'}"></div>
                        <strong>${escapeHtml(s.name)}</strong>
                    </div>
                </td>
                <td><span class="badge-status ${s.active ? 'online' : 'offline'}">${s.status}</span></td>
                <td class="text-muted" style="font-size:0.72rem">${escapeHtml(s.since || '-')}</td>
            </tr>
        `).join('');
    }
}

function renderServicesPills(containerId, services) {
    const container = document.getElementById(containerId);
    if (!container || !services) return;

    const icons = {
        ssh: '🔑', nginx: '🌐', 'pm2-root': '⚙️', docker: '🐳',
        postgresql: '🐘', redis: '🟥', mysql: '🐬', fail2ban: '🛡️',
    };

    container.innerHTML = services.map(s => `
        <div class="service-pill ${s.active ? 'active' : 'inactive'}">
            <div class="service-status-dot ${s.active ? 'active' : 'inactive'}"></div>
            <span style="font-size:1rem">${icons[s.name] || '🔧'}</span>
            <span class="service-name">${s.name}</span>
            <span class="service-status-text ${s.active ? 'active' : 'inactive'}">${s.active ? 'ON' : 'OFF'}</span>
        </div>
    `).join('');
}

// ============================================================
// PROCESSOS
// ============================================================
async function loadProcessos() {
    const data = await apiFetch('/api/processes');
    if (!data || !data.processes) return;

    const tbody = document.getElementById('proc-table-body');
    if (!tbody) return;

    const procs = data.processes;
    if (!procs.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Nenhum processo</td></tr>';
        return;
    }

    tbody.innerHTML = procs.map(p => {
        const cpuColor = p.cpu >= 50 ? 'text-red' : p.cpu >= 20 ? 'text-orange' : '';
        return `
            <tr>
                <td class="text-mono">${p.pid}</td>
                <td>${escapeHtml(p.user)}</td>
                <td class="${cpuColor}"><strong>${p.cpu.toFixed(1)}</strong></td>
                <td>${p.mem.toFixed(1)}</td>
                <td class="text-muted">${p.stat || '-'}</td>
                <td class="text-muted">${p.time || '-'}</td>
                <td class="truncate text-mono" title="${escapeHtml(p.command)}" style="max-width:300px;font-size:0.7rem">${escapeHtml(p.command)}</td>
                <td>
                    <button class="btn btn-danger btn-sm" onclick="requestKill(${p.pid})">Kill</button>
                </td>
            </tr>
        `;
    }).join('');

    setText('proc-last-update', `Atualizado: ${new Date().toLocaleTimeString('pt-BR')}`);

    // Auto-refresh every 5s while on page
    if (processRefreshTimer) clearInterval(processRefreshTimer);
    processRefreshTimer = setInterval(() => {
        if (currentPage === 'processos') loadProcessos();
    }, 5000);
}

function requestKill(pid) {
    killPendingPid = pid;
    setText('kill-pid-display', `PID ${pid}`);
    document.getElementById('kill-overlay').classList.add('open');
}

function cancelKill() {
    killPendingPid = null;
    document.getElementById('kill-overlay').classList.remove('open');
}

async function confirmKill() {
    if (!killPendingPid) return;
    const pid = killPendingPid;
    cancelKill();

    const data = await apiFetch('/api/process/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid }),
    });

    if (data && data.ok) {
        showToast(`Processo ${pid} encerrado`, 'success');
        setTimeout(() => loadProcessos(), 1000);
    } else {
        showToast(`Erro ao encerrar PID ${pid}`, 'critical');
    }
}

// ============================================================
// DISCO
// ============================================================
async function loadDisco() {
    const [liveData, ioData] = await Promise.all([
        apiFetch('/api/metrics/live'),
        apiFetch('/api/disk/io'),
    ]);

    if (liveData && liveData.disks) {
        const tbody = document.getElementById('disco-partitions-body');
        if (tbody) {
            tbody.innerHTML = liveData.disks.map(d => {
                const barClass = d.percent >= 90 ? 'high' : d.percent >= 75 ? 'medium' : 'low';
                return `
                    <tr>
                        <td class="text-mono">${escapeHtml(d.device)}</td>
                        <td>${escapeHtml(d.mount)}</td>
                        <td>${d.size}</td>
                        <td>${d.used}</td>
                        <td>${d.avail}</td>
                        <td style="min-width:140px">
                            ${d.percent}%
                            <div class="disk-bar"><div class="disk-bar-fill ${barClass}" style="width:${d.percent}%"></div></div>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }

    if (ioData && ioData.iostat) {
        const el = document.getElementById('disco-iostat');
        if (el) el.textContent = ioData.iostat.substring(0, 3000);
    }
}

// ============================================================
// SSL
// ============================================================
async function loadSsl() {
    const [sslData, nginxData] = await Promise.all([
        apiFetch('/api/ssl'),
        apiFetch('/api/nginx/stats'),
    ]);

    const grid = document.getElementById('ssl-grid');
    if (grid && sslData && sslData.certificates) {
        const certs = sslData.certificates;
        if (!certs.length) {
            grid.innerHTML = '<div class="ssl-card ssl-unknown" style="text-align:center;padding:2rem;color:var(--text-muted)">Nenhum domínio encontrado em /etc/nginx/sites-enabled/</div>';
        } else {
            grid.innerHTML = certs.map(c => {
                const daysClass = c.days_left === null ? 'unknown' : c.status;
                const daysDisplay = c.days_left !== null ? c.days_left : '?';
                return `
                    <div class="ssl-card ssl-${c.status || 'unknown'}">
                        <div class="ssl-domain" title="${escapeHtml(c.domain)}">${escapeHtml(c.domain)}</div>
                        <div class="ssl-days ${daysClass}">${daysDisplay}</div>
                        <div style="font-size:0.7rem;color:var(--text-muted)">dias restantes</div>
                        <div class="ssl-expiry" style="margin-top:0.5rem">
                            Expira: ${c.not_after || 'N/A'}<br>
                            Status: <span style="color:${c.status === 'ok' ? 'var(--accent-green)' : c.status === 'expired' ? 'var(--accent-red)' : 'var(--accent-orange)'}">
                                ${(c.status || 'unknown').toUpperCase()}
                            </span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // Nginx stats
    if (nginxData) {
        setText('nginx-total-reqs', nginxData.total_lines || 0);
        setText('nginx-avg-time', nginxData.avg_response_time || 'N/A');

        const codesEl = document.getElementById('nginx-status-codes');
        if (codesEl && nginxData.status_codes) {
            const colorMap = { '2': 'var(--accent-green)', '3': 'var(--accent-blue)', '4': 'var(--accent-orange)', '5': 'var(--accent-red)' };
            codesEl.innerHTML = Object.entries(nginxData.status_codes).sort().map(([code, cnt]) => {
                const color = colorMap[code[0]] || 'var(--text-secondary)';
                return `<div style="background:rgba(255,255,255,0.04);border:1px solid var(--glass-border);border-radius:6px;padding:0.5rem 0.75rem;text-align:center">
                    <div style="font-size:0.7rem;color:var(--text-muted)">${code}</div>
                    <div style="font-size:1.1rem;font-weight:700;color:${color}">${cnt}</div>
                </div>`;
            }).join('');
        }

        const ipsBody = document.getElementById('nginx-top-ips-body');
        if (ipsBody && nginxData.top_ips) {
            ipsBody.innerHTML = nginxData.top_ips.map(item => `
                <tr>
                    <td class="text-mono">${escapeHtml(item.ip)}</td>
                    <td><strong>${item.count}</strong></td>
                </tr>
            `).join('') || '<tr><td colspan="2" class="empty-row">Sem dados</td></tr>';
        }
    }
}

// ============================================================
// MODAL
// ============================================================
function showEventModal(event) {
    document.getElementById('modal-title').textContent = event.title;
    document.getElementById('modal-body').innerHTML = `
        <div class="modal-field">
            <label>ID / Severidade</label>
            <div style="display:flex;align-items:center;gap:0.5rem">#${event.id} ${getSevBadge(event.severity)}</div>
        </div>
        <div class="modal-field">
            <label>Módulo / Tipo</label>
            <div><span class="module-chip">${event.module}</span> ${event.event_type || ''}</div>
        </div>
        <div class="modal-field">
            <label>Hora</label>
            <div>${formatDateTime(event.timestamp)}</div>
        </div>
        ${event.source_ip ? `<div class="modal-field"><label>IP Origem</label><div class="text-mono">${event.source_ip}</div></div>` : ''}
        ${event.username ? `<div class="modal-field"><label>Usuário</label><div>${event.username}</div></div>` : ''}
        <div class="modal-field">
            <label>Risk Score</label>
            <div>${event.risk_score || 0}</div>
        </div>
        ${event.description ? `<div class="modal-field"><label>Descrição</label><div class="log-viewer">${escapeHtml(event.description)}</div></div>` : ''}
    `;
    document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { critical: '🔴', warning: '🟡', success: '🟢', info: '🔵' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${icons[type] || '⚪'}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

// ============================================================
// AUTH
// ============================================================
async function doLogout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
}

// ============================================================
// CLOCK
// ============================================================
function updateClock() {
    const el = document.getElementById('current-time');
    if (el) el.textContent = new Date().toLocaleString('pt-BR');
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    connectWS();
    loadDashboard();

    // Periodic dashboard refresh
    setInterval(() => {
        if (currentPage === 'dashboard') loadDashboard();
    }, 30000);

    // ECharts resize on sidebar toggle
    document.getElementById('sidebar')?.addEventListener('transitionend', () => {
        Object.values(charts).forEach(c => { try { c.resize(); } catch {} });
    });
});

// ============================================================
// TELEGRAM PAGE
// ============================================================
async function loadTelegramConfig() {
    try {
        const data = await apiFetch('/api/telegram/config');

        // Status badge
        const badge = document.getElementById('tg-status-badge');
        if (data.enabled && data.has_token && data.has_chat_id) {
            badge.style.background = 'rgba(0,212,161,0.15)';
            badge.style.color = '#00d4a1';
            badge.innerHTML = '<span>●</span> Ativo';
            document.getElementById('badge-telegram').style.display = 'none';
        } else {
            badge.style.background = 'rgba(255,71,87,0.15)';
            badge.style.color = '#ff4757';
            badge.innerHTML = '<span>●</span> Desativado';
            if (!data.has_token || !data.has_chat_id) {
                document.getElementById('badge-telegram').style.display = 'flex';
            }
        }

        // Bot info
        document.getElementById('tg-bot-name').textContent = data.has_token ? data.bot_token : '—';
        document.getElementById('tg-chat-display').textContent = data.chat_id || '—';

        // Form fields
        document.getElementById('tg-enabled').checked = data.enabled;
        document.getElementById('tg-daily-report').checked = data.daily_report;
        document.getElementById('tg-chat-id').value = data.chat_id || '';

        const cpuThresh = data.alert_cpu || 90;
        const memThresh = data.alert_mem || 90;
        const diskThresh = data.alert_disk || 90;
        document.getElementById('tg-cpu-threshold').value = cpuThresh;
        document.getElementById('tg-mem-threshold').value = memThresh;
        document.getElementById('tg-disk-threshold').value = diskThresh;
        document.getElementById('tg-cpu-val').textContent = cpuThresh;
        document.getElementById('tg-mem-val').textContent = memThresh;
        document.getElementById('tg-disk-val').textContent = diskThresh;

        // Don't pre-fill token for security (shows masked)
        document.getElementById('tg-token').placeholder = data.has_token
            ? `Token atual: ${data.bot_token} (deixe em branco para manter)`
            : '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

    } catch (e) {
        showToast('Erro ao carregar configuração Telegram', 'error');
    }
}

async function saveTelegramConfig() {
    const token = document.getElementById('tg-token').value.trim();
    const chatId = document.getElementById('tg-chat-id').value.trim();
    const enabled = document.getElementById('tg-enabled').checked;
    const dailyReport = document.getElementById('tg-daily-report').checked;
    const cpuThresh = document.getElementById('tg-cpu-threshold').value;
    const memThresh = document.getElementById('tg-mem-threshold').value;
    const diskThresh = document.getElementById('tg-disk-threshold').value;

    const payload = {
        TELEGRAM_ENABLED: enabled ? 'true' : 'false',
        TELEGRAM_CHAT_ID: chatId,
        TELEGRAM_ALERT_CPU: cpuThresh,
        TELEGRAM_ALERT_MEM: memThresh,
        TELEGRAM_ALERT_DISK: diskThresh,
        TELEGRAM_DAILY_REPORT: dailyReport ? 'true' : 'false',
    };
    if (token) payload.TELEGRAM_BOT_TOKEN = token;

    try {
        const res = await fetch('/api/telegram/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.ok) {
            showToast('Configuração salva com sucesso!', 'success');
            // Clear token field for security
            document.getElementById('tg-token').value = '';
            await loadTelegramConfig();
        } else {
            showToast('Erro ao salvar: ' + (data.error || 'desconhecido'), 'error');
        }
    } catch (e) {
        showToast('Erro de conexão ao salvar', 'error');
    }
}

async function testTelegram() {
    const token = document.getElementById('tg-token').value.trim();
    const chatId = document.getElementById('tg-chat-id').value.trim();

    showToast('Enviando mensagem de teste...', 'info');

    try {
        const payload = {};
        if (token) payload.token = token;
        if (chatId) payload.chat_id = chatId;

        const res = await fetch('/api/telegram/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.ok) {
            showToast(`✅ Mensagem enviada! Bot: @${data.bot_name}`, 'success');
        } else {
            showToast('❌ Falha: ' + (data.error || 'Verifique token e chat ID'), 'error');
        }
    } catch (e) {
        showToast('Erro de conexão ao testar', 'error');
    }
}

function toggleTokenVisibility() {
    const inp = document.getElementById('tg-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
}
