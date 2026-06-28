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
    const data = await API.dashboard(State.currentStore);
    const { kpis, chartData, recentOrders } = data;

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
  return `
    <div class="listing-card">
      ${item.thumbnail
        ? `<img class="listing-thumb" src="${item.thumbnail}" alt="${item.title}" loading="lazy">`
        : `<div class="listing-thumb-ph">📦</div>`}
      <div class="listing-info">
        <div class="listing-title" title="${item.title}">${item.title}</div>
        <div class="listing-meta">
          <span>${badge(STATUS_LISTING, item.status)}</span>
          <span style="color:var(--text-3)">ID: ${item.id}</span>
          ${item.permalink ? `<a href="${item.permalink}" target="_blank" style="color:var(--blue);font-size:12px">Ver no ML ↗</a>` : ''}
        </div>
      </div>
      <div class="listing-stats">
        <div class="listing-stat">
          <div class="listing-stat-val">${fmt.brl(item.price)}</div>
          <div class="listing-stat-lab">Preço</div>
        </div>
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
    </div>
    <div id="metricsBody"><div class="loading-state"><div class="spinner"></div></div></div>
  `);
  await loadMetrics();
}

window.setMetricsDays = async (days) => {
  metricsDays = days;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.textContent === `${days} dias`));
  await loadMetrics();
};

async function loadMetrics() {
  const wrap = document.getElementById('metricsBody');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Analisando dados...</p></div>';

  try {
    const data = await API.metrics(State.currentStore, metricsDays);
    const { summary, dailyChart, topProducts } = data;

    wrap.innerHTML = `
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">
        ${kpiCard('Receita Total', fmt.brl(summary.totalRevenue), `Últimos ${metricsDays} dias`, '💰', '#FFE600')}
        ${kpiCard('Total de Pedidos', fmt.num(summary.totalOrders), `Últimos ${metricsDays} dias`, '🛒', '#10b981')}
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
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', init);
