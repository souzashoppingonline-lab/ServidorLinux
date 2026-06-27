'use strict';

// ============================================================
// STATE
// ============================================================
let ws = null;
let wsRetryTimeout = null;
let wsRetryCount = 0;
let currentPage = 'dashboard';
let eventsPage = 0;
const PAGE_SIZE = 50;

const charts = {};
const chartData = {
    cpu: [], mem: [], risk: [], timestamps: [],
};

// ============================================================
// UTILITIES
// ============================================================
function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleString('pt-BR');
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function getSeverityBadge(sev) {
    const labels = { 4: 'CRÍTICO', 3: 'ALTO', 2: 'MÉDIO', 1: 'BAIXO' };
    return `<span class="sev sev-${sev}">${labels[sev] || sev}</span>`;
}

function getRiskClass(score) {
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    return '';
}

function getRiskLabel(score) {
    if (score >= 75) return 'CRÍTICO';
    if (score >= 50) return 'ALTO';
    if (score >= 25) return 'MÉDIO';
    return 'BAIXO';
}

async function apiFetch(url) {
    try {
        const res = await fetch(url);
        if (res.status === 401) {
            window.location.href = '/login.html';
            return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error('API error:', url, err);
        return null;
    }
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;

    ws = new WebSocket(url);

    const statusEl = document.getElementById('ws-status');
    const dotEl = statusEl.querySelector('.dot');
    const textEl = statusEl.querySelector('span:last-child');

    dotEl.className = 'dot connecting';
    textEl.textContent = 'Conectando...';

    ws.onopen = () => {
        wsRetryCount = 0;
        dotEl.className = 'dot connected';
        textEl.textContent = 'Conectado';
    };

    ws.onmessage = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            handleWsMessage(msg);
        } catch { /* ignore */ }
    };

    ws.onclose = () => {
        dotEl.className = 'dot disconnected';
        textEl.textContent = 'Desconectado';
        scheduleWsReconnect();
    };

    ws.onerror = () => {
        ws.close();
    };
}

function scheduleWsReconnect() {
    if (wsRetryTimeout) return;
    const delay = Math.min(1000 * Math.pow(2, wsRetryCount), 30000);
    wsRetryCount++;
    wsRetryTimeout = setTimeout(() => {
        wsRetryTimeout = null;
        connectWS();
    }, delay);
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
    if (data.cpu !== undefined) {
        document.getElementById('gauge-cpu-val').textContent = `${data.cpu.toFixed(1)}%`;
        drawGauge('gauge-cpu', data.cpu / 100);
    }
    if (data.memory) {
        const pct = data.memory.percent;
        document.getElementById('gauge-mem-val').textContent = `${pct.toFixed(1)}%`;
        drawGauge('gauge-mem', pct / 100);
    }
    if (data.riskScore !== undefined) {
        const score = data.riskScore;
        document.getElementById('gauge-risk-val').textContent = score;
        drawGauge('gauge-risk', score / 100, true);
        updateRiskBadge(score);
    }
    if (data.timestamp) {
        document.getElementById('last-update-time').textContent = formatTime(data.timestamp);

        // Update chart data
        if (chartData.timestamps.length > 50) {
            chartData.timestamps.shift();
            chartData.cpu.shift();
            chartData.mem.shift();
        }
        chartData.timestamps.push(formatTime(data.timestamp));
        if (data.cpu !== undefined) chartData.cpu.push(data.cpu);
        if (data.memory) chartData.mem.push(data.memory.percent);
        updateResourceChart();
    }
}

function handleNewEvents(events) {
    if (!events || events.length === 0) return;
    const critical = events.filter(e => e.severity === 4);
    if (critical.length > 0) {
        critical.forEach(e => {
            showToast(e.title, 'critical');
        });
        // Update critical badge
        const badge = document.getElementById('critical-badge');
        badge.style.display = 'flex';
        badge.textContent = parseInt(badge.textContent || '0') + critical.length;
    }
    // Refresh if on dashboard
    if (currentPage === 'dashboard') {
        refreshRecentEvents();
    }
    if (currentPage === 'events') {
        loadEvents();
    }
}

function updateRiskBadge(score) {
    const badge = document.getElementById('risk-badge');
    const label = document.getElementById('risk-label');
    label.textContent = `RISK: ${score}/100`;
    badge.className = 'risk-badge ' + getRiskClass(score);

    // Big risk gauge
    if (document.getElementById('gauge-risk-big')) {
        drawGaugeBig('gauge-risk-big', score / 100);
        document.getElementById('risk-score-big').textContent = score;
        const levelEl = document.getElementById('risk-level-big');
        levelEl.textContent = getRiskLabel(score);
        const colors = { CRÍTICO: '#ef4444', ALTO: '#f97316', MÉDIO: '#eab308', BAIXO: '#22c55e' };
        levelEl.style.color = colors[getRiskLabel(score)] || '#22c55e';
    }
}

// ============================================================
// GAUGE DRAWING
// ============================================================
function drawGauge(canvasId, value, isRisk = false) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H - 10;
    const r = Math.min(W, H * 2) / 2 - 8;
    const start = Math.PI, end = 2 * Math.PI;
    const angle = start + value * Math.PI;

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.strokeStyle = '#1e2d3d';
    ctx.lineWidth = 10;
    ctx.stroke();

    // Value arc
    let color;
    if (isRisk) {
        color = value < 0.25 ? '#22c55e' : value < 0.5 ? '#eab308' : value < 0.75 ? '#f97316' : '#ef4444';
    } else {
        color = value < 0.6 ? '#22c55e' : value < 0.8 ? '#eab308' : '#ef4444';
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, start, angle);
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.stroke();
}

function drawGaugeBig(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H - 10;
    const r = Math.min(W, H * 2) / 2 - 12;
    const start = Math.PI, end = 2 * Math.PI;
    const angle = start + value * Math.PI;

    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.strokeStyle = '#1e2d3d';
    ctx.lineWidth = 16;
    ctx.stroke();

    const color = value < 0.25 ? '#22c55e' : value < 0.5 ? '#eab308' : value < 0.75 ? '#f97316' : '#ef4444';

    ctx.beginPath();
    ctx.arc(cx, cy, r, start, angle);
    ctx.strokeStyle = color;
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.stroke();
}

// ============================================================
// CHARTS (Chart.js)
// ============================================================
const CHART_DEFAULTS = {
    type: 'line',
    options: {
        responsive: true,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
            x: { ticks: { color: '#475569', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#1e2d3d' } },
            y: { ticks: { color: '#475569', font: { size: 10 } }, grid: { color: '#1e2d3d' }, min: 0, max: 100 },
        },
    },
};

function initCharts() {
    Chart.defaults.color = '#94a3b8';

    // Resource chart (CPU + Mem)
    const resCtx = document.getElementById('chart-resources');
    if (resCtx && !charts.resources) {
        charts.resources = new Chart(resCtx, {
            ...CHART_DEFAULTS,
            data: {
                labels: [],
                datasets: [
                    { label: 'CPU', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
                    { label: 'Memória', data: [], borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
                ],
            },
            options: { ...CHART_DEFAULTS.options, plugins: { ...CHART_DEFAULTS.options.plugins, legend: { display: true, labels: { color: '#94a3b8', boxWidth: 10, font: { size: 11 } } } } },
        });
    }

    // Module chart (doughnut)
    const modCtx = document.getElementById('chart-modules');
    if (modCtx && !charts.modules) {
        charts.modules = new Chart(modCtx, {
            type: 'doughnut',
            data: { labels: [], datasets: [{ data: [], backgroundColor: ['#3b82f6','#ef4444','#22c55e','#eab308','#a855f7','#f97316','#06b6d4','#ec4899'] }] },
            options: { responsive: true, animation: false, plugins: { legend: { position: 'right', labels: { color: '#94a3b8', boxWidth: 10, font: { size: 10 } } } } },
        });
    }
}

function updateResourceChart() {
    if (!charts.resources) return;
    charts.resources.data.labels = chartData.timestamps;
    charts.resources.data.datasets[0].data = chartData.cpu;
    charts.resources.data.datasets[1].data = chartData.mem;
    charts.resources.update('none');
}

function initHistoryChart(canvasId, chartKey, color, label) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || charts[chartKey]) return;
    charts[chartKey] = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.4, pointRadius: 0 }] },
        options: { ...CHART_DEFAULTS.options, plugins: { ...CHART_DEFAULTS.options.plugins, legend: { display: false } } },
    });
}

function updateHistoryChart(chartKey, data) {
    const c = charts[chartKey];
    if (!c) return;
    c.data.labels = data.map(d => formatTime(d.timestamp));
    c.data.datasets[0].data = data.map(d => d.metric_value || d.score);
    c.update('none');
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

    // Clear badge when viewing events
    if (page === 'events') {
        const badge = document.getElementById('critical-badge');
        badge.style.display = 'none';
        badge.textContent = '0';
    }

    // Load page data
    switch (page) {
        case 'dashboard':  loadDashboard(); break;
        case 'events':     loadEvents(); break;
        case 'metrics':    loadMetrics(); break;
        case 'integrity':  refreshIntegrity(); break;
        case 'network':    refreshNetwork(); break;
        case 'risk':       loadRisk(); break;
        case 'audit':      refreshAudit(); break;
    }
}

document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
        const page = el.dataset.page;
        if (page) {
            e.preventDefault();
            switchPage(page);
        }
    });
});

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
    initCharts();
    const data = await apiFetch('/api/summary');
    if (!data) return;

    // Stats
    document.getElementById('stat-critical').textContent = data.stats.critical_24h || 0;
    document.getElementById('stat-events').textContent = data.stats.events_24h || 0;
    document.getElementById('stat-logins').textContent = data.stats.failed_logins_1h || 0;
    document.getElementById('stat-integrity').textContent = data.stats.integrity_changes_24h || 0;

    // Hostname
    if (data.metrics) {
        document.getElementById('hostname-display').textContent =
            `${document.title.split(' - ')[0]} | Uptime: ${formatUptime(data.metrics.uptime)}`;
    }

    // Gauges
    if (data.metrics) {
        document.getElementById('gauge-cpu-val').textContent = `${(data.metrics.cpu || 0).toFixed(1)}%`;
        drawGauge('gauge-cpu', (data.metrics.cpu || 0) / 100);
        document.getElementById('gauge-mem-val').textContent = `${(data.metrics.memory?.percent || 0).toFixed(1)}%`;
        drawGauge('gauge-mem', (data.metrics.memory?.percent || 0) / 100);
    }

    if (data.disks && data.disks.length > 0) {
        const rootDisk = data.disks.find(d => d.mount === '/') || data.disks[0];
        document.getElementById('gauge-disk-val').textContent = `${rootDisk.percent}%`;
        drawGauge('gauge-disk', rootDisk.percent / 100);
    }

    updateRiskBadge(data.riskScore || 0);

    // Module chart
    if (data.moduleStats && charts.modules) {
        charts.modules.data.labels = data.moduleStats.map(m => m.module);
        charts.modules.data.datasets[0].data = data.moduleStats.map(m => m.cnt);
        charts.modules.update('none');
    }

    // Recent events
    renderRecentEvents(data.recentEvents || []);
}

async function refreshRecentEvents() {
    const data = await apiFetch('/api/events?limit=10');
    if (data) renderRecentEvents(data.events);
}

function renderRecentEvents(events) {
    const tbody = document.getElementById('recent-events-body');
    if (!events || events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="loading-row">Nenhum evento recente</td></tr>';
        return;
    }
    tbody.innerHTML = events.map(e => `
        <tr onclick="showEventDetail(${JSON.stringify(e).replace(/"/g, '&quot;')})">
            <td>${getSeverityBadge(e.severity)}</td>
            <td><span class="module-chip">${e.module}</span></td>
            <td title="${e.title}">${e.title}</td>
            <td>${formatTime(e.timestamp)}</td>
        </tr>
    `).join('');
}

// ============================================================
// EVENTS PAGE
// ============================================================
async function loadEvents() {
    const severity = document.getElementById('filter-severity').value;
    const module = document.getElementById('filter-module').value;
    const offset = eventsPage * PAGE_SIZE;

    let url = `/api/events?limit=${PAGE_SIZE}&offset=${offset}`;
    if (severity) url += `&severity=${severity}`;
    if (module) url += `&module=${module}`;

    const data = await apiFetch(url);
    if (!data) return;

    const tbody = document.getElementById('events-body');
    if (!data.events || data.events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="loading-row">Nenhum evento encontrado</td></tr>';
    } else {
        tbody.innerHTML = data.events.map(e => `
            <tr onclick="showEventDetail(${JSON.stringify(e).replace(/"/g, '&quot;')})">
                <td>${e.id}</td>
                <td>${getSeverityBadge(e.severity)}</td>
                <td><span class="module-chip">${e.module}</span></td>
                <td style="font-family:monospace;font-size:0.75rem">${e.event_type}</td>
                <td title="${e.title}">${e.title}</td>
                <td>${e.source_ip || '-'}</td>
                <td>${e.username || '-'}</td>
                <td>${e.risk_score || 0}</td>
                <td>${formatDateTime(e.timestamp)}</td>
                <td onclick="event.stopPropagation()">
                    ${e.acknowledged ? '<span style="color:#22c55e">✓</span>' :
                    `<button class="ack-btn" onclick="acknowledgeEvent(${e.id}, this)">ACK</button>`}
                </td>
            </tr>
        `).join('');
    }

    const totalPages = Math.ceil((data.total || 0) / PAGE_SIZE);
    document.getElementById('page-info').textContent = `Página ${eventsPage + 1} de ${totalPages || 1}`;
    document.getElementById('prev-page').disabled = eventsPage === 0;
    document.getElementById('next-page').disabled = eventsPage >= totalPages - 1;
}

function changePage(delta) {
    eventsPage = Math.max(0, eventsPage + delta);
    loadEvents();
}

async function acknowledgeEvent(id, btn) {
    try {
        await fetch('/api/events/acknowledge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        btn.outerHTML = '<span style="color:#22c55e">✓</span>';
    } catch { /* ignore */ }
}

function showEventDetail(event) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = event.title;
    document.getElementById('modal-body').innerHTML = `
        <div class="modal-field">
            <label>ID / Severity</label>
            <value>#${event.id} — ${getSeverityBadge(event.severity)}</value>
        </div>
        <div class="modal-field">
            <label>Módulo / Tipo</label>
            <value><span class="module-chip">${event.module}</span> ${event.event_type}</value>
        </div>
        <div class="modal-field">
            <label>Hora</label>
            <value>${formatDateTime(event.timestamp)}</value>
        </div>
        ${event.source_ip ? `<div class="modal-field"><label>IP Origem</label><value>${event.source_ip}</value></div>` : ''}
        ${event.username ? `<div class="modal-field"><label>Usuário</label><value>${event.username}</value></div>` : ''}
        <div class="modal-field">
            <label>Risk Score</label>
            <value>${event.risk_score || 0}</value>
        </div>
        ${event.description ? `<div class="modal-field"><label>Descrição</label><pre>${event.description}</pre></div>` : ''}
    `;
    overlay.classList.add('open');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
}

// ============================================================
// METRICS PAGE
// ============================================================
async function loadMetrics() {
    const hours = parseInt(document.getElementById('metrics-period').value);

    initHistoryChart('chart-cpu-hist', 'cpuHist', '#3b82f6', 'CPU %');
    initHistoryChart('chart-mem-hist', 'memHist', '#a855f7', 'Memória %');
    initHistoryChart('chart-risk-hist', 'riskHist', '#ef4444', 'Risk Score');

    const [cpuData, memData, riskData, liveData] = await Promise.all([
        apiFetch(`/api/metrics?name=cpu_usage&hours=${hours}`),
        apiFetch(`/api/metrics?name=memory_usage&hours=${hours}`),
        apiFetch(`/api/risk`),
        apiFetch('/api/metrics/live'),
    ]);

    if (cpuData) updateHistoryChart('cpuHist', cpuData.data);
    if (memData) updateHistoryChart('memHist', memData.data);
    if (riskData) updateHistoryChart('riskHist', riskData.history);

    if (liveData && liveData.disks) {
        const tbody = document.getElementById('disks-body');
        tbody.innerHTML = liveData.disks.map(d => {
            const barClass = d.percent >= 90 ? 'danger' : d.percent >= 75 ? 'warn' : '';
            return `<tr>
                <td>${d.device}</td>
                <td>${d.mount}</td>
                <td>${d.size}</td>
                <td>${d.used}</td>
                <td>${d.avail}</td>
                <td>
                    ${d.percent}%
                    <div class="disk-bar"><div class="disk-bar-fill ${barClass}" style="width:${d.percent}%"></div></div>
                </td>
            </tr>`;
        }).join('');
    }
}

// ============================================================
// INTEGRITY PAGE
// ============================================================
async function refreshIntegrity() {
    const data = await apiFetch('/api/integrity');
    if (!data) return;

    document.getElementById('integrity-baseline-count').textContent = data.baselineCount || 0;
    document.getElementById('integrity-changes-count').textContent = data.changes?.length || 0;

    const tbody = document.getElementById('integrity-body');
    if (!data.changes || data.changes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading-row">Nenhuma mudança detectada ✓</td></tr>';
    } else {
        tbody.innerHTML = data.changes.map(c => `
            <tr>
                <td title="${c.filepath}">${c.filepath}</td>
                <td>${c.change_type}</td>
                <td style="font-family:monospace;font-size:0.7rem">${c.old_hash ? c.old_hash.substring(0,16) + '...' : '-'}</td>
                <td style="font-family:monospace;font-size:0.7rem">${c.new_hash ? c.new_hash.substring(0,16) + '...' : '-'}</td>
                <td>${formatDateTime(c.timestamp)}</td>
            </tr>
        `).join('');
    }
}

// ============================================================
// NETWORK PAGE
// ============================================================
async function refreshNetwork() {
    const data = await apiFetch('/api/events?module=NETWORK&limit=50');
    if (!data) return;

    const tbody = document.getElementById('network-body');
    if (!data.events || data.events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading-row">Nenhum evento de rede</td></tr>';
    } else {
        tbody.innerHTML = data.events.map(e => `
            <tr onclick="showEventDetail(${JSON.stringify(e).replace(/"/g, '&quot;')})">
                <td style="font-family:monospace;font-size:0.75rem">${e.event_type}</td>
                <td>${e.title}</td>
                <td>${e.source_ip || '-'}</td>
                <td>${e.risk_score || 0}</td>
                <td>${formatDateTime(e.timestamp)}</td>
            </tr>
        `).join('');
    }
}

// ============================================================
// RISK PAGE
// ============================================================
async function loadRisk() {
    const data = await apiFetch('/api/risk');
    if (!data) return;

    const score = data.current?.score || 0;
    updateRiskBadge(score);

    initHistoryChart('chart-risk-big', 'riskBig', '#ef4444', 'Risk Score');
    if (data.history) updateHistoryChart('riskBig', data.history);

    // Risk factors
    const eventsData = await apiFetch('/api/events?limit=200');
    if (eventsData && eventsData.events) {
        const now = Math.floor(Date.now() / 1000);
        const hourAgo = now - 3600;
        const dayAgo = now - 86400;

        const factors = [
            { name: 'Logins SSH Falhos (1h)', value: eventsData.events.filter(e => e.module === 'SSH' && e.event_type === 'FAILED_LOGIN' && e.timestamp > hourAgo).length, weight: '+10 cada' },
            { name: 'Mudanças Integridade (24h)', value: eventsData.events.filter(e => e.module === 'INTEGRITY' && e.timestamp > dayAgo).length, weight: '+25 cada' },
            { name: 'Eventos Críticos (24h)', value: eventsData.events.filter(e => e.severity === 4 && e.timestamp > dayAgo).length, weight: '+20 cada' },
            { name: 'Port Scans (24h)', value: eventsData.events.filter(e => e.event_type === 'PORT_SCAN' && e.timestamp > dayAgo).length, weight: '+15 cada' },
            { name: 'Eventos SSH (24h)', value: eventsData.events.filter(e => e.module === 'SSH' && e.timestamp > dayAgo).length, weight: '' },
        ];

        const container = document.getElementById('risk-factors');
        container.innerHTML = factors.map(f => `
            <div class="risk-factor">
                <div class="risk-factor-name">${f.name}</div>
                <div class="risk-factor-value">${f.value}</div>
                ${f.weight ? `<div class="risk-factor-weight">${f.weight}</div>` : ''}
            </div>
        `).join('');
    }
}

// ============================================================
// AUDIT PAGE
// ============================================================
async function refreshAudit() {
    const data = await apiFetch('/api/events?module=AUDIT&limit=50');
    if (!data) return;

    const tbody = document.getElementById('audit-body');
    if (!data.events || data.events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="loading-row">Nenhum evento de auditoria</td></tr>';
    } else {
        tbody.innerHTML = data.events.map(e => `
            <tr onclick="showEventDetail(${JSON.stringify(e).replace(/"/g, '&quot;')})">
                <td style="font-family:monospace;font-size:0.75rem">${e.event_type}</td>
                <td>${e.title}</td>
                <td>${getSeverityBadge(e.severity)}</td>
                <td>${formatDateTime(e.timestamp)}</td>
            </tr>
        `).join('');
    }
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const icon = type === 'critical' ? '🔴' : type === 'warning' ? '🟡' : '🔵';
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

// ============================================================
// AUTH
// ============================================================
async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
}

// ============================================================
// CLOCK
// ============================================================
function updateClock() {
    document.getElementById('current-time').textContent =
        new Date().toLocaleTimeString('pt-BR');
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    connectWS();
    loadDashboard();

    // Refresh dashboard every 30s
    setInterval(() => {
        if (currentPage === 'dashboard') loadDashboard();
    }, 30000);
});
