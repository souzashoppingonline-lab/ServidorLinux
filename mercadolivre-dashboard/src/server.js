'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ============================================================
// CONFIGURATION
// ============================================================
const ML_APP_ID      = process.env.ML_APP_ID      || '886699420287362';
const ML_APP_SECRET  = process.env.ML_APP_SECRET  || '5VB9CU0A50wOGCHhqZ67OnuzegeFEKza';
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://multimixvendas.duckdns.org/ml/callback';
const PORT           = parseInt(process.env.PORT   || '3001', 10);
const DATA_DIR       = process.env.DATA_DIR        || path.join(__dirname, '..', 'data');
const PUBLIC_DIR     = path.join(__dirname, '..', 'public');

const ML_AUTH_URL  = 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const ML_API       = 'https://api.mercadolibre.com';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// DATABASE
// ============================================================
const db = new Database(path.join(DATA_DIR, 'ml.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id               TEXT PRIMARY KEY,
    nickname         TEXT NOT NULL,
    email            TEXT DEFAULT '',
    access_token     TEXT NOT NULL,
    refresh_token    TEXT NOT NULL,
    token_expires_at INTEGER NOT NULL,
    site_id          TEXT DEFAULT 'MLB',
    permalink        TEXT DEFAULT '',
    thumbnail        TEXT DEFAULT '',
    created_at       INTEGER DEFAULT (unixepoch()),
    last_sync        INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    store_id   TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cache (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT,
    resource    TEXT,
    user_id     TEXT,
    payload     TEXT,
    received_at INTEGER DEFAULT (unixepoch())
  );
`);

setInterval(() => {
  db.prepare('DELETE FROM cache    WHERE expires_at < unixepoch()').run();
  db.prepare('DELETE FROM sessions WHERE expires_at < unixepoch()').run();
}, 60_000);

// ============================================================
// CACHE
// ============================================================
function cacheGet(key) {
  const row = db.prepare('SELECT data FROM cache WHERE key=? AND expires_at>unixepoch()').get(key);
  return row ? JSON.parse(row.data) : null;
}
function cacheSet(key, data, ttl = 300) {
  db.prepare('INSERT OR REPLACE INTO cache(key,data,expires_at) VALUES(?,?,unixepoch()+?)').run(key, JSON.stringify(data), ttl);
}
function cacheInvalidate(storeId) {
  db.prepare("DELETE FROM cache WHERE key LIKE ?").run(`%:${storeId}%`);
}

// ============================================================
// ML API
// ============================================================
async function mlFetch(apiPath, opts = {}, storeId = null) {
  let token = opts.token;
  if (!token && storeId) {
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(storeId);
    if (!store) throw new Error('Loja não encontrada');
    token = await ensureFreshToken(store);
  }
  const res = await fetch(`${ML_API}${apiPath}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ML API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function ensureFreshToken(store) {
  if (store.token_expires_at - Math.floor(Date.now() / 1000) < 300) {
    const refreshed = await refreshToken(store.id, store.refresh_token);
    return refreshed.access_token;
  }
  return store.access_token;
}

async function refreshToken(storeId, rToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ML_APP_ID,
    client_secret: ML_APP_SECRET,
    refresh_token: rToken,
  });
  const res = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('Falha ao renovar token');
  const data = await res.json();
  const exp = Math.floor(Date.now() / 1000) + (data.expires_in || 21600);
  db.prepare('UPDATE stores SET access_token=?,refresh_token=?,token_expires_at=? WHERE id=?')
    .run(data.access_token, data.refresh_token, exp, storeId);
  return data;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     ML_APP_ID,
    client_secret: ML_APP_SECRET,
    code,
    redirect_uri:  ML_REDIRECT_URI,
  });
  console.log('[oauth] Trocando code. redirect_uri:', ML_REDIRECT_URI);

  const res = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const text = await res.text();
  console.log('[oauth] ML response', res.status, ':', text.slice(0, 300));
  if (res.status === 429) throw new Error('Rate limit ML (429) — aguarde alguns minutos e tente novamente');
  if (!res.ok) throw new Error(`Troca de código falhou (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ============================================================
// SESSIONS
// ============================================================
function createSession(storeId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
  db.prepare('INSERT INTO sessions(token,store_id,expires_at) VALUES(?,?,?)').run(token, storeId, exp);
  return token;
}

function getSession(req) {
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/ml_session=([a-f0-9]{64})/);
  if (!m) {
    if (cookies) console.log('[session] Cookie presente mas sem ml_session:', cookies.slice(0, 100));
    return null;
  }
  const sess = db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>unixepoch()').get(m[1]);
  if (!sess) console.log('[session] Token não encontrado no DB:', m[1].slice(0, 16) + '...');
  return sess;
}

// ============================================================
// HTTP HELPERS
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css',
  '.js'  : 'application/javascript',
  '.json': 'application/json',
  '.png' : 'image/png',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveFile(res, relPath) {
  const abs = path.join(PUBLIC_DIR, relPath);
  if (!abs.startsWith(PUBLIC_DIR)) { send(res, 403, { error: 'Forbidden' }); return; }
  fs.readFile(abs, (e, data) => {
    if (e) { send(res, 404, { error: 'Não encontrado' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function ok(res, data)          { send(res, 200, data); }
function apiErr(res, st, msg)   { send(res, st, { error: msg }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2e6) reject(new Error('Payload muito grande')); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function qp(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

// ============================================================
// ROUTE TABLE
// ============================================================
const routes = new Map();
function route(method, pathname, fn, pub = false) {
  routes.set(`${method} ${pathname}`, { fn, pub });
}

// ── OAuth ──────────────────────────────────────────────────
route('GET', '/ml/connect', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url   = new URL(ML_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id',     ML_APP_ID);
  url.searchParams.set('redirect_uri',  ML_REDIRECT_URI);
  url.searchParams.set('state', state);
  res.writeHead(302, {
    Location:    url.toString(),
    'Set-Cookie': `ml_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`,
  });
  res.end();
}, true);

route('GET', '/ml/callback', async (req, res) => {
  const url   = new URL(req.url, 'http://localhost');
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.writeHead(302, { Location: '/login?error=auth_failed' });
    res.end();
    return;
  }

  // Validate state to prevent duplicate callbacks
  const cookieState = (req.headers.cookie || '').match(/ml_state=([a-f0-9]{32})/)?.[1];
  if (state && cookieState && state !== cookieState) {
    console.warn('[oauth] State mismatch — possível callback duplicado, ignorando');
    res.writeHead(302, { Location: '/login?error=state_mismatch' });
    res.end();
    return;
  }

  try {
    const tokens = await exchangeCode(code);
    const user   = await mlFetch('/users/me', { token: tokens.access_token });
    console.log('[oauth] user.id:', user.id, 'nickname:', user.nickname, 'thumbnail type:', typeof user.thumbnail);
    const exp    = Math.floor(Date.now() / 1000) + (tokens.expires_in || 21600);

    // ML returns thumbnail as object {picture_url} or as a plain string
    const thumbUrl = typeof user.thumbnail === 'string'
      ? user.thumbnail
      : (user.thumbnail?.picture_url || user.thumbnail?.secure_url || '');

    db.prepare(`
      INSERT INTO stores(id,nickname,email,access_token,refresh_token,token_expires_at,site_id,permalink,thumbnail)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        nickname=excluded.nickname, email=excluded.email,
        access_token=excluded.access_token, refresh_token=excluded.refresh_token,
        token_expires_at=excluded.token_expires_at, permalink=excluded.permalink, thumbnail=excluded.thumbnail
    `).run(
      String(user.id), user.nickname || '', user.email || '',
      tokens.access_token, tokens.refresh_token || '', exp,
      user.site_id || 'MLB', user.permalink || '', thumbUrl,
    );

    const sess = createSession(String(user.id));
    const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https');
    const secureFlag = isHttps ? '; Secure' : '';
    res.writeHead(302, {
      Location:    '/',
      'Set-Cookie': [
        `ml_session=${sess}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secureFlag}`,
        `ml_state=; HttpOnly; Path=/; Max-Age=0`,
      ],
    });
    res.end();
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    const isRateLimit = e.message.includes('429') || e.message.includes('Rate limit');
    const errParam = isRateLimit ? 'rate_limit' : 'auth_failed';
    res.writeHead(302, { Location: `/login?error=${errParam}` });
    res.end();
  }
}, true);

route('POST', '/api/logout', (req, res) => {
  const m = (req.headers.cookie || '').match(/ml_session=([a-f0-9]{64})/);
  if (m) db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': 'ml_session=; HttpOnly; Path=/; Max-Age=0',
  });
  res.end(JSON.stringify({ ok: true }));
}, true);

// ── ML Webhook (public) ────────────────────────────────────
async function handleWebhook(req, res) {
  const body = await readBody(req).catch(() => ({}));
  db.prepare('INSERT INTO webhooks(topic,resource,user_id,payload) VALUES(?,?,?,?)')
    .run(body.topic || '', body.resource || '', String(body.user_id || ''), JSON.stringify(body));
  if (body.user_id) cacheInvalidate(String(body.user_id));
  broadcast('webhook', { topic: body.topic, resource: body.resource });
  ok(res, { ok: true });
}

// Webhook at dedicated path
route('POST', '/ml/webhook', handleWebhook, true);

// ML also sends notifications to the same callback URL via POST
// (when both fields point to the same URL)
route('POST', '/ml/callback', handleWebhook, true);

// ── Stores ─────────────────────────────────────────────────
route('GET', '/api/stores', (req, res, sess) => {
  const stores = db.prepare('SELECT id,nickname,email,site_id,permalink,thumbnail,created_at,last_sync FROM stores').all();
  ok(res, { stores });
});

route('DELETE', '/api/stores', (req, res, sess) => {
  const id = qp(req).get('id');
  if (!id) { apiErr(res, 400, 'id obrigatório'); return; }
  db.prepare('DELETE FROM stores WHERE id=?').run(id);
  if (sess.store_id === id) db.prepare('DELETE FROM sessions WHERE store_id=?').run(id);
  cacheInvalidate(id);
  ok(res, { ok: true });
});

// ── Me ─────────────────────────────────────────────────────
route('GET', '/api/me', (req, res, sess) => {
  const store  = db.prepare('SELECT id,nickname,email,site_id,permalink,thumbnail FROM stores WHERE id=?').get(sess.store_id);
  const stores = db.prepare('SELECT id,nickname,thumbnail FROM stores').all();
  ok(res, { store, stores });
});

// ── Dashboard ──────────────────────────────────────────────
route('GET', '/api/dashboard', async (req, res, sess) => {
  const storeId = qp(req).get('storeId') || sess.store_id;
  const cached  = cacheGet(`dashboard:${storeId}`);
  if (cached) { ok(res, cached); return; }

  try {
    const now    = new Date();
    const today  = now.toISOString().split('T')[0];
    const d30ago = new Date(now - 30 * 86400000).toISOString().split('T')[0];

    const [activeItems, pausedItems, orders30d, ordersToday, questions] = await Promise.all([
      mlFetch(`/users/${storeId}/items/search?status=active&limit=1`,  {}, storeId).catch(() => ({ paging: { total: 0 } })),
      mlFetch(`/users/${storeId}/items/search?status=paused&limit=1`,  {}, storeId).catch(() => ({ paging: { total: 0 } })),
      mlFetch(`/orders/search?seller=${storeId}&order.status=paid&date_created.from=${d30ago}T00:00:00.000-03:00&limit=50&sort=date_desc`, {}, storeId).catch(() => ({ results: [], paging: { total: 0 } })),
      mlFetch(`/orders/search?seller=${storeId}&order.status=paid&date_created.from=${today}T00:00:00.000-03:00&limit=50&sort=date_desc`, {}, storeId).catch(() => ({ results: [], paging: { total: 0 } })),
      mlFetch(`/questions/search?seller_id=${storeId}&status=UNANSWERED&limit=1`, {}, storeId).catch(() => ({ paging: { total: 0 } })),
    ]);

    const revenue30d    = (orders30d.results || []).reduce((s, o) => s + (o.total_amount || 0), 0);
    const revenueToday  = (ordersToday.results || []).reduce((s, o) => s + (o.total_amount || 0), 0);
    const totalOrders30 = orders30d.paging?.total || orders30d.results?.length || 0;
    const avgTicket     = totalOrders30 > 0 ? revenue30d / totalOrders30 : 0;

    const dailyMap = {};
    (orders30d.results || []).forEach(o => {
      const day = o.date_created?.split('T')[0];
      if (day) dailyMap[day] = (dailyMap[day] || 0) + (o.total_amount || 0);
    });

    const chartData = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000).toISOString().split('T')[0];
      chartData.push({ date: d, revenue: dailyMap[d] || 0 });
    }

    const result = {
      kpis: {
        activeListings:   activeItems.paging?.total  || 0,
        pausedListings:   pausedItems.paging?.total  || 0,
        orders30d:        totalOrders30,
        ordersToday:      ordersToday.paging?.total  || 0,
        revenue30d,
        revenueToday,
        avgTicket,
        pendingQuestions: questions.paging?.total    || 0,
      },
      chartData,
      recentOrders: (orders30d.results || []).slice(0, 8).map(o => ({
        id:       o.id,
        date:     o.date_created,
        buyer:    o.buyer?.nickname || '-',
        amount:   o.total_amount   || 0,
        status:   o.status,
        items:    (o.order_items || []).map(i => i.item?.title).filter(Boolean).join(', '),
      })),
    };

    cacheSet(`dashboard:${storeId}`, result, 300);
    ok(res, result);
  } catch (e) {
    console.error('Dashboard error:', e.message);
    apiErr(res, 500, e.message);
  }
});

// ── Listings ───────────────────────────────────────────────
route('GET', '/api/listings', async (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const status  = p.get('status')  || 'active';
  const limit   = Math.min(parseInt(p.get('limit') || '50'), 100);
  const offset  = parseInt(p.get('offset') || '0');

  try {
    const search = await mlFetch(
      `/users/${storeId}/items/search?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`,
      {}, storeId,
    );
    const ids = (search.results || []).join(',');
    let items = [];
    if (ids) {
      const batch = await mlFetch(
        `/items?ids=${ids}&attributes=id,title,price,available_quantity,thumbnail,status,permalink,condition,listing_type_id,sold_quantity,category_id`,
        {}, storeId,
      );
      items = (batch || []).map(d => d.body || d).filter(i => i && i.id);
    }
    ok(res, { items, total: search.paging?.total || 0, limit, offset });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('PUT', '/api/listings', async (req, res, sess) => {
  const id   = qp(req).get('id');
  if (!id) { apiErr(res, 400, 'id obrigatório'); return; }
  const body = await readBody(req);
  const storeId = body.storeId || sess.store_id;

  const update = {};
  if (body.price             !== undefined) update.price             = Number(body.price);
  if (body.available_quantity !== undefined) update.available_quantity = Number(body.available_quantity);
  if (body.status            !== undefined) update.status            = body.status;

  try {
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(storeId);
    const token = await ensureFreshToken(store);
    const result = await mlFetch(`/items/${id}`, { method: 'PUT', token, body: update });
    cacheInvalidate(storeId);
    ok(res, { ok: true, item: result });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Orders ─────────────────────────────────────────────────
route('GET', '/api/orders', async (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const status  = p.get('status')  || '';
  const from    = p.get('from')    || '';
  const to      = p.get('to')      || '';
  const limit   = Math.min(parseInt(p.get('limit')  || '50'), 100);
  const offset  = parseInt(p.get('offset') || '0');

  const params = new URLSearchParams({ seller: storeId, sort: 'date_desc', limit, offset });
  if (status) params.set('order.status', status);
  if (from)   params.set('date_created.from', `${from}T00:00:00.000-03:00`);
  if (to)     params.set('date_created.to',   `${to}T23:59:59.000-03:00`);

  try {
    const data = await mlFetch(`/orders/search?${params}`, {}, storeId);
    ok(res, {
      orders: (data.results || []).map(o => ({
        id:              o.id,
        date:            o.date_created,
        buyer:           { id: o.buyer?.id, nickname: o.buyer?.nickname },
        amount:          o.total_amount   || 0,
        status:          o.status,
        payment_status:  o.payments?.[0]?.status,
        shipping_status: o.shipping?.status,
        pack_id:         o.pack_id,
        items: (o.order_items || []).map(i => ({
          id:         i.item?.id,
          title:      i.item?.title,
          quantity:   i.quantity,
          unit_price: i.unit_price,
          thumbnail:  i.item?.thumbnail,
        })),
      })),
      paging: data.paging || {},
    });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Questions ──────────────────────────────────────────────
route('GET', '/api/questions', async (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const status  = p.get('status')  || 'UNANSWERED';
  const limit   = Math.min(parseInt(p.get('limit') || '50'), 100);
  const offset  = parseInt(p.get('offset') || '0');

  try {
    const data = await mlFetch(
      `/questions/search?seller_id=${storeId}&status=${status}&sort_fields=date_created&sort_types=DESC&limit=${limit}&offset=${offset}`,
      {}, storeId,
    );
    ok(res, {
      questions: (data.questions || []).map(q => ({
        id:         q.id,
        text:       q.text,
        status:     q.status,
        date:       q.date_created,
        item_id:    q.item_id,
        item_title: q.item?.title,
        from:       { id: q.from?.id, nickname: q.from?.nickname },
        answer:     q.answer ? { text: q.answer.text, date: q.answer.date_created } : null,
      })),
      paging: data.paging || {},
    });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('POST', '/api/questions/answer', async (req, res, sess) => {
  const body = await readBody(req);
  const { question_id, text, storeId } = body;
  if (!question_id || !text?.trim()) { apiErr(res, 400, 'question_id e text são obrigatórios'); return; }

  const sid = storeId || sess.store_id;
  try {
    const store  = db.prepare('SELECT * FROM stores WHERE id=?').get(sid);
    const token  = await ensureFreshToken(store);
    const result = await mlFetch('/answers', { method: 'POST', token, body: { question_id, text } });
    ok(res, { ok: true, answer: result });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Messages ───────────────────────────────────────────────
route('GET', '/api/messages', async (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const packId  = p.get('packId');
  if (!packId) { apiErr(res, 400, 'packId obrigatório'); return; }

  try {
    const data = await mlFetch(`/messages/packs/${packId}/sellers/${storeId}?tag=post_sale`, {}, storeId);
    ok(res, { messages: data.messages || [] });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('POST', '/api/messages', async (req, res, sess) => {
  const body = await readBody(req);
  const { packId, text, storeId } = body;
  if (!packId || !text?.trim()) { apiErr(res, 400, 'packId e text obrigatórios'); return; }

  const sid = storeId || sess.store_id;
  try {
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(sid);
    const token = await ensureFreshToken(store);
    const result = await mlFetch(`/messages/packs/${packId}/sellers/${sid}`, {
      method: 'POST', token,
      body: { from: { user_id: parseInt(sid) }, to: { group_id: packId }, text: { plain: text } },
    });
    ok(res, { ok: true, message: result });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Metrics ────────────────────────────────────────────────
route('GET', '/api/metrics', async (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const days    = Math.min(parseInt(p.get('days') || '30'), 90);
  const cKey    = `metrics:${storeId}:${days}`;
  const cached  = cacheGet(cKey);
  if (cached) { ok(res, cached); return; }

  const now  = new Date();
  const from = new Date(now - days * 86400000).toISOString().split('T')[0];
  const to   = now.toISOString().split('T')[0];

  try {
    // Fetch up to 200 orders for analysis
    const [batch1, batch2] = await Promise.all([
      mlFetch(`/orders/search?seller=${storeId}&order.status=paid&date_created.from=${from}T00:00:00.000-03:00&date_created.to=${to}T23:59:59.000-03:00&limit=50&offset=0&sort=date_desc`, {}, storeId).catch(() => ({ results: [] })),
      mlFetch(`/orders/search?seller=${storeId}&order.status=paid&date_created.from=${from}T00:00:00.000-03:00&date_created.to=${to}T23:59:59.000-03:00&limit=50&offset=50&sort=date_desc`, {}, storeId).catch(() => ({ results: [] })),
    ]);
    const allOrders = [...(batch1.results || []), ...(batch2.results || [])];

    const totalRevenue = allOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
    const totalOrders  = allOrders.length;
    const avgTicket    = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const byProduct = {};
    allOrders.forEach(o => {
      (o.order_items || []).forEach(i => {
        const key = i.item?.id;
        if (!key) return;
        if (!byProduct[key]) byProduct[key] = { id: key, title: i.item?.title || key, revenue: 0, units: 0 };
        byProduct[key].revenue += (i.unit_price || 0) * (i.quantity || 0);
        byProduct[key].units   += i.quantity || 0;
      });
    });

    const daily = {};
    allOrders.forEach(o => {
      const day = o.date_created?.split('T')[0];
      if (!day) return;
      if (!daily[day]) daily[day] = { date: day, revenue: 0, orders: 0 };
      daily[day].revenue += o.total_amount || 0;
      daily[day].orders++;
    });

    const dailyChart = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000).toISOString().split('T')[0];
      dailyChart.push(daily[d] || { date: d, revenue: 0, orders: 0 });
    }

    const result = {
      summary: { totalRevenue, totalOrders, avgTicket },
      dailyChart,
      topProducts: Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    };

    cacheSet(cKey, result, 600);
    ok(res, result);
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ============================================================
// HTTP SERVER
// ============================================================
const PUBLIC_ROUTES = new Set(['/login', '/login.html', '/ml/connect', '/ml/callback', '/ml/webhook', '/api/logout']);
const STATIC_EXT    = new Set(['.css', '.js', '.png', '.svg', '.ico', '.woff2', '.json']);

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const urlPath  = new URL(req.url, 'http://localhost').pathname;
  const routeKey = `${req.method} ${urlPath}`;
  const entry    = routes.get(routeKey);

  // Static assets (always public)
  if (STATIC_EXT.has(path.extname(urlPath))) {
    serveFile(res, urlPath);
    return;
  }

  // Public routes
  if (PUBLIC_ROUTES.has(urlPath) || (entry && entry.pub)) {
    if (entry) {
      Promise.resolve(entry.fn(req, res, null)).catch(e => {
        console.error(e.message);
        apiErr(res, 500, 'Erro interno');
      });
    } else if (urlPath === '/login' || urlPath === '/login.html') {
      serveFile(res, '/login.html');
    } else {
      apiErr(res, 404, 'Não encontrado');
    }
    return;
  }

  // Auth check
  const sess = getSession(req);
  if (!sess) {
    if (urlPath.startsWith('/api/')) {
      apiErr(res, 401, 'Autenticação necessária');
    } else {
      res.writeHead(302, { Location: '/login' });
      res.end();
    }
    return;
  }

  // Authenticated API routes
  if (entry) {
    Promise.resolve(entry.fn(req, res, sess)).catch(e => {
      console.error('API error:', e.message);
      apiErr(res, 500, 'Erro interno');
    });
    return;
  }

  // SPA fallback
  serveFile(res, '/index.html');
}

const server = http.createServer(handleRequest);

// ============================================================
// WEBSOCKET
// ============================================================
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', ws => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ============================================================
// TOKEN REFRESH JOB
// ============================================================
async function refreshAllTokens() {
  const stores = db.prepare('SELECT * FROM stores').all();
  for (const store of stores) {
    if (store.token_expires_at - Math.floor(Date.now() / 1000) < 3600) {
      try {
        await refreshToken(store.id, store.refresh_token);
        console.log(`[token] Renovado para ${store.nickname}`);
      } catch (e) {
        console.error(`[token] Falha para ${store.id}:`, e.message);
      }
    }
  }
}

setInterval(refreshAllTokens, 30 * 60_000);

// ============================================================
// START
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`╔════════════════════════════════════════════╗`);
  console.log(`║  ML Dashboard — CFO Mercado Livre          ║`);
  console.log(`╠════════════════════════════════════════════╣`);
  console.log(`║  URL:    http://0.0.0.0:${PORT}              ║`);
  console.log(`║  App ID: ${ML_APP_ID}   ║`);
  console.log(`╚════════════════════════════════════════════╝`);
});

process.on('SIGTERM', () => { db.close(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
