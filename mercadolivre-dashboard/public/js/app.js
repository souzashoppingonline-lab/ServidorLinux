/* ML Dashboard — SPA controller */
'use strict';

// ============================================================
// STATE
// ============================================================
const State = {
  me: null,
  stores: [],
  currentStore: null,
  charts: {},
};

// ============================================================
// UTILS
// ============================================================
const fmt = {
  brl: v  => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0),
  num: v  => new Intl.NumberFormat('pt-BR').format(v || 0),
  date: d => d ? new Date(d).toLocaleDateString('pt-BR') : '-',
  dt:   d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-',
  pct: v  => `${(v || 0).toFixed(1)}%`,
};

const STATUS_ORDER = {
  paid:        { label: 'Pago',       cls: 'badge-green'  },
  pending:     { label: 'Pendente',   cls: 'badge-yellow' },
  cancelled:   { label: 'Cancelado',  cls: 'badge-red'    },
  confirmed:   { label: 'Confirmado', cls: 'badge-blue'   },
  payment_required: { label: 'Aguard. pagto', cls: 'badge-yellow' },
  in_process:  { label: 'Em processo', cls: 'badge-blue'  },
};

const STATUS_SHIP = {
  ready_to_ship: { label: 'Pronto p/ envio', cls: 'badge-yellow' },
  shipped:       { label: 'Enviado',         cls: 'badge-blue'   },
  delivered:     { label: 'Entregue',        cls: 'badge-green'  },
  not_delivered: { label: 'Não entregue',    cls: 'badge-red'    },
  cancelled:     { label: 'Cancelado',       cls: 'badge-red'    },
};

const STATUS_LISTING = {
  active:       { label: 'Ativo',        cls: 'badge-green'  },
  paused:       { label: 'Pausado',      cls: 'badge-yellow' },
  closed:       { label: 'Fechado',      cls: 'badge-red'    },
  under_review: { label: 'Em revisão',   cls: 'badge-blue'   },
  inactive:     { label: 'Inativo',      cls: 'badge-gray'   },
};

function badge(map, key) {
  const s = map[key] || { label: key || '-', cls: 'badge-gray' };
  return `<span class="badge ${s.cls}">${s.label}</span>`;
}

function toast(msg, type = 'default') {
  const tc = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span> ${msg}`;
  tc.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setContent(html) {
  document.getElementById('content').innerHTML = html;
}

function loading() {
  setContent(`<div class="loading-state"><div class="spinner"></div><p>Carregando...</p></div>`);
}

function destroyCharts() {
  Object.values(State.charts).forEach(c => { try { c.destroy(); } catch {} });
  State.charts = {};
  if (State.schedulerRefreshTimer) {
    clearInterval(State.schedulerRefreshTimer);
    State.schedulerRefreshTimer = null;
  }
}

// ============================================================
// MODAL
// ============================================================
const Modal = {
  open(title, bodyHtml, footerHtml = '') {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML   = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml;
    document.getElementById('modalOverlay').style.display = 'flex';
  },
  close() {
    document.getElementById('modalOverlay').style.display = 'none';
  },
};

// ============================================================
// ROUTER
// ============================================================
const PAGES = {
  dashboard:        renderDashboard,
  listings:         renderListings,
  orders:           renderOrders,
  questions:        renderQuestions,
  messages:         renderMessages,
  metrics:          renderMetrics,
  stores:           renderStores,
  hourly:           renderHourly,
  weekday:          renderWeekday,
  'products-analysis': renderProducts,
  performance:      renderPerformance,
  scheduler:        renderScheduler,
  ads:              renderAds,
  customers:        renderCustomers,
};

const PAGE_TITLES = {
  dashboard:        'Dashboard',
  listings:         'Anúncios',
  orders:           'Pedidos',
  questions:        'Perguntas',
  messages:         'Mensagens',
  metrics:          'Métricas',
  stores:           'Lojas Conectadas',
  hourly:           'Horários de Venda',
  weekday:          'Dias da Semana',
  'products-analysis': 'Ranking de Produtos',
  'performance':    'Performance de Anúncios',
  scheduler:        'Scheduler',
  ads:              'Publicidade (Mercado Ads)',
  customers:        'Clientes',
};

function navigate(page) {
  destroyCharts();
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  document.getElementById('topbarTitle').textContent = PAGE_TITLES[page] || page;
  history.pushState({ page }, '', `#${page}`);
  const fn = PAGES[page];
  if (fn) fn();
}

// ============================================================
// STORE SELECTOR
// ============================================================
function buildStoreSelector() {
  const sel = document.getElementById('storeSelect');
  sel.innerHTML = State.stores.map(s =>
    `<option value="${s.id}" ${s.id === State.currentStore ? 'selected' : ''}>${s.nickname}</option>`
  ).join('');
  sel.onchange = () => {
    State.currentStore = sel.value;
    const page = location.hash.replace('#', '') || 'dashboard';
    navigate(page);
  };
}

function updateSidebarUser(store) {
  if (!store) return;
  document.getElementById('sidebarName').textContent = store.nickname;
  const av = document.getElementById('sidebarAvatar');
  if (store.thumbnail) {
    av.innerHTML = `<img src="${store.thumbnail}" alt="${store.nickname}">`;
  } else {
    av.textContent = store.nickname[0].toUpperCase();
  }
}

// ============================================================
// INIT
// ============================================================
async function init() {
  try {
    const { store, stores } = await API.me();
    State.me = store;
    State.stores = stores;
    State.currentStore = store.id;

    updateSidebarUser(store);
    buildStoreSelector();

    // Nav clicks
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        navigate(el.dataset.page);
      });
    });

    // Logout
    document.getElementById('btnLogout').addEventListener('click', async () => {
      await API.logout().catch(() => {});
      localStorage.removeItem('ml_token');
      location.href = '/login';
    });

    // Refresh
    document.getElementById('btnRefresh').addEventListener('click', () => {
      const r = document.getElementById('btnRefresh');
      r.classList.add('spinning');
      const page = location.hash.replace('#', '') || 'dashboard';
      navigate(page);
      setTimeout(() => r.classList.remove('spinning'), 1000);
    });

    // Sync status
    async function loadSyncStatus() {
      const data = await API.get('/api/scheduler/status').catch(() => null);
      const el = document.getElementById('syncStatus');
      if (el && data) {
        const logs = data.syncLogs || [];
        const lastSync = logs.reduce((max, l) => Math.max(max, l.last_sync || 0), 0);
        if (lastSync) {
          const mins = Math.floor((Date.now() / 1000 - lastSync) / 60);
          el.textContent = mins < 1 ? 'sincronizado agora' : `${mins}min atrás`;
        }
        if (data.queue && data.queue.pending > 0) {
          el.textContent = `${data.queue.pending} job(s) pendente(s)`;
        }
      }
    }
    loadSyncStatus();

    // Sync button — triggers order sync via scheduler
    document.getElementById('btnSync').addEventListener('click', async () => {
      const btn = document.getElementById('btnSync');
      btn.textContent = '⟳ Enfileirando...';
      btn.disabled = true;
      await API.post('/api/scheduler/trigger', { type: 'sync_orders', storeId: State.currentStore }).catch(() => {});
      setTimeout(() => {
        btn.textContent = '⟳ Sync';
        btn.disabled = false;
        loadSyncStatus();
      }, 2000);
    });

    // Toggle sidebar (mobile)
    document.getElementById('btnToggleSidebar').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarOverlay').classList.toggle('show');
    });

    // Modal close
    document.getElementById('modalClose').addEventListener('click', Modal.close);
    document.getElementById('modalOverlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) Modal.close();
    });

    // Hash routing
    window.addEventListener('popstate', () => {
      const page = location.hash.replace('#', '') || 'dashboard';
      navigate(page);
    });

    // WebSocket for real-time updates
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${wsProto}://${location.host}`);
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'webhook') {
        toast(`Atualização recebida: ${msg.data.topic}`, 'default');
      }
    };

    const page = location.hash.replace('#', '') || 'dashboard';
    navigate(page);
  } catch (e) {
    console.error(e);
    location.href = '/login';
  }
}

// ============================================================
// SIDEBAR OVERLAY (mobile)
// ============================================================
document.body.insertAdjacentHTML('beforeend', '<div class="sidebar-overlay" id="sidebarOverlay"></div>');
document.addEventListener('click', e => {
  if (e.target.id === 'sidebarOverlay') {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('show');
  }
});

// ============================================================
// PAGE: DASHBOARD
// ============================================================
async function renderDashboard() {
  loading();
  try {
    const [data, repData] = await Promise.all([
      API.dashboard(State.currentStore),
      API.get(`/api/reputation?storeId=${State.currentStore}`).catch(() => ({ reputation: null })),
    ]);
    const { kpis, chartData, recentOrders } = data;
    const rep = repData.reputation;

    const html = `
      <div class="page-header">
        <div>
          <div class="page-title">Dashboard CFO</div>
          <div class="page-subtitle">Visão geral dos últimos 30 dias</div>
        </div>
      </div>

      <div class="kpi-grid">
        ${kpiCard('Receita 30 dias', fmt.brl(kpis.revenue30d), 'Período atual', '💰', '#FFE600')}
        ${kpiCard('Hoje', fmt.brl(kpis.revenueToday), 'Faturamento do dia', '📅', '#10b981')}
        ${kpiCard('Pedidos 30d', fmt.num(kpis.orders30d), `${fmt.num(kpis.ordersToday)} hoje`, '🛒', '#3b82f6')}
        ${kpiCard('Ticket Médio', fmt.brl(kpis.avgTicket), 'Últimos 30 dias', '📊', '#8b5cf6')}
        ${kpiCard('Anúncios Ativos', fmt.num(kpis.activeListings), `${fmt.num(kpis.pausedListings)} pausados`, '📦', '#f59e0b')}
        ${kpiCard('Perguntas Pendentes', fmt.num(kpis.pendingQuestions), 'Aguardando resposta', '❓', kpis.pendingQuestions > 0 ? '#ef4444' : '#10b981')}
      </div>

      <div class="chart-grid">
        <div class="card">
          <div class="card-title">📈 Receita — Últimos 30 dias</div>
          <div class="chart-container">
            <canvas id="revenueChart"></canvas>
          </div>
        </div>
        <div class="card">
          <div class="card-title">⚡ Ações Necessárias</div>
          ${actionItems(kpis)}
        </div>
      </div>

      ${rep ? `
      <div class="card" style="margin-top:0">
        <div class="card-title">⭐ Reputação do Vendedor</div>
        ${reputationCard(rep)}
      </div>
      ` : ''}

      <div class="card">
        <div class="card-title">🛒 Últimos Pedidos</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#Pedido</th>
                <th>Data</th>
                <th>Comprador</th>
                <th>Produtos</th>
                <th class="text-right">Valor</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${recentOrders.length ? recentOrders.map(o => `
                <tr>
                  <td class="fw-bold" style="font-size:13px;color:var(--text-2)">#${o.id}</td>
                  <td class="td-light">${fmt.dt(o.date)}</td>
                  <td>${o.buyer}</td>
                  <td class="truncate" style="max-width:220px">${o.items || '-'}</td>
                  <td class="text-right fw-bold">${fmt.brl(o.amount)}</td>
                  <td>${badge(STATUS_ORDER, o.status)}</td>
                </tr>
              `).join('') : '<tr><td colspan="6" class="text-center td-light" style="padding:32px">Nenhum pedido encontrado.</td></tr>'}
            </tbody>
          </table>
        </div>
        ${recentOrders.length ? `<div style="padding-top:12px"><a href="#orders" class="btn btn-secondary btn-sm" onclick="navigate('orders');return false">Ver todos os pedidos →</a></div>` : ''}
      </div>
    `;

    setContent(html);

    // Revenue chart
    const ctx = document.getElementById('revenueChart').getContext('2d');
    State.charts.revenue = new Chart(ctx, {
      type: 'line',
      data: {
        labels: chartData.map(d => {
          const dt = new Date(d.date + 'T12:00:00');
          return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        }),
        datasets: [{
          label: 'Receita (R$)',
          data: chartData.map(d => d.revenue),
          borderColor: '#FFE600',
          backgroundColor: 'rgba(255,230,0,0.1)',
          borderWidth: 2.5,
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 11 } } },
          y: {
            grid: { color: '#f0f2f8' },
            ticks: {
              font: { size: 11 },
              callback: v => 'R$ ' + Intl.NumberFormat('pt-BR', { notation: 'compact' }).format(v),
            },
          },
        },
      },
    });

    // Pending questions badge
    const qb = document.getElementById('questionsBadge');
    if (kpis.pendingQuestions > 0) {
      qb.textContent = kpis.pendingQuestions;
      qb.style.display = 'inline';
    } else {
      qb.style.display = 'none';
    }

  } catch (e) {
    setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro ao carregar</h3><p>${e.message}</p></div>`);
  }
}

function kpiCard(label, value, sub, icon, color) {
  return `
    <div class="kpi-card" style="--kpi-color:${color}">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>
  `;
}

function actionItems(kpis) {
  const items = [];
  if (kpis.pendingQuestions > 0) items.push({ icon: '❓', label: `${kpis.pendingQuestions} pergunta${kpis.pendingQuestions > 1 ? 's' : ''} sem resposta`, page: 'questions', urgent: true });
  if (kpis.pausedListings > 0)  items.push({ icon: '⏸', label: `${kpis.pausedListings} anúncio${kpis.pausedListings > 1 ? 's' : ''} pausado${kpis.pausedListings > 1 ? 's' : ''}`, page: 'listings' });
  if (!items.length) return `<div style="text-align:center;padding:32px 0;color:var(--text-2)">✅ Tudo em dia!</div>`;
  return `
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      ${items.map(i => `
        <a href="#${i.page}" onclick="navigate('${i.page}');return false" style="display:flex;align-items:center;gap:12px;padding:14px;background:${i.urgent ? '#fef2f2' : 'var(--bg)'};border-radius:var(--radius-sm);text-decoration:none;color:var(--text);border:1px solid ${i.urgent ? '#fecaca' : 'var(--border)'};transition:box-shadow .2s">
          <span style="font-size:20px">${i.icon}</span>
          <span style="font-size:14px;font-weight:600;flex:1">${i.label}</span>
          <span style="color:var(--text-3)">→</span>
        </a>
      `).join('')}
    </div>
  `;
}

function reputationCard(rep) {
  const LEVEL_LABEL = {
    '1_red':         { label: 'Vermelho',    color: '#ef4444', bg: '#fef2f2', icon: '🔴' },
    '2_orange':      { label: 'Laranja',     color: '#f97316', bg: '#fff7ed', icon: '🟠' },
    '3_yellow':      { label: 'Amarelo',     color: '#eab308', bg: '#fefce8', icon: '🟡' },
    '4_light_green': { label: 'Verde Claro', color: '#84cc16', bg: '#f7fee7', icon: '🟢' },
    '5_green':       { label: 'Verde',       color: '#22c55e', bg: '#f0fdf4', icon: '🟢' },
  };
  const lvl = LEVEL_LABEL[rep.level_id] || { label: rep.level_id || 'N/A', color: '#9ca3af', bg: '#f9fafb', icon: '⚪' };
  const total = rep.transactions_total || 1;
  const posPct    = ((rep.ratings_positive / total) * 100).toFixed(1);
  const delayPct  = ((rep.metrics_sales_delayed_pct || 0) * 100).toFixed(1);
  const claimsPct = ((rep.metrics_claims_rate || 0) * 100).toFixed(1);
  const cancelPct = ((rep.metrics_cancellations_rate || 0) * 100).toFixed(1);

  const metricBox = (icon, label, value, bad) => `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 16px;background:var(--surface);border-radius:10px;gap:6px;text-align:center">
      <span style="font-size:24px">${icon}</span>
      <span style="font-size:22px;font-weight:700;color:${bad ? '#ef4444' : '#22c55e'}">${value}</span>
      <span style="font-size:12px;color:var(--text-2)">${label}</span>
    </div>
  `;

  return `
    <div style="display:flex;align-items:center;gap:20px;padding:20px;background:${lvl.bg};border-radius:10px;margin-bottom:20px;border:1.5px solid ${lvl.color}33">
      <span style="font-size:48px;line-height:1">${lvl.icon}</span>
      <div>
        <div style="font-size:22px;font-weight:800;color:${lvl.color}">Reputação ${lvl.label}</div>
        <div style="font-size:14px;color:var(--text-2);margin-top:4px">
          ${fmt.num(rep.transactions_completed)} vendas concluídas &nbsp;·&nbsp;
          ${fmt.num(rep.transactions_canceled)} canceladas &nbsp;·&nbsp;
          ${fmt.num(rep.transactions_total)} total
        </div>
        ${rep.power_seller_status ? `<div style="margin-top:6px"><span style="background:${lvl.color};color:#fff;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.5px">🏅 ${rep.power_seller_status.toUpperCase()}</span></div>` : ''}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
      ${metricBox('👍', 'Avaliações Positivas', posPct + '%', parseFloat(posPct) < 90)}
      ${metricBox('⏱', 'Entregas no Prazo', (100 - parseFloat(delayPct)).toFixed(1) + '%', parseFloat(delayPct) > 5)}
      ${metricBox('⚠️', 'Taxa de Reclamações', claimsPct + '%', parseFloat(claimsPct) > 2)}
      ${metricBox('❌', 'Taxa de Cancelamentos', cancelPct + '%', parseFloat(cancelPct) > 3)}
    </div>
  `;
}

// ============================================================
// PAGE: LISTINGS
// ============================================================
let listingsState = { status: 'active', offset: 0, limit: 50, total: 0 };

async function renderListings() {
  setContent(`
    <div class="page-header">
      <div>
        <div class="page-title">Anúncios</div>
        <div class="page-subtitle">Gerenciar produtos e estoque</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="forceSyncListings()" title="Re-sincronizar anúncios e promoções">🔄 Sincronizar</button>
      </div>
    </div>
    <div class="filters">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${['active','paused','closed'].map(s => `<button class="period-btn ${listingsState.status===s?'active':''}" onclick="setListingStatus('${s}')">${STATUS_LISTING[s]?.label||s}</button>`).join('')}
      </div>
    </div>
    <div id="listingsBody"><div class="loading-state"><div class="spinner"></div></div></div>
  `);
  await loadListings();
}

window.forceSyncListings = async () => {
  try {
    const storeId = State.currentStore;
    await API.post('/api/scheduler/trigger', { type: 'sync_listings_batch', storeId, force: true });
    await API.post('/api/scheduler/trigger', { type: 'sync_promotions',     storeId, force: true });
    toast('Sync de anúncios e promoções iniciado — aguarde alguns minutos e recarregue', 'success');
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
};

window.setListingStatus = async (status) => {
  listingsState.status = status;
  listingsState.offset = 0;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.textContent === (STATUS_LISTING[status]?.label || status)));
  await loadListings();
};

async function loadListings() {
  const wrap = document.getElementById('listingsBody');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

  try {
    const data = await API.listings(State.currentStore, listingsState);
    listingsState.total = data.total;

    if (!data.items.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📦</div><h3>Nenhum anúncio encontrado</h3><p>Sem anúncios com status "${listingsState.status}".</p></div>`;
      return;
    }

    wrap.innerHTML = `
      <div class="listing-grid">
        ${data.items.map(item => listingCard(item)).join('')}
      </div>
      ${paginationHtml(listingsState.offset, listingsState.limit, data.total, 'listingsPage')}
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`;
  }
}

function listingCard(item) {
  const hasPromo   = item.in_promotion;
  const discPct    = Math.round(item.discount_pct || 0);
  const promoName  = item.promotions?.[0]?.name || item.promotions?.[0]?.type || '';
  const origPrice  = item.original_price > 0 ? item.original_price : null;

  const promoTag = hasPromo
    ? `<span class="promo-badge" title="${promoName || 'Em promoção'}">🏷️ ${discPct > 0 ? `-${discPct}%` : 'Promo'}</span>`
    : '';

  const precoHtml = origPrice
    ? `<div class="listing-stat-val">${fmt.brl(item.price)}</div>
       <div style="font-size:11px;color:#9ca3af;text-decoration:line-through">${fmt.brl(origPrice)}</div>
       <div class="listing-stat-lab">Preço</div>`
    : `<div class="listing-stat-val">${fmt.brl(item.price)}</div>
       <div class="listing-stat-lab">Preço</div>`;

  return `
    <div class="listing-card ${hasPromo ? 'listing-card--promo' : ''}">
      ${item.thumbnail
        ? `<img class="listing-thumb" src="${item.thumbnail}" alt="${item.title}" loading="lazy">`
        : `<div class="listing-thumb-ph">📦</div>`}
      <div class="listing-info">
        <div class="listing-title" title="${item.title}">${item.title}</div>
        <div class="listing-meta">
          <span>${badge(STATUS_LISTING, item.status)}</span>
          ${promoTag}
          <span style="color:var(--text-3)">ID: ${item.id}</span>
          ${item.permalink ? `<a href="${item.permalink}" target="_blank" style="color:var(--blue);font-size:12px">Ver no ML ↗</a>` : ''}
        </div>
      </div>
      <div class="listing-stats">
        <div class="listing-stat">${precoHtml}</div>
        <div class="listing-stat">
          <div class="listing-stat-val">${fmt.num(item.available_quantity)}</div>
          <div class="listing-stat-lab">Estoque</div>
        </div>
        <div class="listing-stat">
          <div class="listing-stat-val">${fmt.num(item.sold_quantity)}</div>
          <div class="listing-stat-lab">Vendidos</div>
        </div>
      </div>
      <div class="listing-actions">
        <button class="btn btn-secondary btn-sm" onclick="openEditListing('${item.id}',${item.price},${item.available_quantity},'${item.status}','${item.title.replace(/'/g,"\\'")}')">✏️ Editar</button>
        ${item.status === 'active'
          ? `<button class="btn btn-secondary btn-sm" onclick="toggleListing('${item.id}','paused')">⏸</button>`
          : item.status === 'paused'
          ? `<button class="btn btn-primary btn-sm"   onclick="toggleListing('${item.id}','active')">▶</button>`
          : ''}
      </div>
    </div>
  `;
}

window.openEditListing = (id, price, qty, status, title) => {
  Modal.open(`Editar: ${title}`, `
    <div class="form-group">
      <label class="form-label">Preço (R$)</label>
      <input type="number" id="editPrice" class="form-control" value="${price}" min="0" step="0.01">
    </div>
    <div class="form-group">
      <label class="form-label">Estoque disponível</label>
      <input type="number" id="editQty" class="form-control" value="${qty}" min="0">
    </div>
  `, `
    <button class="btn btn-secondary" onclick="Modal.close()">Cancelar</button>
    <button class="btn btn-primary" onclick="saveListingEdit('${id}')">💾 Salvar</button>
  `);
};

window.saveListingEdit = async (id) => {
  const price = parseFloat(document.getElementById('editPrice').value);
  const qty   = parseInt(document.getElementById('editQty').value);
  if (isNaN(price) || price <= 0) { toast('Preço inválido', 'error'); return; }
  try {
    await API.updateItem(id, State.currentStore, { price, available_quantity: qty });
    toast('Anúncio atualizado!', 'success');
    Modal.close();
    await loadListings();
  } catch (e) {
    toast(e.message, 'error');
  }
};

window.toggleListing = async (id, newStatus) => {
  try {
    await API.updateItem(id, State.currentStore, { status: newStatus });
    toast(`Anúncio ${newStatus === 'active' ? 'ativado' : 'pausado'}!`, 'success');
    await loadListings();
  } catch (e) {
    toast(e.message, 'error');
  }
};

window.listingsPage = (offset) => {
  listingsState.offset = offset;
  loadListings();
};

// ============================================================
// PAGE: ORDERS
// ============================================================
let ordersState = { status: '', from: '', to: '', offset: 0, limit: 50 };

async function renderOrders() {
  const now = new Date();
  const d30 = new Date(now - 30 * 86400000).toISOString().split('T')[0];
  const tod = now.toISOString().split('T')[0];
  if (!ordersState.from) ordersState.from = d30;
  if (!ordersState.to)   ordersState.to   = tod;

  setContent(`
    <div class="page-header">
      <div>
        <div class="page-title">Pedidos</div>
        <div class="page-subtitle">Histórico completo de vendas</div>
      </div>
    </div>
    <div class="filters">
      <select class="filter-select" id="orderStatus" style="width:auto" onchange="setOrderFilter()">
        <option value="">Todos os status</option>
        <option value="paid">Pago</option>
        <option value="pending">Pendente</option>
        <option value="confirmed">Confirmado</option>
        <option value="cancelled">Cancelado</option>
        <option value="in_process">Em processo</option>
      </select>
      <input type="date" class="filter-input" id="orderFrom" value="${ordersState.from}" onchange="setOrderFilter()" style="width:auto">
      <input type="date" class="filter-input" id="orderTo"   value="${ordersState.to}"   onchange="setOrderFilter()" style="width:auto">
      <button class="btn btn-primary" onclick="setOrderFilter()">Filtrar</button>
    </div>
    <div id="ordersBody"><div class="loading-state"><div class="spinner"></div></div></div>
  `);
  await loadOrders();
}

window.setOrderFilter = async () => {
  ordersState.status = document.getElementById('orderStatus')?.value || '';
  ordersState.from   = document.getElementById('orderFrom')?.value   || '';
  ordersState.to     = document.getElementById('orderTo')?.value     || '';
  ordersState.offset = 0;
  await loadOrders();
};

async function loadOrders() {
  const wrap = document.getElementById('ordersBody');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

  try {
    const data = await API.orders(State.currentStore, ordersState);

    if (!data.orders.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🛒</div><h3>Nenhum pedido</h3><p>Nenhum pedido encontrado para os filtros selecionados.</p></div>`;
      return;
    }

    const total = data.orders.reduce((s, o) => s + o.amount, 0);
    const totalOrders = data.paging?.total || data.orders.length;

    wrap.innerHTML = `
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
        ${kpiCard('Pedidos', fmt.num(totalOrders), 'nesta página', '🛒', '#3b82f6')}
        ${kpiCard('Receita', fmt.brl(total), 'total exibido', '💰', '#FFE600')}
        ${kpiCard('Ticket Médio', fmt.brl(data.orders.length ? total / data.orders.length : 0), 'por pedido', '📊', '#8b5cf6')}
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#Pedido</th>
                <th>Data</th>
                <th>Comprador</th>
                <th>Produtos</th>
                <th class="text-right">Valor</th>
                <th>Pagamento</th>
                <th>Envio</th>
              </tr>
            </thead>
            <tbody>
              ${data.orders.map(o => `
                <tr style="cursor:pointer" onclick="openOrderDetail(${JSON.stringify(o).replace(/"/g,'&quot;')})">
                  <td class="fw-bold" style="color:var(--blue);font-size:13px">#${o.id}</td>
                  <td class="td-light">${fmt.dt(o.date)}</td>
                  <td>${o.buyer?.nickname || '-'}</td>
                  <td class="truncate td-light" style="max-width:200px">${o.items.map(i => i.title).join(', ') || '-'}</td>
                  <td class="text-right fw-bold">${fmt.brl(o.amount)}</td>
                  <td>${badge(STATUS_ORDER, o.payment_status || o.status)}</td>
                  <td>${badge(STATUS_SHIP,  o.shipping_status)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${paginationHtml(ordersState.offset, ordersState.limit, totalOrders, 'ordersPage')}
      </div>
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`;
  }
}

window.openOrderDetail = (order) => {
  Modal.open(`Pedido #${order.id}`, `
    <div style="display:flex;flex-direction:column;gap:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:4px">Comprador</div><div style="font-weight:600">${order.buyer?.nickname || '-'}</div></div>
        <div><div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:4px">Data</div><div>${fmt.dt(order.date)}</div></div>
        <div><div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:4px">Pagamento</div>${badge(STATUS_ORDER, order.payment_status || order.status)}</div>
        <div><div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:4px">Envio</div>${badge(STATUS_SHIP, order.shipping_status)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:8px">Produtos</div>
        ${order.items.map(i => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
            ${i.thumbnail ? `<img src="${i.thumbnail}" style="width:40px;height:40px;object-fit:contain;border-radius:6px;border:1px solid var(--border)">` : ''}
            <div style="flex:1">
              <div style="font-size:13px;font-weight:600">${i.title || i.id}</div>
              <div style="font-size:12px;color:var(--text-2)">Qtd: ${i.quantity} × ${fmt.brl(i.unit_price)}</div>
            </div>
            <div style="font-weight:700">${fmt.brl(i.quantity * i.unit_price)}</div>
          </div>
        `).join('')}
      </div>
      <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;padding-top:4px">
        <span style="font-size:14px;color:var(--text-2)">Total:</span>
        <span style="font-size:20px;font-weight:800">${fmt.brl(order.amount)}</span>
      </div>
      ${order.pack_id ? `<button class="btn btn-secondary btn-sm" onclick="Modal.close();showMessages('${order.pack_id}')">💬 Ver mensagens deste pedido</button>` : ''}
    </div>
  `, `<button class="btn btn-secondary" onclick="Modal.close()">Fechar</button>`);
};

window.ordersPage = (offset) => {
  ordersState.offset = offset;
  loadOrders();
};

// ============================================================
// PAGE: QUESTIONS
// ============================================================
let questionsState = { status: 'UNANSWERED', offset: 0, limit: 20 };

async function renderQuestions() {
  setContent(`
    <div class="page-header">
      <div>
        <div class="page-title">Perguntas</div>
        <div class="page-subtitle">Responda perguntas dos compradores</div>
      </div>
    </div>
    <div class="filters">
      ${['UNANSWERED','ANSWERED'].map(s => `<button class="period-btn ${questionsState.status===s?'active':''}" onclick="setQuestionStatus('${s}')">${s==='UNANSWERED'?'Sem resposta':'Respondidas'}</button>`).join('')}
    </div>
    <div id="questionsBody"><div class="loading-state"><div class="spinner"></div></div></div>
  `);
  await loadQuestions();
}

window.setQuestionStatus = async (status) => {
  questionsState.status = status;
  questionsState.offset = 0;
  document.querySelectorAll('.period-btn').forEach(b => {
    b.classList.toggle('active', (status==='UNANSWERED'&&b.textContent==='Sem resposta')||(status==='ANSWERED'&&b.textContent==='Respondidas'));
  });
  await loadQuestions();
};

async function loadQuestions() {
  const wrap = document.getElementById('questionsBody');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

  try {
    const data = await API.questions(State.currentStore, questionsState);

    if (!data.questions.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">✅</div><h3>Nenhuma pergunta</h3><p>${questionsState.status==='UNANSWERED'?'Nenhuma pergunta pendente. Tudo em dia!':'Nenhuma pergunta respondida encontrada.'}</p></div>`;
      return;
    }

    wrap.innerHTML = data.questions.map(q => `
      <div class="question-card ${q.answer ? 'answered' : ''}" id="q-${q.id}">
        <div class="question-header">
          <div style="flex:1">
            ${q.item_title ? `<div class="question-item">📦 ${q.item_title}</div>` : ''}
            <div class="question-text">"${q.text}"</div>
            <div class="question-meta">👤 ${q.from?.nickname || 'Comprador'} · 📅 ${fmt.dt(q.date)}</div>
          </div>
          ${badge({ UNANSWERED: { label: 'Pendente', cls: 'badge-yellow' }, ANSWERED: { label: 'Respondida', cls: 'badge-green' } }, q.status)}
        </div>
        ${q.answer
          ? `<div class="answer-text">✅ <strong>Sua resposta:</strong> ${q.answer.text}</div>`
          : `<div class="answer-form">
              <textarea class="answer-textarea" id="ans-${q.id}" placeholder="Digite sua resposta aqui..." rows="3"></textarea>
              <div style="display:flex;justify-content:flex-end;margin-top:8px">
                <button class="btn btn-primary btn-sm" onclick="sendAnswer(${q.id})">✉️ Responder</button>
              </div>
             </div>`}
      </div>
    `).join('') + paginationHtml(questionsState.offset, questionsState.limit, data.paging?.total || data.questions.length, 'questionsPage');
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`;
  }
}

window.sendAnswer = async (qid) => {
  const ta = document.getElementById(`ans-${qid}`);
  const text = ta?.value?.trim();
  if (!text) { toast('Escreva uma resposta antes de enviar.', 'error'); return; }
  const btn = ta.nextElementSibling?.querySelector('button');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
  try {
    await API.answer(qid, text, State.currentStore);
    toast('Resposta enviada!', 'success');
    document.getElementById(`q-${qid}`).classList.add('answered');
    ta.parentElement.innerHTML = `<div class="answer-text">✅ <strong>Sua resposta:</strong> ${text}</div>`;
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✉️ Responder'; }
  }
};

window.questionsPage = (offset) => {
  questionsState.offset = offset;
  loadQuestions();
};

// ============================================================
// PAGE: MESSAGES
// ============================================================
async function renderMessages() {
  setContent(`
    <div class="page-header">
      <div>
        <div class="page-title">Mensagens</div>
        <div class="page-subtitle">Comunicação pós-venda com compradores</div>
      </div>
    </div>
    <div class="card">
      <div style="text-align:center;padding:32px 0">
        <div style="font-size:48px;margin-bottom:16px">💬</div>
        <h3 style="margin-bottom:8px">Mensagens por Pedido</h3>
        <p style="color:var(--text-2);font-size:14px;max-width:380px;margin:0 auto 20px">
          As mensagens são organizadas por pedido. Acesse um pedido e clique em "Ver mensagens" para se comunicar com o comprador.
        </p>
        <button class="btn btn-primary" onclick="navigate('orders')">🛒 Ir para Pedidos</button>
      </div>
    </div>
  `);
}

window.showMessages = async (packId) => {
  navigate('messages');
  const wrap = document.getElementById('content');
  wrap.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Mensagens</div><div class="page-subtitle">Pack #${packId}</div></div>
      <button class="btn btn-secondary" onclick="navigate('orders')">← Voltar para Pedidos</button>
    </div>
    <div class="card" id="msgCard"><div class="loading-state"><div class="spinner"></div></div></div>
  `;
  try {
    const data = await API.messages(State.currentStore, packId);
    const msgs = data.messages || [];
    const card = document.getElementById('msgCard');
    card.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;max-height:500px;overflow-y:auto;padding-bottom:16px">
        ${msgs.length ? msgs.map(m => {
          const mine = String(m.from?.user_id) === State.currentStore;
          return `
            <div style="display:flex;justify-content:${mine?'flex-end':'flex-start'}">
              <div style="max-width:70%;background:${mine?'var(--yellow)':'var(--bg)'};color:${mine?'var(--navy)':'var(--text)'};padding:10px 14px;border-radius:12px;font-size:14px">
                <div>${m.text?.plain || '-'}</div>
                <div style="font-size:11px;opacity:0.6;margin-top:4px">${fmt.dt(m.message_date?.received)}</div>
              </div>
            </div>
          `;
        }).join('') : '<div class="empty-state"><div class="empty-state-icon">💬</div><h3>Sem mensagens</h3></div>'}
      </div>
      <div style="border-top:1px solid var(--border);padding-top:16px;display:flex;gap:10px">
        <input type="text" id="msgInput" class="form-control" placeholder="Digite sua mensagem..." style="flex:1">
        <button class="btn btn-primary" onclick="sendMessage('${packId}')">Enviar ✉️</button>
      </div>
    `;
  } catch (e) {
    document.getElementById('msgCard').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`;
  }
};

window.sendMessage = async (packId) => {
  const inp  = document.getElementById('msgInput');
  const text = inp?.value?.trim();
  if (!text) return;
  try {
    await API.sendMsg(State.currentStore, packId, text);
    toast('Mensagem enviada!', 'success');
    inp.value = '';
    await showMessages(packId);
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ============================================================
// PAGE: METRICS
// ============================================================
let metricsDays = 30;

async function renderMetrics() {
  setContent(`
    <div class="page-header">
      <div>
        <div class="page-title">Métricas & Analytics</div>
        <div class="page-subtitle">Análise de desempenho e tendências</div>
      </div>
    </div>
    <div class="metrics-period">
      ${[7, 30, 60, 90].map(d => `<button class="period-btn ${metricsDays===d?'active':''}" onclick="setMetricsDays(${d})">${d} dias</button>`).join('')}
      <button class="period-btn ${metricsDays==='all'?'active':''}" onclick="setMetricsDays('all')">Tudo</button>
    </div>
    <div id="metricsBody"><div class="loading-state"><div class="spinner"></div></div></div>
  `);
  await loadMetrics();
}

window.setMetricsDays = async (days) => {
  metricsDays = days;
  document.querySelectorAll('.period-btn').forEach(b => {
    const label = b.textContent.trim();
    b.classList.toggle('active', label === (days === 'all' ? 'Tudo' : `${days} dias`));
  });
  await loadMetrics();
};

async function loadMetrics() {
  const wrap = document.getElementById('metricsBody');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Analisando dados...</p></div>';

  try {
    const data = await API.metrics(State.currentStore, metricsDays);
    const { summary, dailyChart, topProducts } = data;
    const periodoLabel = metricsDays === 'all' ? 'Todo o histórico' : `Últimos ${metricsDays} dias`;
    const fromLabel = summary.fromDate ? ` (a partir de ${new Date(summary.fromDate).toLocaleDateString('pt-BR')})` : '';

    wrap.innerHTML = `
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">
        ${kpiCard('Receita Total', fmt.brl(summary.totalRevenue), periodoLabel + fromLabel, '💰', '#FFE600')}
        ${kpiCard('Total de Pedidos', fmt.num(summary.totalOrders), periodoLabel, '🛒', '#10b981')}
        ${kpiCard('Ticket Médio', fmt.brl(summary.avgTicket), 'Por pedido', '📊', '#8b5cf6')}
      </div>

      <div class="chart-grid" style="margin-top:16px">
        <div class="card">
          <div class="card-title">📈 Receita Diária</div>
          <div class="chart-container">
            <canvas id="metricsRevenueChart"></canvas>
          </div>
        </div>
        <div class="card">
          <div class="card-title">📦 Pedidos Diários</div>
          <div class="chart-container">
            <canvas id="metricsOrdersChart"></canvas>
          </div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-title">🏆 Top 10 Produtos por Receita</div>
        <div class="table-wrap">
          <table class="top-products-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Produto</th>
                <th class="text-right">Unidades</th>
                <th class="text-right">Receita</th>
                <th style="width:160px">Participação</th>
              </tr>
            </thead>
            <tbody>
              ${topProducts.map((p, i) => {
                const pct = summary.totalRevenue > 0 ? (p.revenue / summary.totalRevenue * 100) : 0;
                return `
                  <tr>
                    <td style="color:var(--text-3);font-weight:700">${i + 1}</td>
                    <td><div style="font-size:13px;font-weight:600">${p.title || p.id}</div></td>
                    <td class="text-right">${fmt.num(p.units)}</td>
                    <td class="text-right fw-bold">${fmt.brl(p.revenue)}</td>
                    <td>
                      <div style="display:flex;align-items:center;gap:8px">
                        <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                          <div style="width:${pct.toFixed(1)}%;height:100%;background:var(--yellow);border-radius:3px"></div>
                        </div>
                        <span style="font-size:12px;color:var(--text-2);white-space:nowrap">${pct.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Revenue chart
    const rCtx = document.getElementById('metricsRevenueChart').getContext('2d');
    State.charts.mRevenue = new Chart(rCtx, {
      type: 'bar',
      data: {
        labels: dailyChart.map(d => {
          const dt = new Date(d.date + 'T12:00:00');
          return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        }),
        datasets: [{
          label: 'Receita (R$)',
          data: dailyChart.map(d => d.revenue),
          backgroundColor: 'rgba(255,230,0,0.8)',
          borderColor: '#FFE600',
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
          y: {
            grid: { color: '#f0f2f8' },
            ticks: {
              font: { size: 10 },
              callback: v => 'R$ ' + Intl.NumberFormat('pt-BR', { notation: 'compact' }).format(v),
            },
          },
        },
      },
    });

    // Orders chart
    const oCtx = document.getElementById('metricsOrdersChart').getContext('2d');
    State.charts.mOrders = new Chart(oCtx, {
      type: 'line',
      data: {
        labels: dailyChart.map(d => {
          const dt = new Date(d.date + 'T12:00:00');
          return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        }),
        datasets: [{
          label: 'Pedidos',
          data: dailyChart.map(d => d.orders),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.1)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
          y: { grid: { color: '#f0f2f8' }, ticks: { font: { size: 10 }, stepSize: 1 } },
        },
      },
    });
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`;
  }
}

// ============================================================
// PAGE: STORES
// ============================================================
async function renderStores() {
  loading();
  try {
    const { stores } = await API.stores();
    State.stores = stores;
    buildStoreSelector();

    setContent(`
      <div class="page-header">
        <div>
          <div class="page-title">Lojas Conectadas</div>
          <div class="page-subtitle">Gerencie as contas do Mercado Livre integradas</div>
        </div>
      </div>
      <div class="store-cards">
        ${stores.map(s => `
          <div class="store-card">
            <div class="store-card-avatar">
              ${s.thumbnail ? `<img src="${s.thumbnail}" alt="${s.nickname}">` : s.nickname[0].toUpperCase()}
            </div>
            <div class="store-card-info">
              <div class="store-card-name">${s.nickname}</div>
              <div class="store-card-id">ID: ${s.id}</div>
              ${s.email ? `<div class="store-card-id">${s.email}</div>` : ''}
            </div>
            ${stores.length > 1 ? `<button class="btn btn-danger btn-sm btn-icon" title="Desconectar" onclick="disconnectStore('${s.id}','${s.nickname}')">🗑</button>` : ''}
          </div>
        `).join('')}
        <a href="/ml/connect" class="add-store-card">
          <span style="font-size:24px">+</span>
          <span>Adicionar nova loja</span>
        </a>
      </div>

      <div class="card mt-24">
        <div class="card-title">⚙️ Configurações do App</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:4px">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:4px">App ID</div>
            <div style="font-family:monospace;font-size:14px;background:var(--bg);padding:8px 12px;border-radius:var(--radius-sm)">886699420287362</div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:4px">Redirect URI</div>
            <div style="font-family:monospace;font-size:13px;background:var(--bg);padding:8px 12px;border-radius:var(--radius-sm);word-break:break-all">https://multimixvendas.duckdns.org/ml/callback</div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:4px">Webhook URL</div>
            <div style="font-family:monospace;font-size:13px;background:var(--bg);padding:8px 12px;border-radius:var(--radius-sm);word-break:break-all">https://multimixvendas.duckdns.org/ml/webhook</div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:4px">Lojas ativas</div>
            <div style="font-size:22px;font-weight:800;color:var(--text)">${stores.length}</div>
          </div>
        </div>
      </div>
    `);
  } catch (e) {
    setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`);
  }
}

window.disconnectStore = (id, name) => {
  Modal.open('Desconectar Loja', `
    <p style="font-size:15px;color:var(--text)">Tem certeza que deseja desconectar a loja <strong>${name}</strong>?</p>
    <p style="font-size:13px;color:var(--text-2);margin-top:8px">Você poderá reconectar a qualquer momento.</p>
  `, `
    <button class="btn btn-secondary" onclick="Modal.close()">Cancelar</button>
    <button class="btn btn-danger" onclick="confirmDisconnect('${id}')">Desconectar</button>
  `);
};

window.confirmDisconnect = async (id) => {
  try {
    await API.removeStore(id);
    toast('Loja desconectada.', 'success');
    Modal.close();
    if (id === State.currentStore) {
      location.href = '/login';
    } else {
      await renderStores();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ============================================================
// PAGINATION HELPER
// ============================================================
function paginationHtml(offset, limit, total, callbackFn) {
  if (total <= limit) return '';
  const current = Math.floor(offset / limit);
  const pages   = Math.ceil(total / limit);
  const start   = offset + 1;
  const end     = Math.min(offset + limit, total);

  let btns = '';
  const showAround = 2;
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || (i >= current - showAround && i <= current + showAround)) {
      btns += `<button class="page-btn ${i === current ? 'active' : ''}" onclick="${callbackFn}(${i * limit})">${i + 1}</button>`;
    } else if (i === current - showAround - 1 || i === current + showAround + 1) {
      btns += `<span style="padding:0 4px;color:var(--text-3)">…</span>`;
    }
  }

  return `
    <div class="pagination">
      <div class="pagination-info">Mostrando ${fmt.num(start)}–${fmt.num(end)} de ${fmt.num(total)}</div>
      <div class="pagination-btns">
        <button class="page-btn" ${current === 0 ? 'disabled' : ''} onclick="${callbackFn}(${(current - 1) * limit})">‹</button>
        ${btns}
        <button class="page-btn" ${current === pages - 1 ? 'disabled' : ''} onclick="${callbackFn}(${(current + 1) * limit})">›</button>
      </div>
    </div>
  `;
}

// ============================================================
// PAGE: HORÁRIOS DE VENDA
// ============================================================
let hourlyDays = 7;

async function renderHourly() {
  loading();
  try {
    const data = await API.get(`/api/analytics/hourly?storeId=${State.currentStore}&days=${hourlyDays}`);
    const { byHour, bestHours, totalOrders, totalRevenue, days } = data;

    const maxOrders = Math.max(...byHour.map(h => h.orders), 1);

    function barColor(pct) {
      if (pct === 0)       return '#e5e7eb';
      if (pct <= 0.20)     return '#fefce8';
      if (pct <= 0.40)     return '#fef08a';
      if (pct <= 0.60)     return '#facc15';
      if (pct <= 0.80)     return '#f97316';
      return '#ef4444';
    }

    const periodOptions = [1,3,5,7,10,15,21,30];

    const html = `
      <div class="page-header">
        <div>
          <div class="page-title">Horários de Venda</div>
          <div class="page-subtitle">Distribuição de pedidos por hora do dia (Brasil UTC-3)</div>
        </div>
      </div>

      <div class="period-selector">
        ${periodOptions.map(d => `
          <label class="period-btn ${d === hourlyDays ? 'active' : ''}">
            <input type="radio" name="hourlyDays" value="${d}" ${d === hourlyDays ? 'checked' : ''}> ${d}d
          </label>
        `).join('')}
      </div>

      <div class="card mt-16">
        <div class="card-title">📊 Mapa de Calor — Pedidos por Hora</div>
        <div class="table-wrap">
          <table class="heatmap-table">
            <thead><tr><th>Hora</th><th>Distribuição</th><th>Pedidos</th><th>Faturamento</th></tr></thead>
            <tbody>
              ${byHour.map(h => {
                const pct = h.orders / maxOrders;
                const barW = Math.round(pct * 100);
                const color = barColor(pct);
                return `
                  <tr>
                    <td style="font-weight:600;white-space:nowrap">${String(h.hour).padStart(2,'0')}h</td>
                    <td>
                      <div class="heatmap-bar-wrap">
                        <div class="heatmap-bar" style="width:${barW}%;background:${color}"></div>
                      </div>
                    </td>
                    <td>${h.orders}</td>
                    <td>${fmt.brl(h.revenue)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-title">⭐ Melhores Horários</div>
        <div class="best-hours-grid">
          ${bestHours.map((h, idx) => `
            <div class="kpi-card" style="--kpi-color:${idx === 0 ? '#FFE600' : idx === 1 ? '#f97316' : '#6366f1'}">
              <div class="kpi-icon">${idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</div>
              <div class="kpi-label">${String(h.hour).padStart(2,'0')}h – ${String(h.hour+1).padStart(2,'0')}h</div>
              <div class="kpi-value">${h.orders} pedidos</div>
              <div class="kpi-sub">${fmt.brl(h.revenue)} · ticket ${fmt.brl(h.avgTicket)}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-title">📈 Pedidos por Hora</div>
        <div class="chart-container">
          <canvas id="hourlyChart"></canvas>
        </div>
      </div>
    `;

    setContent(html);

    // Period selector event
    document.querySelectorAll('input[name="hourlyDays"]').forEach(el => {
      el.addEventListener('change', () => {
        hourlyDays = parseInt(el.value);
        renderHourly();
      });
    });

    // Chart
    const ctx = document.getElementById('hourlyChart').getContext('2d');
    State.charts.hourly = new Chart(ctx, {
      type: 'line',
      data: {
        labels: byHour.map(h => `${String(h.hour).padStart(2,'0')}h`),
        datasets: [{
          label: 'Pedidos',
          data: byHour.map(h => h.orders),
          borderColor: '#FFE600',
          backgroundColor: 'rgba(255,230,0,0.12)',
          borderWidth: 2.5,
          pointRadius: 3,
          fill: true,
          tension: 0.4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: '#f0f2f8' }, beginAtZero: true, ticks: { stepSize: 1 } },
        },
      },
    });

  } catch (e) {
    setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`);
  }
}

// ============================================================
// PAGE: DIAS DA SEMANA
// ============================================================
let weekdayDays = 30;

async function renderWeekday() {
  loading();
  try {
    const data = await API.get(`/api/analytics/weekday?storeId=${State.currentStore}&days=${weekdayDays}`);
    const { byDay, bestDay, avgOrdersPerDay, days } = data;
    const periodOptions = [7, 15, 30, 60];

    const html = `
      <div class="page-header">
        <div>
          <div class="page-title">Dias da Semana</div>
          <div class="page-subtitle">Análise de vendas por dia da semana</div>
        </div>
      </div>

      <div class="period-selector">
        ${periodOptions.map(d => `
          <label class="period-btn ${d === weekdayDays ? 'active' : ''}">
            <input type="radio" name="weekdayDays" value="${d}" ${d === weekdayDays ? 'checked' : ''}> ${d}d
          </label>
        `).join('')}
      </div>

      <div class="weekday-grid mt-16">
        ${byDay.map(d => `
          <div class="weekday-card ${d.day === bestDay.day ? 'best' : ''}">
            ${d.day === bestDay.day ? '<div class="weekday-best-label">Melhor dia</div>' : ''}
            <div class="weekday-name">${d.name}</div>
            <div class="weekday-orders">${d.orders}</div>
            <div class="weekday-label">pedidos</div>
            <div class="weekday-revenue">${fmt.brl(d.revenue)}</div>
            <div class="weekday-ticket">ticket: ${fmt.brl(d.avgTicket)}</div>
          </div>
        `).join('')}
      </div>

      ${bestDay ? `
      <div class="card mt-16">
        <div class="card-title">🏆 Melhor Dia</div>
        <div style="display:flex;align-items:center;gap:24px;padding:8px 0">
          <div style="font-size:48px;font-weight:900;color:var(--yellow)">${bestDay.name}</div>
          <div>
            <div style="font-size:13px;color:var(--text-2)">Pedidos totais no período</div>
            <div style="font-size:28px;font-weight:800">${bestDay.orders}</div>
            <div style="font-size:13px;color:var(--text-2);margin-top:4px">
              ${avgOrdersPerDay > 0 ? `${((bestDay.orders / days - avgOrdersPerDay / 7) / (avgOrdersPerDay / 7) * 100).toFixed(0)}% acima da média diária` : ''}
            </div>
          </div>
          <div style="margin-left:auto;text-align:right">
            <div style="font-size:13px;color:var(--text-2)">Faturamento</div>
            <div style="font-size:22px;font-weight:800">${fmt.brl(bestDay.revenue)}</div>
            <div style="font-size:13px;color:var(--text-2);margin-top:4px">Ticket médio: ${fmt.brl(bestDay.avgTicket)}</div>
          </div>
        </div>
      </div>` : ''}

      <div class="card mt-16">
        <div class="card-title">📊 Comparativo por Dia</div>
        <div class="chart-container">
          <canvas id="weekdayChart"></canvas>
        </div>
      </div>
    `;

    setContent(html);

    document.querySelectorAll('input[name="weekdayDays"]').forEach(el => {
      el.addEventListener('change', () => {
        weekdayDays = parseInt(el.value);
        renderWeekday();
      });
    });

    const ctx = document.getElementById('weekdayChart').getContext('2d');
    State.charts.weekday = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: byDay.map(d => d.name.slice(0,3)),
        datasets: [{
          label: 'Pedidos',
          data: byDay.map(d => d.orders),
          backgroundColor: byDay.map(d => d.day === bestDay.day ? '#FFE600' : 'rgba(255,230,0,0.3)'),
          borderColor: byDay.map(d => d.day === bestDay.day ? '#d4af00' : '#FFE600'),
          borderWidth: 1.5,
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: '#f0f2f8' }, beginAtZero: true },
        },
      },
    });

  } catch (e) {
    setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`);
  }
}

// ============================================================
// PAGE: RANKING DE PRODUTOS
// ============================================================
let productTab = 'ranking';
let productDays = 30;

async function renderProducts() {
  loading();
  try {
    const tabs = [
      { key: 'ranking',     label: 'Ranking'       },
      { key: 'trending',    label: 'Explodindo'    },
      { key: 'declining',   label: 'Caindo'        },
      { key: 'problematic', label: 'Problemáticos' },
    ];
    const dayOptions = productTab === 'trending' || productTab === 'declining'
      ? [14, 30, 60, 90] : [7, 15, 30, 60];

    const data = await API.get(`/api/analytics/products?storeId=${State.currentStore}&days=${productDays}&type=${productTab}`);
    const { products } = data;

    let tableHtml = '';
    if (productTab === 'ranking') {
      tableHtml = `
        <table>
          <thead><tr><th>#</th><th>Produto</th><th class="text-right">Pedidos</th><th class="text-right">Unidades</th><th class="text-right">Receita</th><th class="text-right">Ticket Médio</th></tr></thead>
          <tbody>
            ${products.length ? products.map((p, i) => `
              <tr>
                <td style="color:var(--text-3);font-weight:600">${i+1}</td>
                <td class="truncate" style="max-width:260px" title="${p.title}">${p.title}</td>
                <td class="text-right">${p.orders}</td>
                <td class="text-right">${p.units}</td>
                <td class="text-right fw-bold">${fmt.brl(p.revenue)}</td>
                <td class="text-right">${fmt.brl(p.avgTicket)}</td>
              </tr>
            `).join('') : '<tr><td colspan="6" class="text-center td-light" style="padding:32px">Nenhum produto encontrado.</td></tr>'}
          </tbody>
        </table>
      `;
    } else if (productTab === 'trending' || productTab === 'declining') {
      tableHtml = `
        <table>
          <thead><tr><th>Produto</th><th class="text-right">Últimos 7d</th><th class="text-right">Período anterior</th><th class="text-right">Variação</th></tr></thead>
          <tbody>
            ${products.length ? products.map(p => `
              <tr>
                <td class="truncate" style="max-width:300px" title="${p.title}">${p.title}</td>
                <td class="text-right">${p.recent7d} pedidos</td>
                <td class="text-right">${p.prevPeriod} pedidos</td>
                <td class="text-right">
                  <span class="badge ${p.variation >= 0 ? 'badge-green' : 'badge-red'}">
                    ${p.variation >= 0 ? '+' : ''}${p.variation.toFixed(1)}%
                  </span>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="4" class="text-center td-light" style="padding:32px">Nenhum produto encontrado.</td></tr>'}
          </tbody>
        </table>
      `;
    } else if (productTab === 'problematic') {
      tableHtml = `
        <table>
          <thead><tr><th>ID do Produto</th><th class="text-right">Dias sem vender</th></tr></thead>
          <tbody>
            ${products.length ? products.map(p => `
              <tr>
                <td style="font-family:monospace;font-size:13px">${p.id}</td>
                <td class="text-right">
                  <span class="badge badge-red">${p.daysSinceLastSale}+ dias</span>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="2" class="text-center td-light" style="padding:32px">Nenhum produto problemático encontrado.</td></tr>'}
          </tbody>
        </table>
      `;
    }

    const html = `
      <div class="page-header">
        <div>
          <div class="page-title">Ranking de Produtos</div>
          <div class="page-subtitle">Análise de desempenho por produto</div>
        </div>
      </div>

      <div class="analytics-tabs">
        ${tabs.map(t => `
          <button class="analytics-tab ${t.key === productTab ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>
        `).join('')}
      </div>

      <div class="period-selector mt-12">
        ${dayOptions.map(d => `
          <label class="period-btn ${d === productDays ? 'active' : ''}">
            <input type="radio" name="productDays" value="${d}" ${d === productDays ? 'checked' : ''}> ${d}d
          </label>
        `).join('')}
      </div>

      <div class="card mt-16">
        <div class="card-title">
          ${tabs.find(t => t.key === productTab)?.label} — ${products.length} produto${products.length !== 1 ? 's' : ''}
        </div>
        <div class="table-wrap">
          ${tableHtml}
        </div>
      </div>
    `;

    setContent(html);

    document.querySelectorAll('.analytics-tab').forEach(el => {
      el.addEventListener('click', () => {
        productTab = el.dataset.tab;
        productDays = productTab === 'trending' || productTab === 'declining' ? 30 : 30;
        renderProducts();
      });
    });

    document.querySelectorAll('input[name="productDays"]').forEach(el => {
      el.addEventListener('change', () => {
        productDays = parseInt(el.value);
        renderProducts();
      });
    });

  } catch (e) {
    setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`);
  }
}

// ============================================================
// PAGE: PERFORMANCE DE ANÚNCIOS
// ============================================================
let perfData = null;
let perfSortCol = null;
let perfSortDir = 'desc';

async function renderPerformance() {
  State.performancePeriod = State.performancePeriod || '7d';
  State.performanceSort   = State.performanceSort   || 'visits';

  loading();
  try {
    const period = State.performancePeriod;
    const search = State.performanceSearch || '';
    const url = `/api/performance?storeId=${State.currentStore}&period=${period}&sort=${State.performanceSort}&order=${perfSortDir}&search=${encodeURIComponent(search)}`;
    const data = await API.get(url);
    perfData = data;

    const { items, summary, alerts, dateFrom, dateTo, dataGap } = data;
    const periodLabels = { yesterday: 'Ontem', '3d': '3 dias', '7d': '7 dias', '15d': '15 dias', '30d': '30 dias' };
    const periodKeys   = ['yesterday', '3d', '7d', '15d', '30d'];

    const noVisitsData = summary.totalVisits === 0;

    const html = `
      <div class="page-header">
        <div>
          <div class="page-title">Performance de Anúncios</div>
          <div class="page-subtitle">Visitas, conversão e receita por anúncio</div>
        </div>
      </div>

      <div class="period-selector" style="margin-bottom:20px">
        ${periodKeys.map(k => `<button class="period-btn ${k === period ? 'active' : ''}" onclick="setPerfPeriod('${k}')">${periodLabels[k]}</button>`).join('')}
      </div>

      <div class="performance-summary">
        ${perfSummaryCard('👁️', fmt.num(summary.totalVisits), 'Total Visitas')}
        ${perfSummaryCard('🛒', fmt.num(summary.totalSales), 'Total Vendas')}
        ${perfSummaryCard('📊', fmt.pct(summary.avgConversion), 'Conversão Média')}
        ${perfSummaryCard('💰', fmt.brl(summary.totalRevenue), 'Receita Total')}
        ${perfSummaryCard('🎫', fmt.brl(summary.avgTicket), 'Ticket Médio')}
        ${perfSummaryCard('💡', fmt.brl(summary.revenuePerVisit), 'Receita/Visita')}
        ${perfSummaryCard('📦', fmt.num(summary.totalItems), 'Anúncios')}
      </div>

      ${alerts.length ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between" onclick="toggleAlerts()">
          ⚠️ Alertas Inteligentes <span style="font-size:12px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:12px">${alerts.length}</span>
          <span id="alertToggleIcon" style="font-size:12px;color:var(--text-3)">▼</span>
        </div>
        <div id="alertsBody">
          ${alerts.map(a => `
            <div class="alert-card ${a.type}">
              <span>${a.type === 'danger' ? '🔴' : a.type === 'warning' ? '🟡' : '🟢'}</span>
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--text)">${a.title}</div>
                <div style="font-size:12px;color:var(--text-2);margin-top:2px">${a.msg}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      <div class="analytics-tabs" style="margin-bottom:4px">
        ${[
          { key: 'visits',      label: 'Mais Visitados',    sort: 'visits',     order: 'desc' },
          { key: 'visits-asc',  label: 'Menos Visitados',   sort: 'visits',     order: 'asc'  },
          { key: 'conv-desc',   label: 'Maior Conversão',   sort: 'conversion', order: 'desc' },
          { key: 'conv-asc',    label: 'Menor Conversão',   sort: 'conversion', order: 'asc'  },
          { key: 'rev-desc',    label: 'Maior Receita',     sort: 'revenue',    order: 'desc' },
          { key: 'rev-asc',     label: 'Menor Receita',     sort: 'revenue',    order: 'asc'  },
          { key: 'sales-desc',  label: 'Mais Vendidos',     sort: 'sales',      order: 'desc' },
          { key: 'growth-desc', label: 'Crescimento',       sort: 'growth',     order: 'desc' },
          { key: 'growth-asc',  label: 'Queda',             sort: 'growth',     order: 'asc'  },
        ].map(t => `<button class="analytics-tab" data-sort="${t.sort}" data-order="${t.order}" onclick="setPerfRanking('${t.sort}','${t.order}')">${t.label}</button>`).join('')}
      </div>

      ${noVisitsData ? `<div class="card" style="margin-bottom:16px"><div class="empty-state" style="padding:40px"><div class="empty-state-icon">⏳</div><h3>Aguardando sincronização dos dados...</h3><p>Clique em "⟳ Sync" para sincronizar visitas do Mercado Livre.</p></div></div>` : `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div class="card-title">🔵 Mapa de Quadrantes (Visitas × Conversão)</div>
          <div class="scatter-container">
            <canvas id="scatterChart"></canvas>
          </div>
          <div class="quadrant-legend">
            <span class="ql-item ql-green">Q1: Alta visita + Alta conv.</span>
            <span class="ql-item ql-blue">Q2: Baixa visita + Alta conv.</span>
            <span class="ql-item ql-red">Q3: Alta visita + Baixa conv.</span>
            <span class="ql-item ql-gray">Q4: Baixa visita + Baixa conv.</span>
          </div>
        </div>
        <div class="card">
          <div class="card-title">📊 Top 20 por Visitas</div>
          <div class="chart-container">
            <canvas id="visitsBarChart"></canvas>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">🎯 Top 20 por Conversão</div>
        <div class="chart-container">
          <canvas id="convBarChart"></canvas>
        </div>
      </div>
      `}

      <div class="card">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
          <div class="card-title" style="margin-bottom:0">📋 Todos os Anúncios</div>
          <span style="font-size:11px;background:#dbeafe;color:#1e40af;padding:3px 8px;border-radius:8px">Visitas: ${dateFrom} a ${dateTo}</span>
          ${dataGap ? `<span style="font-size:11px;background:#fef3c7;color:#92400e;padding:3px 8px;border-radius:8px" title="Pedidos desatualizados — clique em Sync para atualizar">⚠ Vendas: ${data.ordersDateFrom} a ${data.ordersDateTo}</span>` : `<span style="font-size:11px;background:#d1fae5;color:#065f46;padding:3px 8px;border-radius:8px">Vendas: ${data.ordersDateFrom} a ${data.ordersDateTo}</span>`}
          <div class="search-wrap" style="max-width:280px">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="perfSearch" placeholder="Buscar por título ou ID..." value="${State.performanceSearch || ''}" oninput="setPerfSearch(this.value)">
          </div>
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn-outline" onclick="downloadPerfCSV()" title="Exportar CSV" style="font-size:12px;padding:5px 10px">⬇ CSV</button>
            <button class="btn-outline" onclick="downloadPerfPDF()" title="Imprimir/PDF" style="font-size:12px;padding:5px 10px">🖨 PDF</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="perf-table">
            <thead>
              <tr>
                <th style="width:50px"></th>
                <th onclick="sortPerfTable('title')" style="cursor:pointer">Título ${perfSortCol==='title'?'↕':''}</th>
                <th class="text-right" onclick="sortPerfTable('visits')" style="cursor:pointer">Visitas ${perfSortCol==='visits'?'↕':''}</th>
                <th class="text-right" onclick="sortPerfTable('sales')" style="cursor:pointer">Vendas ${perfSortCol==='sales'?'↕':''}</th>
                <th class="text-right" onclick="sortPerfTable('conversion')" style="cursor:pointer">Conversão ${perfSortCol==='conversion'?'↕':''}</th>
                <th class="text-right" onclick="sortPerfTable('revenue')" style="cursor:pointer">Receita ${perfSortCol==='revenue'?'↕':''}</th>
                <th class="text-right" onclick="sortPerfTable('avgTicket')" style="cursor:pointer">Ticket Médio ${perfSortCol==='avgTicket'?'↕':''}</th>
                <th class="text-right">R$/Visita</th>
                <th class="text-right">Vis./Venda</th>
                <th class="text-right">Estoque</th>
                <th>Status</th>
                <th class="text-right" onclick="sortPerfTable('visitGrowth')" style="cursor:pointer">Tendência ${perfSortCol==='visitGrowth'?'↕':''}</th>
              </tr>
            </thead>
            <tbody>
              ${items.length ? items.map(item => {
                const avgC = item.avgConversion;
                let convCls = '';
                if (item.visits > 10) {
                  if (item.conversion >= avgC * 1.2) convCls = 'conv-high';
                  else if (item.conversion >= avgC * 0.8) convCls = 'conv-mid';
                  else convCls = 'conv-low';
                }
                const trendPct = item.visitGrowth;
                const trendCls = trendPct > 0 ? 'trend-up' : trendPct < 0 ? 'trend-down' : '';
                const trendArrow = trendPct > 0 ? '↑' : trendPct < 0 ? '↓' : '→';
                return `
                  <tr>
                    <td>${item.thumbnail ? `<img src="${item.thumbnail}" style="width:40px;height:40px;object-fit:contain;border-radius:6px;border:1px solid var(--border)">` : '<div style="width:40px;height:40px;background:var(--bg);border-radius:6px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center">📦</div>'}</td>
                    <td class="truncate" style="max-width:220px" title="${item.title}"><div style="font-size:13px;font-weight:600">${item.title}</div><div style="font-size:11px;color:var(--text-3)">${item.id}</div></td>
                    <td class="text-right fw-bold">${fmt.num(item.visits)}</td>
                    <td class="text-right">${fmt.num(item.sales)}</td>
                    <td class="text-right"><span class="${convCls}">${fmt.pct(item.conversion)}</span></td>
                    <td class="text-right fw-bold">${fmt.brl(item.revenue)}</td>
                    <td class="text-right">${fmt.brl(item.avgTicket)}</td>
                    <td class="text-right td-light">${fmt.brl(item.revenuePerVisit)}</td>
                    <td class="text-right td-light">${item.visitsPerSale > 0 ? fmt.num(Math.round(item.visitsPerSale)) : '-'}</td>
                    <td class="text-right">${fmt.num(item.available_quantity)}</td>
                    <td>${badge(STATUS_LISTING, item.status)}</td>
                    <td class="text-right"><span class="${trendCls}" style="font-weight:700;font-size:13px">${trendArrow} ${Math.abs(trendPct).toFixed(0)}%</span></td>
                  </tr>
                `;
              }).join('') : '<tr><td colspan="12" class="text-center td-light" style="padding:32px">Nenhum anúncio encontrado.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    setContent(html);

    if (!noVisitsData) {
      // Scatter chart
      const scatterItems = items.filter(i => i.visits > 0 || i.sales > 0);
      const medVisits = median(scatterItems.map(i => i.visits));
      const medConv   = median(scatterItems.map(i => i.conversion));

      const q1 = [], q2 = [], q3 = [], q4 = [];
      scatterItems.forEach(i => {
        const pt = { x: i.visits, y: parseFloat(i.conversion.toFixed(2)), label: i.title };
        if (i.visits >= medVisits && i.conversion >= medConv) q1.push(pt);
        else if (i.visits < medVisits && i.conversion >= medConv) q2.push(pt);
        else if (i.visits >= medVisits && i.conversion < medConv) q3.push(pt);
        else q4.push(pt);
      });

      const sCtx = document.getElementById('scatterChart').getContext('2d');
      State.charts.scatter = new Chart(sCtx, {
        type: 'scatter',
        data: {
          datasets: [
            { label: 'Q1: Alta vis.+conv.', data: q1, backgroundColor: 'rgba(16,185,129,0.7)', pointRadius: 6, pointHoverRadius: 8 },
            { label: 'Q2: Baixa vis.+Alta conv.', data: q2, backgroundColor: 'rgba(59,130,246,0.7)', pointRadius: 6, pointHoverRadius: 8 },
            { label: 'Q3: Alta vis.+Baixa conv.', data: q3, backgroundColor: 'rgba(239,68,68,0.7)', pointRadius: 6, pointHoverRadius: 8 },
            { label: 'Q4: Baixa vis.+conv.', data: q4, backgroundColor: 'rgba(156,163,175,0.5)', pointRadius: 5, pointHoverRadius: 7 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: 'top', labels: { font: { size: 11 }, boxWidth: 10 } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const d = ctx.raw;
                  return `${d.label ? d.label.slice(0,40) : ''} | Vis: ${d.x} | Conv: ${d.y}%`;
                },
              },
            },
            annotation: undefined,
          },
          scales: {
            x: { title: { display: true, text: 'Visitas' }, grid: { color: '#f0f2f8' } },
            y: { title: { display: true, text: 'Conversão (%)' }, grid: { color: '#f0f2f8' }, beginAtZero: true },
          },
        },
      });

      // Visits bar chart
      const top20v = [...items].sort((a,b) => b.visits - a.visits).slice(0, 20);
      const vCtx = document.getElementById('visitsBarChart').getContext('2d');
      State.charts.visitsBar = new Chart(vCtx, {
        type: 'bar',
        data: {
          labels: top20v.map(i => i.title.slice(0, 20)),
          datasets: [{ label: 'Visitas', data: top20v.map(i => i.visits), backgroundColor: 'rgba(59,130,246,0.7)', borderRadius: 4 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#f0f2f8' } },
            y: { grid: { display: false }, ticks: { font: { size: 10 } } },
          },
        },
      });

      // Conversion bar chart
      const top20c = [...items].filter(i => i.visits > 5).sort((a,b) => b.conversion - a.conversion).slice(0, 20);
      const cCtx = document.getElementById('convBarChart').getContext('2d');
      State.charts.convBar = new Chart(cCtx, {
        type: 'bar',
        data: {
          labels: top20c.map(i => i.title.slice(0, 20)),
          datasets: [{ label: 'Conversão (%)', data: top20c.map(i => parseFloat(i.conversion.toFixed(2))), backgroundColor: 'rgba(16,185,129,0.7)', borderRadius: 4 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#f0f2f8' }, ticks: { callback: v => v + '%' } },
            y: { grid: { display: false }, ticks: { font: { size: 10 } } },
          },
        },
      });
    }

  } catch (e) {
    setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro ao carregar performance</h3><p>${e.message}</p></div>`);
  }
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function perfSummaryCard(icon, value, label) {
  return `
    <div class="perf-card">
      <div class="perf-card-icon">${icon}</div>
      <div class="perf-card-value">${value}</div>
      <div class="perf-card-label">${label}</div>
    </div>
  `;
}

window.downloadPerfCSV = function() {
  if (!perfData || !perfData.items) return;
  const { items, dateFrom, dateTo } = perfData;
  const headers = ['ID','Título','Status','Visitas','Vendas','Conversão (%)','Receita (R$)','Ticket Médio (R$)','R$/Visita','Vis./Venda','Estoque','Tendência Visitas (%)'];
  const rows = items.map(i => [
    i.id, `"${(i.title||'').replace(/"/g,'""')}"`, i.status,
    i.visits, i.sales, i.conversion.toFixed(2),
    i.revenue.toFixed(2), i.avgTicket.toFixed(2),
    i.revenuePerVisit.toFixed(2),
    i.visitsPerSale > 0 ? i.visitsPerSale.toFixed(1) : '-',
    i.available_quantity, i.visitGrowth.toFixed(1)
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `performance_${dateFrom||''}_${dateTo||''}.csv`;
  a.click();
};

window.downloadPerfPDF = function() {
  if (!perfData || !perfData.items) return;
  const { items, summary, dateFrom, dateTo } = perfData;
  const rows = items.map(i => `
    <tr>
      <td>${i.id}</td>
      <td>${i.title || ''}</td>
      <td>${i.status}</td>
      <td>${i.visits}</td>
      <td>${i.sales}</td>
      <td>${i.conversion.toFixed(2)}%</td>
      <td>R$ ${i.revenue.toFixed(2)}</td>
      <td>R$ ${i.avgTicket.toFixed(2)}</td>
      <td>${i.available_quantity}</td>
      <td>${i.visitGrowth.toFixed(1)}%</td>
    </tr>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Performance ${dateFrom} a ${dateTo}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px}
      h1{font-size:16px;margin-bottom:4px}
      .sub{font-size:12px;color:#666;margin-bottom:16px}
      table{width:100%;border-collapse:collapse}
      th{background:#222;color:#fff;padding:6px 4px;text-align:left;font-size:10px}
      td{padding:5px 4px;border-bottom:1px solid #eee}
      tr:nth-child(even){background:#f9f9f9}
      .summary{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap}
      .kpi{background:#f3f4f6;padding:8px 12px;border-radius:6px}
      .kpi-label{font-size:10px;color:#666}
      .kpi-val{font-size:14px;font-weight:bold}
    </style></head><body>
    <h1>Performance de Anúncios</h1>
    <div class="sub">Período: ${dateFrom} a ${dateTo} — Gerado em ${new Date().toLocaleString('pt-BR')}</div>
    <div class="summary">
      <div class="kpi"><div class="kpi-label">Total Visitas</div><div class="kpi-val">${summary.totalVisits}</div></div>
      <div class="kpi"><div class="kpi-label">Total Vendas</div><div class="kpi-val">${summary.totalSales}</div></div>
      <div class="kpi"><div class="kpi-label">Receita Total</div><div class="kpi-val">R$ ${summary.totalRevenue.toFixed(2)}</div></div>
      <div class="kpi"><div class="kpi-label">Conversão Média</div><div class="kpi-val">${summary.avgConversion.toFixed(2)}%</div></div>
      <div class="kpi"><div class="kpi-label">Ticket Médio</div><div class="kpi-val">R$ ${summary.avgTicket.toFixed(2)}</div></div>
    </div>
    <table><thead><tr><th>ID</th><th>Título</th><th>Status</th><th>Visitas</th><th>Vendas</th><th>Conversão</th><th>Receita</th><th>Ticket Médio</th><th>Estoque</th><th>Tendência</th></tr></thead>
    <tbody>${rows}</tbody></table>
    </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
};

window.setPerfPeriod = (period) => {
  State.performancePeriod = period;
  renderPerformance();
};

window.setPerfSearch = (val) => {
  State.performanceSearch = val;
  clearTimeout(window._perfSearchTimer);
  window._perfSearchTimer = setTimeout(() => renderPerformance(), 400);
};

window.setPerfRanking = (sort, order) => {
  State.performanceSort = sort;
  perfSortDir = order;
  renderPerformance();
};

window.sortPerfTable = (col) => {
  if (perfSortCol === col) {
    perfSortDir = perfSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    perfSortCol = col;
    perfSortDir = 'desc';
  }
  State.performanceSort = col === 'title' ? 'visits' : col;
  renderPerformance();
};

window.toggleAlerts = () => {
  const body = document.getElementById('alertsBody');
  const icon = document.getElementById('alertToggleIcon');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  if (icon) icon.textContent = hidden ? '▼' : '▶';
};

// ============================================================
// PAGE: SCHEDULER
// ============================================================
async function renderScheduler() {
  loading();

  async function loadSchedulerData() {
    try {
      const data = await API.get('/api/scheduler/status');
      const { queue, currentJob, rateLimiter, avgDuration, recentJobs, pendingJobs, syncLogs, apiStats, recentApiLogs, config } = data;

      const jobStatusBadge = (s) => {
        const map = {
          pending:   { label: 'Pendente',   cls: 'badge-yellow' },
          running:   { label: 'Executando', cls: 'badge-blue'   },
          completed: { label: 'Concluído',  cls: 'badge-green'  },
          failed:    { label: 'Falha',      cls: 'badge-red'    },
        };
        const m = map[s] || { label: s, cls: 'badge-gray' };
        return `<span class="badge ${m.cls}">${m.label}</span>`;
      };

      const fmtTs = (ts) => ts ? new Date(ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
      const fmtMs = (ms) => ms != null ? `${ms}ms` : '-';

      const html = `
        <div class="page-header">
          <div>
            <div class="page-title">Job Scheduler</div>
            <div class="page-subtitle">Monitoramento da fila de sincronização</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="schedulerTrigger('sync_orders')">🛒 Sincronizar Pedidos</button>
            <button class="btn btn-secondary btn-sm" onclick="schedulerTrigger('sync_listings_batch')">📦 Sincronizar Anúncios</button>
            <button class="btn btn-secondary btn-sm" onclick="schedulerTrigger('sync_visits')">👁️ Sincronizar Visitas</button>
            <button class="btn btn-danger btn-sm" onclick="schedulerCleanup()">🗑 Limpar histórico</button>
          </div>
        </div>

        <div class="scheduler-grid">
          ${kpiCard('Pendentes', fmt.num(queue.pending), 'na fila', '⏳', '#f59e0b')}
          ${kpiCard('Em execução', fmt.num(queue.running), currentJob ? currentJob.type : 'nenhum', '⚙️', '#3b82f6')}
          ${kpiCard('Concluídos hoje', fmt.num(queue.completedToday), `${queue.retriesToday} retries`, '✅', '#10b981')}
          ${kpiCard('Erros hoje', fmt.num(queue.failedToday), 'falhas permanentes', '❌', queue.failedToday > 0 ? '#ef4444' : '#10b981')}
        </div>

        <div class="chart-grid" style="margin-top:16px">
          <div class="card rate-limiter-card">
            <div class="card-title">🚦 Rate Limiter</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:8px">
              <div>
                <div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:4px">Delay atual</div>
                <div style="font-size:22px;font-weight:800;color:${rateLimiter.currentDelay > 500 ? '#ef4444' : '#10b981'}">${rateLimiter.currentDelay}ms</div>
              </div>
              <div>
                <div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:4px">Chamadas/min</div>
                <div style="font-size:22px;font-weight:800">${rateLimiter.callsThisMinute} <span style="font-size:14px;color:var(--text-2)">/ ${config.maxCallsPerMinute}</span></div>
              </div>
              <div>
                <div style="font-size:11px;color:var(--text-2);font-weight:700;text-transform:uppercase;margin-bottom:4px">429 consecutivos</div>
                <div style="font-size:22px;font-weight:800;color:${rateLimiter.consecutive429 > 0 ? '#ef4444' : '#10b981'}">${rateLimiter.consecutive429}</div>
              </div>
            </div>
            ${apiStats ? `
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
              <div><div style="font-size:11px;color:var(--text-2)">Chamadas (1h)</div><div style="font-size:16px;font-weight:700">${apiStats.calls || 0}</div></div>
              <div><div style="font-size:11px;color:var(--text-2)">Tempo médio</div><div style="font-size:16px;font-weight:700">${Math.round(apiStats.avg_ms || 0)}ms</div></div>
              <div><div style="font-size:11px;color:var(--text-2)">Rate limits</div><div style="font-size:16px;font-weight:700;color:${(apiStats.rate_limits || 0) > 0 ? '#ef4444' : '#10b981'}">${apiStats.rate_limits || 0}</div></div>
            </div>` : ''}
          </div>

          <div class="card">
            <div class="card-title">📋 Última Sincronização por Entidade</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Loja</th><th>Entidade</th><th>Status</th><th>Última sync</th></tr></thead>
                <tbody>
                  ${syncLogs.length ? syncLogs.map(l => `
                    <tr>
                      <td style="font-size:12px;color:var(--text-2)">${l.store_id}</td>
                      <td style="font-weight:600">${l.entity}</td>
                      <td>${l.status === 'ok' ? '<span class="badge badge-green">OK</span>' : `<span class="badge badge-red">${l.status}</span>`}</td>
                      <td class="td-light" style="font-size:12px">${fmtTs(l.last_sync)}</td>
                    </tr>
                  `).join('') : '<tr><td colspan="4" class="text-center td-light" style="padding:20px">Nenhum registro ainda</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        ${pendingJobs.length ? `
        <div class="card" style="margin-top:16px">
          <div class="card-title">⏳ Próximos na Fila</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Tipo</th><th>Loja</th><th>Prioridade</th><th>Agendado para</th><th>Tentativas</th></tr></thead>
              <tbody>
                ${pendingJobs.map(j => `
                  <tr>
                    <td style="font-weight:600;font-family:monospace;font-size:13px">${j.type}</td>
                    <td style="color:var(--text-2)">${j.store_id}</td>
                    <td><span class="badge badge-blue">${j.priority}</span></td>
                    <td class="td-light" style="font-size:12px">${fmtTs(j.scheduled_at)}</td>
                    <td>${j.attempts}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}

        <div class="card" style="margin-top:16px">
          <div class="card-title">📜 Histórico de Execuções (últimas 20)</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Tipo</th><th>Loja</th><th>Status</th><th>Tentativas</th><th>Duração</th><th>Erro</th><th>Concluído em</th></tr></thead>
              <tbody>
                ${recentJobs.length ? recentJobs.map(j => `
                  <tr>
                    <td style="font-weight:600;font-family:monospace;font-size:12px">${j.type}</td>
                    <td style="color:var(--text-2);font-size:12px">${j.store_id}</td>
                    <td>${jobStatusBadge(j.status)}</td>
                    <td style="text-align:center">${j.attempts}</td>
                    <td class="td-light">${fmtMs(j.duration_ms)}</td>
                    <td style="font-size:11px;color:#ef4444;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${j.error || ''}">${j.error || ''}</td>
                    <td class="td-light" style="font-size:12px">${fmtTs(j.completed_at)}</td>
                  </tr>
                `).join('') : '<tr><td colspan="7" class="text-center td-light" style="padding:20px">Nenhum job executado ainda</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        ${recentApiLogs.length ? `
        <div class="card" style="margin-top:16px">
          <div class="card-title">🌐 Logs de API (últimas 10 chamadas)</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Endpoint</th><th>Status</th><th>Duração</th><th>RL Restante</th><th>Hora</th></tr></thead>
              <tbody>
                ${recentApiLogs.map(l => `
                  <tr>
                    <td style="font-family:monospace;font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${l.endpoint}">${l.endpoint}</td>
                    <td><span class="badge ${l.status_code === 200 ? 'badge-green' : l.status_code === 429 ? 'badge-red' : 'badge-yellow'}">${l.status_code}</span></td>
                    <td class="td-light">${fmtMs(l.duration_ms)}</td>
                    <td class="td-light">${l.rate_limit_remaining >= 0 ? l.rate_limit_remaining : '-'}</td>
                    <td class="td-light" style="font-size:11px">${fmtTs(l.logged_at)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}
      `;

      const wrap = document.getElementById('schedulerContent');
      if (wrap) {
        wrap.innerHTML = html;
      } else {
        setContent(`<div id="schedulerContent">${html}</div>`);
      }

    } catch (e) {
      setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro ao carregar scheduler</h3><p>${e.message}</p></div>`);
    }
  }

  setContent('<div id="schedulerContent"><div class="loading-state"><div class="spinner"></div><p>Carregando...</p></div></div>');
  await loadSchedulerData();

  // Auto-refresh every 10 seconds
  State.schedulerRefreshTimer = setInterval(loadSchedulerData, 10000);
}

window.schedulerTrigger = async (type) => {
  try {
    await API.post('/api/scheduler/trigger', { type, storeId: State.currentStore });
    toast(`Job "${type}" adicionado à fila!`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
};

window.schedulerCleanup = async () => {
  try {
    const result = await API.del('/api/scheduler/cleanup');
    toast(`${result.deleted || 0} jobs removidos do histórico.`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ============================================================
// PAGE: ADS (Mercado Ads)
// ============================================================
async function renderAds() {
  loading();
  const storeId = State.currentStore;
  let currentPeriod = 'yesterday';
  let currentDate = '';

  async function loadAds() {
    try {
      const params = currentDate
        ? `storeId=${storeId}&date=${currentDate}`
        : `storeId=${storeId}&period=${currentPeriod}`;
      const data = await API.get(`/api/ads/dashboard?${params}`);
      const { kpis, by_campaign, by_day, syncLog } = data;

      const hasData = by_campaign.length > 0 || by_day.length > 0;

      const periodBtns = ['today', 'yesterday', '7d', '15d', '30d'];
      const periodLabels = { today: 'Hoje', yesterday: 'Ontem', '7d': '7 dias', '15d': '15 dias', '30d': '30 dias' };

      function roasColor(v) {
        if (v >= 3) return 'color:#22c55e;font-weight:600';
        if (v >= 1) return 'color:#f59e0b;font-weight:600';
        return 'color:#ef4444;font-weight:600';
      }
      function acosColor(v) {
        if (v > 0 && v < 30) return 'color:#22c55e;font-weight:600';
        if (v <= 60) return 'color:#f59e0b;font-weight:600';
        return 'color:#ef4444;font-weight:600';
      }

      // Totals row for campaign table
      const totRow = by_campaign.reduce((acc, c) => {
        acc.spend += c.spend; acc.clicks += c.clicks; acc.impressions += c.impressions;
        acc.conversions += c.conversions; acc.attributed_revenue += c.attributed_revenue;
        return acc;
      }, { spend:0, clicks:0, impressions:0, conversions:0, attributed_revenue:0 });
      const totRoas = totRow.spend > 0 ? totRow.attributed_revenue / totRow.spend : 0;
      const totAcos = totRow.attributed_revenue > 0 ? (totRow.spend / totRow.attributed_revenue) * 100 : 0;
      const totCtr  = totRow.impressions > 0 ? (totRow.clicks / totRow.impressions) * 100 : 0;
      const totCpc  = totRow.clicks > 0 ? totRow.spend / totRow.clicks : 0;

      // Auto insights
      const insights = [];
      by_campaign.forEach(c => {
        if (c.roas > 5) insights.push({ type: 'success', msg: `<strong>${c.name}</strong> tem ROAS excelente (${c.roas.toFixed(2)}x). Considere aumentar o orçamento.` });
        if (c.acos > 60 && c.spend > 0) insights.push({ type: 'danger', msg: `<strong>${c.name}</strong> com ACOS elevado (${c.acos.toFixed(1)}%). Revise ou pause esta campanha.` });
        if (c.ctr < 0.5 && c.impressions > 100) insights.push({ type: 'warning', msg: `<strong>${c.name}</strong> com CTR baixo (${c.ctr.toFixed(2)}%). Revise o criativo do anúncio.` });
        if (c.conversions > 0 && c.cost_per_conversion !== undefined) {
          // use spend/conversions
          const cpconv = c.conversions > 0 ? c.spend / c.conversions : 0;
          if (cpconv > 50) insights.push({ type: 'warning', msg: `Custo por conversão alto em <strong>${c.name}</strong> (${fmt.brl(cpconv)}).` });
        }
      });
      if (insights.length === 0 && hasData) insights.push({ type: 'info', msg: 'Sem alertas críticos no período. Continue monitorando as campanhas.' });

      const insightsHtml = insights.length > 0
        ? insights.map(i => `<div style="padding:10px 14px;border-radius:var(--radius-sm);margin-bottom:8px;background:${i.type==='success'?'rgba(34,197,94,.12)':i.type==='danger'?'rgba(239,68,68,.12)':i.type==='warning'?'rgba(245,158,11,.12)':'rgba(99,102,241,.12)'};border-left:3px solid ${i.type==='success'?'#22c55e':i.type==='danger'?'#ef4444':i.type==='warning'?'#f59e0b':'#6366f1'}"><span style="font-size:.9rem">${i.msg}</span></div>`).join('')
        : '<div style="color:var(--text-muted);font-size:.9rem">Sem dados suficientes para insights.</div>';

      const html = `
        <div class="page-header">
          <div>
            <div class="page-title">📣 Publicidade (Mercado Ads)</div>
            <div class="page-subtitle">Inteligência de campanhas e métricas de ads</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div style="display:flex;gap:4px">
              ${periodBtns.map(p => `<button class="btn${currentPeriod===p&&!currentDate?' btn-primary':''}" style="padding:6px 12px;font-size:.8rem" onclick="window.adsSetPeriod('${p}')">${periodLabels[p]}</button>`).join('')}
            </div>
            <input type="date" id="adsDatePicker" value="${currentDate}" style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-size:.85rem" onchange="window.adsSetDate(this.value)">
            <button class="btn" style="padding:6px 12px;font-size:.8rem" onclick="window.adsSync()">⟳ Sincronizar</button>
          </div>
        </div>

        ${syncLog ? `<div style="font-size:.8rem;color:var(--text-muted);margin-bottom:12px">Última sync de métricas: ${syncLog.last_sync ? fmt.dt(new Date(syncLog.last_sync * 1000).toISOString()) : 'nunca'} — status: <span style="color:${syncLog.status==='ok'?'#22c55e':'#ef4444'}">${syncLog.status}</span></div>` : ''}

        <!-- KPIs -->
        <div class="kpi-grid" style="margin-bottom:24px">
          <div class="kpi-card"><div class="kpi-label">Investimento</div><div class="kpi-value">${fmt.brl(kpis.spend)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Receita Ads</div><div class="kpi-value">${fmt.brl(kpis.attributed_revenue)}</div></div>
          <div class="kpi-card"><div class="kpi-label">ROAS Médio</div><div class="kpi-value" style="${roasColor(kpis.roas)}">${(kpis.roas||0).toFixed(2)}x</div></div>
          <div class="kpi-card"><div class="kpi-label">ACOS Médio</div><div class="kpi-value" style="${acosColor(kpis.acos)}">${fmt.pct(kpis.acos)}</div></div>
          <div class="kpi-card"><div class="kpi-label">CTR Médio</div><div class="kpi-value">${fmt.pct(kpis.ctr)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Cliques</div><div class="kpi-value">${fmt.num(kpis.clicks)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Impressões</div><div class="kpi-value">${fmt.num(kpis.impressions)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Conversões</div><div class="kpi-value">${fmt.num(kpis.conversions)}</div></div>
          <div class="kpi-card"><div class="kpi-label">CPC Médio</div><div class="kpi-value">${fmt.brl(kpis.cpc)}</div></div>
        </div>

        <!-- Campaign Table -->
        <div class="card" style="margin-bottom:24px">
          <div class="card-title">Campanhas</div>
          ${!hasData ? `
            <div class="empty-state" style="padding:40px">
              <div class="empty-state-icon">📣</div>
              <h3>Sem dados de campanhas</h3>
              <p>Clique em Sincronizar para importar os dados de publicidade.</p>
              <button class="btn btn-primary" onclick="window.adsSync()">⟳ Sincronizar agora</button>
            </div>
          ` : `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Campanha</th>
                    <th>Status</th>
                    <th>Investimento</th>
                    <th>Receita</th>
                    <th>ROAS</th>
                    <th>ACOS</th>
                    <th>CTR</th>
                    <th>CPC</th>
                    <th>Cliques</th>
                    <th>Impressões</th>
                    <th>Conversões</th>
                  </tr>
                </thead>
                <tbody>
                  ${by_campaign.map(c => `
                    <tr>
                      <td style="font-weight:500">${c.name || c.campaign_id}</td>
                      <td><span class="badge ${c.status==='active'?'badge-green':c.status==='paused'?'badge-yellow':'badge-gray'}">${c.status||'-'}</span></td>
                      <td>${fmt.brl(c.spend)}</td>
                      <td>${fmt.brl(c.attributed_revenue)}</td>
                      <td style="${roasColor(c.roas)}">${(c.roas||0).toFixed(2)}x</td>
                      <td style="${acosColor(c.acos)}">${fmt.pct(c.acos)}</td>
                      <td>${fmt.pct(c.ctr)}</td>
                      <td>${fmt.brl(c.cpc)}</td>
                      <td>${fmt.num(c.clicks)}</td>
                      <td>${fmt.num(c.impressions)}</td>
                      <td>${fmt.num(c.conversions)}</td>
                    </tr>
                  `).join('')}
                  <tr style="font-weight:700;border-top:2px solid var(--border);background:var(--bg)">
                    <td>TOTAL</td>
                    <td>—</td>
                    <td>${fmt.brl(totRow.spend)}</td>
                    <td>${fmt.brl(totRow.attributed_revenue)}</td>
                    <td style="${roasColor(totRoas)}">${totRoas.toFixed(2)}x</td>
                    <td style="${acosColor(totAcos)}">${fmt.pct(totAcos)}</td>
                    <td>${fmt.pct(totCtr)}</td>
                    <td>${fmt.brl(totCpc)}</td>
                    <td>${fmt.num(totRow.clicks)}</td>
                    <td>${fmt.num(totRow.impressions)}</td>
                    <td>${fmt.num(totRow.conversions)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Daily trend chart -->
        <div class="card" style="margin-bottom:24px">
          <div class="card-title">Tendência Diária</div>
          ${by_day.length === 0 ? '<div style="color:var(--text-muted);padding:20px;text-align:center">Sem dados para o período selecionado.</div>' : `<canvas id="adsDailyChart" height="80"></canvas>`}
        </div>

        <!-- Auto insights -->
        <div class="card">
          <div class="card-title">💡 Insights Automáticos</div>
          <div style="margin-top:8px">${insightsHtml}</div>
        </div>
      `;

      setContent(html);

      // Render chart
      if (by_day.length > 0) {
        const ctx = document.getElementById('adsDailyChart');
        if (ctx) {
          destroyCharts();
          State.charts.adsDaily = new Chart(ctx, {
            type: 'line',
            data: {
              labels: by_day.map(d => d.date),
              datasets: [
                {
                  label: 'Investimento (R$)',
                  data: by_day.map(d => d.spend),
                  borderColor: '#ef4444',
                  backgroundColor: 'rgba(239,68,68,.08)',
                  tension: 0.3,
                  yAxisID: 'y',
                },
                {
                  label: 'Receita Ads (R$)',
                  data: by_day.map(d => d.attributed_revenue),
                  borderColor: '#22c55e',
                  backgroundColor: 'rgba(34,197,94,.08)',
                  tension: 0.3,
                  yAxisID: 'y',
                },
              ],
            },
            options: {
              responsive: true,
              interaction: { mode: 'index', intersect: false },
              plugins: { legend: { position: 'top' } },
              scales: {
                y: { ticks: { callback: v => 'R$' + fmt.num(v) } },
              },
            },
          });
        }
      }
    } catch (e) {
      setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro ao carregar Ads</h3><p>${e.message}</p><button class="btn btn-primary" onclick="window.adsSync()">⟳ Sincronizar</button></div>`);
    }
  }

  window.adsSetPeriod = (p) => {
    currentPeriod = p;
    currentDate = '';
    loadAds();
  };
  window.adsSetDate = (d) => {
    currentDate = d;
    currentPeriod = '';
    loadAds();
  };
  window.adsSync = async () => {
    try {
      toast('Sincronizando Ads...', 'default');
      await API.post(`/api/ads/sync?storeId=${State.currentStore}`, {});
      toast('Sync enfileirado! Aguarde alguns instantes.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  await loadAds();
}

// ============================================================
// PAGE: CUSTOMERS
// ============================================================
let custState = { filter: 'all', sort: 'total_spent', order: 'desc', search: '', offset: 0, limit: 50, total: 0 };

async function renderCustomers() {
  setContent(`
    <div class="page-header">
      <div>
        <div class="page-title">Clientes</div>
        <div class="page-subtitle">Base de compradores e análise de recorrência</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="window.custSync()">⟳ Sincronizar</button>
    </div>
    <div class="loading-state"><div class="spinner"></div><p>Carregando clientes...</p></div>
  `);

  window.custSync = async () => {
    toast('Sincronizando clientes...', 'default');
    try {
      await API.post('/api/customers/sync');
      toast('Sync enfileirado — aguarde alguns instantes', 'success');
      setTimeout(() => loadCust(), 3000);
    } catch (e) { toast(e.message, 'error'); }
  };

  window.custSetFilter = (f) => { custState.filter = f; custState.offset = 0; loadCust(); };
  window.custSearch    = (v) => { custState.search = v; custState.offset = 0; loadCust(); };
  window.custSort      = (col) => {
    if (custState.sort === col) custState.order = custState.order === 'desc' ? 'asc' : 'desc';
    else { custState.sort = col; custState.order = 'desc'; }
    loadCust();
  };
  window.custPage = (dir) => {
    custState.offset = Math.max(0, custState.offset + dir * custState.limit);
    loadCust();
  };

  async function loadCust() {
    try {
      const { customers, total, stats, syncLog } = await API.get(
        `/api/customers?storeId=${State.currentStore}&filter=${custState.filter}&sort=${custState.sort}&order=${custState.order}&search=${encodeURIComponent(custState.search)}&limit=${custState.limit}&offset=${custState.offset}`
      );
      custState.total = total;

      const syncInfo = syncLog
        ? `Última sync: ${fmt.dt(new Date(syncLog.last_sync * 1000).toISOString())}`
        : 'Nunca sincronizado';

      const filterBtn = (val, label) => {
        const active = custState.filter === val;
        return `<button class="btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}" onclick="custSetFilter('${val}')">${label}</button>`;
      };

      const sortIcon = (col) => custState.sort === col ? (custState.order === 'desc' ? ' ▼' : ' ▲') : '';
      const th = (col, label) => `<th style="cursor:pointer" onclick="custSort('${col}')">${label}${sortIcon(col)}</th>`;

      const rows = customers.map(c => {
        const recTag = c.is_recurrent
          ? `<span class="badge badge-green">Recorrente</span>`
          : `<span class="badge badge-blue">Novo</span>`;

        const daysSinceLast = c.last_order_at
          ? Math.floor((Date.now() - new Date(c.last_order_at).getTime()) / 86400000)
          : null;
        const fmtYear = d => d ? new Date(d).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '-';
        const lastTag = daysSinceLast !== null
          ? daysSinceLast <= 30
            ? `<span style="color:#22c55e;font-weight:600">${fmtYear(c.last_order_at)}</span>`
            : daysSinceLast <= 90
              ? `<span style="color:#f59e0b">${fmtYear(c.last_order_at)}</span>`
              : `<span style="color:#ef4444">${fmtYear(c.last_order_at)}</span>`
          : '-';

        const loc = [c.city, c.state_code].filter(Boolean).join(' / ') || '-';

        return `
          <tr style="cursor:pointer" onclick="window.openCustomer('${c.buyer_id}','${(c.nickname||c.buyer_id).replace(/'/g,"\\'")}')">
            <td>
              <div style="font-weight:600">${c.nickname || c.buyer_id}</div>
              <div style="font-size:11px;color:var(--text-3)">#${c.buyer_id}</div>
            </td>
            <td>${recTag}</td>
            <td class="td-light">${fmtYear(c.first_order_at)}</td>
            <td>${lastTag}</td>
            <td class="fw-bold text-right">${fmt.brl(c.total_spent)}</td>
            <td class="text-right">${fmt.num(c.total_orders)}</td>
            <td class="td-light">${fmt.brl(c.avg_ticket)}</td>
            <td class="td-light">${loc}</td>
          </tr>
        `;
      }).join('');

      const totalPages = Math.ceil(custState.total / custState.limit);
      const curPage    = Math.floor(custState.offset / custState.limit) + 1;

      setContent(`
        <div class="page-header">
          <div>
            <div class="page-title">Clientes</div>
            <div class="page-subtitle">Base de compradores e análise de recorrência · ${syncInfo}</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.custSync()">⟳ Sincronizar</button>
        </div>

        <!-- KPI cards -->
        <div class="kpi-grid" style="--cols:5">
          ${kpiCard('Total de Clientes', fmt.num(stats.total_customers), 'Compradores únicos', '👥', '#3b82f6')}
          ${kpiCard('Recorrentes', fmt.num(stats.recurrent), `${stats.total_customers > 0 ? ((stats.recurrent/stats.total_customers)*100).toFixed(1) : 0}% da base`, '🔄', '#10b981')}
          ${kpiCard('Novos (1 compra)', fmt.num(stats.new_customers), 'Apenas uma compra', '🆕', '#f59e0b')}
          ${kpiCard('Ticket Médio', fmt.brl(stats.avg_ticket), 'Por pedido', '🎫', '#8b5cf6')}
          ${kpiCard('Gasto Médio / Cliente', fmt.brl(stats.avg_spent), 'Total acumulado', '💰', '#FFE600')}
        </div>

        <!-- Filters -->
        <div class="card" style="padding:16px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <div style="display:flex;gap:6px">
              ${filterBtn('all', 'Todos')}
              ${filterBtn('recurrent', '🔄 Recorrentes')}
              ${filterBtn('new', '🆕 Novos')}
            </div>
            <input
              type="text"
              class="store-select"
              placeholder="🔍 Buscar por nome, cidade ou estado..."
              value="${custState.search}"
              oninput="custSearch(this.value)"
              style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-size:13px"
            >
            <span style="font-size:13px;color:var(--text-2)">${fmt.num(total)} cliente${total !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <!-- Table -->
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  ${th('nickname', 'Cliente')}
                  <th>Tipo</th>
                  ${th('first_order_at', 'Primeira Compra')}
                  ${th('last_order_at', 'Última Compra')}
                  ${th('total_spent', 'Total Gasto')}
                  ${th('total_orders', 'Pedidos')}
                  ${th('avg_ticket', 'Ticket Médio')}
                  <th>Localização</th>
                </tr>
              </thead>
              <tbody>
                ${customers.length ? rows : `<tr><td colspan="8" class="text-center td-light" style="padding:48px">
                  <div style="font-size:32px;margin-bottom:12px">👥</div>
                  <div style="font-weight:600;margin-bottom:8px">Nenhum cliente encontrado</div>
                  <div style="font-size:13px;margin-bottom:16px">Clique em Sincronizar para processar os pedidos existentes.</div>
                  <button class="btn btn-primary" onclick="window.custSync()">⟳ Sincronizar Agora</button>
                </td></tr>`}
              </tbody>
            </table>
          </div>

          <!-- Pagination -->
          ${totalPages > 1 ? `
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:16px;font-size:13px;color:var(--text-2)">
            <span>Página ${curPage} de ${totalPages}</span>
            <div style="display:flex;gap:8px">
              <button class="btn btn-secondary btn-sm" onclick="custPage(-1)" ${curPage <= 1 ? 'disabled' : ''}>← Anterior</button>
              <button class="btn btn-secondary btn-sm" onclick="custPage(1)"  ${curPage >= totalPages ? 'disabled' : ''}>Próxima →</button>
            </div>
          </div>
          ` : ''}
        </div>
      `);

    } catch (e) {
      setContent(`<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Erro ao carregar</h3><p>${e.message}</p><button class="btn btn-primary" onclick="window.custSync()">⟳ Sincronizar</button></div>`);
    }
  }

  await loadCust();
}

// ============================================================
// CUSTOMER MODAL
// ============================================================
window.openCustomer = async function(buyerId, nickname) {
  Modal.open(`👤 ${nickname}`, `<div class="loading-state" style="padding:32px"><div class="spinner"></div><p>Carregando...</p></div>`);

  try {
    const { customer: c, orders } = await API.get(
      `/api/customers/detail?storeId=${State.currentStore}&buyerId=${buyerId}`
    );

    const daysSinceLast = c.last_order_at
      ? Math.floor((Date.now() - new Date(c.last_order_at).getTime()) / 86400000)
      : null;

    const recTag = c.is_recurrent
      ? `<span class="badge badge-green">Recorrente</span>`
      : `<span class="badge badge-blue">Novo</span>`;

    const loc = [c.city, c.state, c.state_code].filter(Boolean);
    const locStr = loc.length ? loc.filter((v,i,a) => a.indexOf(v) === i).join(', ') : 'Não informado';

    const statusColor = {
      paid: '#22c55e', pending: '#f59e0b', cancelled: '#ef4444',
      confirmed: '#3b82f6', in_process: '#3b82f6',
    };

    const fmtOrderId = id => String(id);
    const fmtFull = d => d ? new Date(d).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    }) : '-';

    const orderRows = orders.map(o => `
      <tr>
        <td style="font-size:12px;color:var(--text-2);font-family:monospace">#${fmtOrderId(o.id)}</td>
        <td style="font-size:12px;white-space:nowrap">${fmtFull(o.date_created)}</td>
        <td style="font-size:12px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${o.items||''}">${o.items||'-'}</td>
        <td style="font-size:12px;text-align:right;font-weight:600">${fmt.brl(o.total_amount)}</td>
        <td style="font-size:12px">${o.receiver_city ? `${o.receiver_city}/${o.receiver_state_code||''}` : '-'}</td>
        <td><span style="font-size:11px;font-weight:600;color:${statusColor[o.status]||'#9ca3af'}">${o.status==='paid'?'Pago':o.status}</span></td>
      </tr>
    `).join('');

    const body = `
      <!-- Header info -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
        <div style="background:var(--bg);border-radius:10px;padding:16px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Total Gasto</div>
          <div style="font-size:22px;font-weight:800;color:var(--text)">${fmt.brl(c.total_spent)}</div>
        </div>
        <div style="background:var(--bg);border-radius:10px;padding:16px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Pedidos</div>
          <div style="font-size:22px;font-weight:800;color:var(--text)">${fmt.num(c.total_orders)}</div>
        </div>
        <div style="background:var(--bg);border-radius:10px;padding:16px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Ticket Médio</div>
          <div style="font-size:22px;font-weight:800;color:var(--text)">${fmt.brl(c.avg_ticket)}</div>
        </div>
      </div>

      <!-- Customer details -->
      <div style="background:var(--bg);border-radius:10px;padding:16px;border:1px solid var(--border);margin-bottom:20px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
          <div><span style="color:var(--text-2)">Tipo: </span>${recTag}</div>
          <div><span style="color:var(--text-2)">Localização: </span><strong>${locStr}</strong></div>
          <div><span style="color:var(--text-2)">Primeira compra: </span><strong>${fmtFull(c.first_order_at)}</strong></div>
          <div><span style="color:var(--text-2)">Última compra: </span>
            <strong style="color:${daysSinceLast<=30?'#22c55e':daysSinceLast<=90?'#f59e0b':'#ef4444'}">
              ${fmtFull(c.last_order_at)}${daysSinceLast!==null?` (${daysSinceLast}d atrás)`:''}
            </strong>
          </div>
          <div><span style="color:var(--text-2)">ID ML: </span><span style="font-family:monospace;font-size:12px">#${c.buyer_id}</span></div>
          <div><span style="color:var(--text-2)">Nickname: </span><strong>${c.nickname||'-'}</strong></div>
        </div>
      </div>

      <!-- Orders -->
      <div style="font-weight:700;font-size:14px;margin-bottom:10px">🛒 Histórico de Compras (${orders.length})</div>
      <div style="overflow-x:auto;max-height:320px;overflow-y:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead style="position:sticky;top:0;background:var(--surface)">
            <tr>
              <th style="text-align:left;padding:8px 10px;color:var(--text-2);font-weight:600;border-bottom:1px solid var(--border)">#Pedido</th>
              <th style="text-align:left;padding:8px 10px;color:var(--text-2);font-weight:600;border-bottom:1px solid var(--border)">Data</th>
              <th style="text-align:left;padding:8px 10px;color:var(--text-2);font-weight:600;border-bottom:1px solid var(--border)">Produtos</th>
              <th style="text-align:right;padding:8px 10px;color:var(--text-2);font-weight:600;border-bottom:1px solid var(--border)">Valor</th>
              <th style="text-align:left;padding:8px 10px;color:var(--text-2);font-weight:600;border-bottom:1px solid var(--border)">Cidade</th>
              <th style="text-align:left;padding:8px 10px;color:var(--text-2);font-weight:600;border-bottom:1px solid var(--border)">Status</th>
            </tr>
          </thead>
          <tbody>
            ${orderRows || `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-2)">Nenhuma compra encontrada</td></tr>`}
          </tbody>
        </table>
      </div>
    `;

    Modal.open(`👤 ${c.nickname || buyerId}`, body);
  } catch(e) {
    Modal.open('Erro', `<p style="color:#ef4444">${e.message}</p>`);
  }
};

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', init);
