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

const SCHEDULER_CONFIG = {
  batchSize: 5,             // items per batch
  batchDelay: 600000,       // 10 minutes between listing batches (ms)
  minDelay: 1000,           // minimum delay between API calls (ms)
  maxCallsPerMinute: 15,    // max API calls per minute (ML free tier ~20/min, leave headroom)
  ordersInterval: 1800000,  // 30 minutes
  questionsInterval: 2400000, // 40 minutes
  stockInterval: 7200000,   // 2 hours
  visitsHour: 3,            // 3am for visits sync
  visitsDelayMs: 3000,      // 3s between each day fetch for visits
};

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

  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    store_id      TEXT NOT NULL,
    status        TEXT,
    total_amount  REAL DEFAULT 0,
    date_created  TEXT,
    date_closed   TEXT,
    buyer_id      TEXT,
    buyer_nickname TEXT,
    shipping_status TEXT,
    synced_at     INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   TEXT NOT NULL,
    store_id   TEXT NOT NULL,
    item_id    TEXT,
    item_title TEXT,
    quantity   INTEGER DEFAULT 1,
    unit_price REAL DEFAULT 0,
    category_id TEXT
  );

  CREATE TABLE IF NOT EXISTS listings (
    id                 TEXT PRIMARY KEY,
    store_id           TEXT NOT NULL,
    title              TEXT,
    price              REAL DEFAULT 0,
    original_price     REAL DEFAULT 0,
    available_quantity INTEGER DEFAULT 0,
    sold_quantity      INTEGER DEFAULT 0,
    status             TEXT DEFAULT 'active',
    thumbnail          TEXT DEFAULT '',
    permalink          TEXT DEFAULT '',
    condition          TEXT DEFAULT '',
    listing_type_id    TEXT DEFAULT '',
    category_id        TEXT DEFAULT '',
    deal_ids           TEXT DEFAULT '',
    synced_at          INTEGER DEFAULT (unixepoch())
  );


  CREATE TABLE IF NOT EXISTS promotions (
    id          TEXT NOT NULL,
    store_id    TEXT NOT NULL,
    type        TEXT DEFAULT '',
    status      TEXT DEFAULT '',
    name        TEXT DEFAULT '',
    start_date  TEXT DEFAULT '',
    finish_date TEXT DEFAULT '',
    synced_at   INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (id, store_id)
  );

  CREATE TABLE IF NOT EXISTS promotion_items (
    promotion_id TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    store_id     TEXT NOT NULL,
    original_price REAL DEFAULT 0,
    new_price      REAL DEFAULT 0,
    discount_pct   REAL DEFAULT 0,
    PRIMARY KEY (promotion_id, item_id, store_id)
  );

  CREATE TABLE IF NOT EXISTS questions_sync (
    id             TEXT PRIMARY KEY,
    store_id       TEXT NOT NULL,
    item_id        TEXT,
    item_title     TEXT DEFAULT '',
    buyer_nickname TEXT DEFAULT '',
    text           TEXT,
    status         TEXT DEFAULT 'UNANSWERED',
    date_created   TEXT,
    answer_text    TEXT,
    answer_date    TEXT,
    synced_at      INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    store_id   TEXT NOT NULL,
    entity     TEXT NOT NULL,
    last_sync  INTEGER DEFAULT 0,
    status     TEXT DEFAULT 'never',
    error      TEXT DEFAULT '',
    PRIMARY KEY (store_id, entity)
  );

  CREATE TABLE IF NOT EXISTS item_visits (
    item_id   TEXT NOT NULL,
    store_id  TEXT NOT NULL,
    date      TEXT NOT NULL,
    visits    INTEGER DEFAULT 0,
    PRIMARY KEY (item_id, store_id, date)
  );

  CREATE TABLE IF NOT EXISTS job_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL,
    store_id     TEXT NOT NULL,
    priority     INTEGER DEFAULT 5,
    payload      TEXT DEFAULT '{}',
    status       TEXT DEFAULT 'pending',
    attempts     INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    scheduled_at INTEGER DEFAULT (unixepoch()),
    started_at   INTEGER,
    completed_at INTEGER,
    duration_ms  INTEGER,
    error        TEXT DEFAULT '',
    created_at   INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status, priority, scheduled_at);

  CREATE TABLE IF NOT EXISTS api_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT,
    endpoint     TEXT,
    method       TEXT DEFAULT 'GET',
    status_code  INTEGER,
    duration_ms  INTEGER,
    error        TEXT DEFAULT '',
    rate_limit_remaining INTEGER,
    logged_at    INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS scheduler_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Schema migrations (safe to run on every start)
for (const col of [
  "ALTER TABLE listings ADD COLUMN original_price REAL DEFAULT 0",
  "ALTER TABLE listings ADD COLUMN deal_ids TEXT DEFAULT ''",
]) {
  try { db.exec(col); } catch {} // ignore "duplicate column" errors
}

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
// RATE LIMITER
// ============================================================
const RateLimiter = {
  callsThisMinute: 0,
  lastMinuteReset: Date.now(),
  currentDelay: SCHEDULER_CONFIG.minDelay,
  consecutive429: 0,

  async wait() {
    const now = Date.now();
    if (now - this.lastMinuteReset >= 60000) {
      this.callsThisMinute = 0;
      this.lastMinuteReset = now;
    }
    if (this.callsThisMinute >= SCHEDULER_CONFIG.maxCallsPerMinute) {
      const wait = 60000 - (now - this.lastMinuteReset);
      console.log(`[ratelimit] Limite/min atingido — aguardando ${Math.ceil(wait/1000)}s`);
      await new Promise(r => setTimeout(r, wait + 100));
      this.callsThisMinute = 0;
      this.lastMinuteReset = Date.now();
    }
    if (this.currentDelay > SCHEDULER_CONFIG.minDelay) {
      await new Promise(r => setTimeout(r, this.currentDelay));
    }
    this.callsThisMinute++;
  },

  on429(retryAfterSec = 30) {
    this.consecutive429++;
    // Back off aggressively: use the retry-after header value, minimum 30s
    const backoffMs = Math.max(retryAfterSec * 1000, 30000);
    this.currentDelay = Math.min(Math.max(this.currentDelay * 2, backoffMs), 120000);
    console.log(`[ratelimit] 429 detectado (#${this.consecutive429}) — delay aumentado para ${this.currentDelay}ms`);
  },

  onSuccess() {
    if (this.consecutive429 > 0) {
      this.consecutive429 = 0;
      this.currentDelay = Math.max(this.currentDelay * 0.85, SCHEDULER_CONFIG.minDelay);
    }
  },

  // Hard pause: stop all calls for N seconds (used after consecutive 429s)
  async pause(ms) {
    console.log(`[ratelimit] Pausa forçada de ${ms/1000}s para recuperar rate limit`);
    await new Promise(r => setTimeout(r, ms));
  },
};

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
  for (let attempt = 0; attempt < 3; attempt++) {
    await RateLimiter.wait();
    const t0 = Date.now();
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
    const duration = Date.now() - t0;
    const rlRemaining = parseInt(res.headers.get('x-ratelimit-remaining') || '-1', 10);
    db.prepare('INSERT INTO api_log(store_id,endpoint,method,status_code,duration_ms,rate_limit_remaining) VALUES(?,?,?,?,?,?)')
      .run(storeId || '', apiPath.slice(0, 200), opts.method || 'GET', res.status, duration, rlRemaining);

    if (res.status === 429) {
      const retrySec = parseInt(res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset') || '30', 10);
      RateLimiter.on429(retrySec);
      console.log(`[api] 429 em ${apiPath} — aguardando ${retrySec}s...`);
      await new Promise(r => setTimeout(r, Math.min(retrySec, 60) * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      db.prepare('UPDATE api_log SET error=? WHERE id=(SELECT MAX(id) FROM api_log)').run(text.slice(0, 200));
      throw new Error(`ML API ${res.status}: ${text.slice(0, 200)}`);
    }
    RateLimiter.onSuccess();
    return res.json();
  }
  throw new Error('ML API 429: rate limit após retries');
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
// JOB HANDLERS — helper first
// ============================================================

// Helper to fetch and store item details in batch
async function processItemBatch(storeId, ids) {
  if (!ids.length) return;
  const chunk = ids.join(',');
  const batch = await mlFetch(
    `/items?ids=${chunk}&attributes=id,title,price,original_price,available_quantity,sold_quantity,thumbnail,status,permalink,condition,listing_type_id,category_id,deal_ids`,
    {}, storeId
  ).catch(() => null);
  if (!batch) return;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO listings
      (id,store_id,title,price,original_price,available_quantity,sold_quantity,status,thumbnail,permalink,condition,listing_type_id,category_id,deal_ids)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.transaction((items) => {
    for (const d of items) {
      const it = d.body || d;
      if (!it?.id) continue;
      const dealIds = Array.isArray(it.deal_ids) ? it.deal_ids.join(',') : (it.deal_ids || '');
      insert.run(
        it.id, storeId, it.title||'', it.price||0, it.original_price||0,
        it.available_quantity||0, it.sold_quantity||0, it.status||'active',
        it.thumbnail||'', it.permalink||'', it.condition||'',
        it.listing_type_id||'', it.category_id||'', dealIds
      );
    }
  })(batch);
}

const JOB_HANDLERS = {
  // Incremental order sync — only new orders since last sync
  async sync_orders(storeId) {
    const log = db.prepare('SELECT last_sync FROM sync_log WHERE store_id=? AND entity=?').get(storeId, 'orders');
    const lastSync = log?.last_sync || 0;
    const from = lastSync > 0
      ? new Date(lastSync * 1000 - 300000).toISOString() // 5min overlap to catch updates
      : new Date(Date.now() - 90 * 86400000).toISOString();
    const fromStr = from.split('T')[0];

    console.log(`[sync] orders store=${storeId} from=${fromStr}`);
    let offset = 0, total = 0;

    while (true) {
      const page = await mlFetch(
        `/orders/search?seller=${storeId}&order.status=paid&date_created.from=${fromStr}T00:00:00.000-03:00&limit=50&offset=${offset}&sort=date_asc`,
        {}, storeId
      );
      if (!page?.results?.length) break;

      const insertOrder = db.prepare(`INSERT OR REPLACE INTO orders(id,store_id,status,total_amount,date_created,date_closed,buyer_id,buyer_nickname,shipping_status) VALUES(?,?,?,?,?,?,?,?,?)`);
      const deleteItems = db.prepare('DELETE FROM order_items WHERE order_id=?');
      const insertItem = db.prepare(`INSERT INTO order_items(order_id,store_id,item_id,item_title,quantity,unit_price,category_id) VALUES(?,?,?,?,?,?,?)`);

      db.transaction((orders) => {
        for (const o of orders) {
          insertOrder.run(o.id, storeId, o.status, o.total_amount||0, o.date_created, o.date_closed, String(o.buyer?.id||''), o.buyer?.nickname||'', o.shipping?.status||'');
          deleteItems.run(o.id);
          for (const item of (o.order_items||[])) {
            insertItem.run(o.id, storeId, item.item?.id||'', item.item?.title||'', item.quantity||1, item.unit_price||0, item.item?.category_id||'');
          }
        }
      })(page.results);

      total += page.results.length;
      if (page.results.length < 50) break;
      offset += 50;
      if (offset >= 1000) break;
    }

    db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'orders', 'ok', '');
    console.log(`[sync] orders done store=${storeId} new=${total}`);
  },

  // Batch listings sync — processes SCHEDULER_CONFIG.batchSize items, then schedules next batch
  async sync_listings_batch(storeId, payload) {
    const offset = payload.offset || 0;
    const batchSize = SCHEDULER_CONFIG.batchSize;

    console.log(`[sync] listings_batch store=${storeId} offset=${offset}`);

    const search = await mlFetch(
      `/users/${storeId}/items/search?status=${payload.paused ? 'paused' : 'active'}&limit=${batchSize}&offset=${offset}`,
      {}, storeId
    );

    if (!search?.results?.length) {
      // Also sync paused items if we just finished active
      if (!payload.paused) {
        const paused = await mlFetch(`/users/${storeId}/items/search?status=paused&limit=${batchSize}&offset=0`, {}, storeId).catch(() => null);
        if (paused?.results?.length) {
          await processItemBatch(storeId, paused.results);
          if (paused.paging?.total > batchSize) {
            Scheduler.enqueue('sync_listings_batch', storeId, 4, { offset: batchSize, paused: true }, SCHEDULER_CONFIG.batchDelay);
          }
        }
      }
      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'listings', 'ok', '');
      console.log(`[sync] listings done store=${storeId}`);
      return;
    }

    await processItemBatch(storeId, search.results);

    // Schedule next batch with delay
    const total = search.paging?.total || 0;
    if (offset + batchSize < total) {
      Scheduler.enqueue('sync_listings_batch', storeId, 4, { offset: offset + batchSize, paused: payload.paused }, SCHEDULER_CONFIG.batchDelay);
    } else if (!payload.paused) {
      // Start paused items batch
      Scheduler.enqueue('sync_listings_batch', storeId, 4, { offset: 0, paused: true }, SCHEDULER_CONFIG.batchDelay);
    } else {
      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'listings', 'ok', '');
    }
  },

  async sync_questions(storeId) {
    console.log(`[sync] questions store=${storeId}`);
    const page = await mlFetch(
      `/questions/search?seller_id=${storeId}&status=UNANSWERED&limit=50&offset=0&sort_fields=date_created&sort_types=DESC`,
      {}, storeId
    );
    if (!page) return;

    const insert = db.prepare(`INSERT OR REPLACE INTO questions_sync(id,store_id,item_id,item_title,buyer_nickname,text,status,date_created,answer_text,answer_date) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    db.transaction((qs) => {
      for (const q of (qs||[])) {
        insert.run(String(q.id), storeId, q.item_id||'', '', q.from?.nickname||'', q.text||'', q.status||'UNANSWERED', q.date_created||'', q.answer?.text||'', q.answer?.date_created||'');
      }
    })(page.questions || []);

    db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'questions', 'ok', '');
  },

  async sync_visits(storeId) {
    console.log(`[sync] visits store=${storeId}`);
    // Use /items/visits/time_window?ids=ID1,ID2&last=30&unit=day
    // This is the correct ML API for multi-day visit data (NOT the per-day endpoint)
    // It returns daily breakdown per item for the last N days — one call per batch of IDs
    const today = new Date().toISOString().split('T')[0];
    const insert = db.prepare('INSERT OR REPLACE INTO item_visits(item_id,store_id,date,visits) VALUES(?,?,?,?)');

    const allIds = db.prepare("SELECT id FROM listings WHERE store_id=? AND status='active'").all(storeId).map(r => r.id);
    if (!allIds.length) {
      console.log(`[sync] visits store=${storeId} — sem anúncios ativos`);
      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'visits', 'ok', '');
      return;
    }

    let totalEntries = 0;
    // Process in batches of 20 IDs (ML API limit per call)
    for (let i = 0; i < allIds.length; i += 20) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000)); // 2s between batches
      const ids = allIds.slice(i, i + 20).join(',');
      const data = await mlFetch(
        `/items/visits/time_window?ids=${ids}&last=30&unit=day`,
        {}, storeId
      ).catch(e => { console.error(`[sync] visits batch ${i} error:`, e.message); return null; });

      if (!data) continue;

      // Response: array of { id, visits: [ { date, total } ] }
      const items = Array.isArray(data) ? data : (data.items_visits || []);
      db.transaction((rows) => {
        for (const item of rows) {
          const itemId = item.id || item.item_id;
          if (!itemId) continue;
          const visitList = item.visits || [];
          for (const v of visitList) {
            const date = v.date?.split('T')[0] || today;
            if ((v.total || 0) > 0) {
              insert.run(itemId, storeId, date, v.total);
              totalEntries++;
            }
          }
        }
      })(items);
    }

    db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'visits', 'ok', '');
    console.log(`[sync] visits done store=${storeId} ids=${allIds.length} entries=${totalEntries}`);
  },

  async sync_promotions(storeId) {
    console.log(`[sync] promotions store=${storeId}`);

    // Fetch active promotions list
    const data = await mlFetch(
      `/promotions?seller_id=${storeId}&status=started&limit=50`,
      {}, storeId
    ).catch(e => { console.error('[sync] promotions error:', e.message); return null; });

    if (!data) return;
    const promotions = Array.isArray(data) ? data : (data.results || []);

    const upsertPromo = db.prepare(`
      INSERT OR REPLACE INTO promotions(id,store_id,type,status,name,start_date,finish_date)
      VALUES(?,?,?,?,?,?,?)
    `);
    const upsertItem = db.prepare(`
      INSERT OR REPLACE INTO promotion_items(promotion_id,item_id,store_id,original_price,new_price,discount_pct)
      VALUES(?,?,?,?,?,?)
    `);

    for (const promo of promotions) {
      upsertPromo.run(
        String(promo.id), storeId,
        promo.type || '', promo.status || '',
        promo.name || promo.type || '',
        promo.start_date || '', promo.finish_date || ''
      );

      // Fetch items in this promotion
      await new Promise(r => setTimeout(r, 1000));
      const itemsData = await mlFetch(
        `/promotions/${promo.id}/items?limit=100`,
        {}, storeId
      ).catch(() => null);

      const promoItems = itemsData?.results || itemsData || [];
      db.transaction((rows) => {
        for (const pi of rows) {
          const origPrice = pi.original_price || pi.price || 0;
          const newPrice  = pi.new_price || pi.sale_price || pi.price || 0;
          const discPct   = origPrice > 0 ? ((origPrice - newPrice) / origPrice) * 100 : 0;
          upsertItem.run(String(promo.id), pi.item_id || pi.id, storeId, origPrice, newPrice, discPct);
        }
      })(promoItems);
    }

    // Also clear promotions that are no longer active
    if (promotions.length > 0) {
      const ids = promotions.map(p => `'${p.id}'`).join(',');
      db.prepare(`DELETE FROM promotions WHERE store_id=? AND id NOT IN (${ids})`).run(storeId);
    }

    db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'promotions', 'ok', '');
    console.log(`[sync] promotions done store=${storeId} count=${promotions.length}`);
  },
};

// ============================================================
// JOB SCHEDULER
// ============================================================
const Scheduler = {
  running: false,
  currentJob: null,

  enqueue(type, storeId, priority = 5, payload = {}, delayMs = 0) {
    // Deduplicate: skip if a pending/running job of same type+store already exists
    const existing = db.prepare(
      "SELECT id FROM job_queue WHERE type=? AND store_id=? AND status IN ('pending','running') LIMIT 1"
    ).get(type, storeId);
    if (existing) return existing.id;

    const scheduledAt = Math.floor((Date.now() + delayMs) / 1000);
    const result = db.prepare(`
      INSERT INTO job_queue(type, store_id, priority, payload, scheduled_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(type, storeId, priority, JSON.stringify(payload), scheduledAt);
    return result.lastInsertRowid;
  },

  enqueueForAllStores(type, priority, payload = {}, delayMs = 0) {
    const stores = db.prepare('SELECT id FROM stores').all();
    stores.forEach(s => this.enqueue(type, s.id, priority, payload, delayMs));
  },

  getNext() {
    return db.prepare(`
      SELECT * FROM job_queue
      WHERE status = 'pending' AND scheduled_at <= unixepoch()
      ORDER BY priority ASC, scheduled_at ASC
      LIMIT 1
    `).get();
  },

  async processJob(job) {
    db.prepare('UPDATE job_queue SET status=?, started_at=unixepoch(), attempts=attempts+1 WHERE id=?')
      .run('running', job.id);
    this.currentJob = job;
    const t0 = Date.now();

    try {
      // If we've been getting 429s, pause before starting next job
      if (RateLimiter.consecutive429 >= 3) {
        await RateLimiter.pause(60000); // 1 minute hard pause
      }

      const payload = JSON.parse(job.payload || '{}');
      await JOB_HANDLERS[job.type]?.(job.store_id, payload);
      db.prepare('UPDATE job_queue SET status=?, completed_at=unixepoch(), duration_ms=? WHERE id=?')
        .run('completed', Date.now() - t0, job.id);
      console.log(`[scheduler] ✓ ${job.type} store=${job.store_id} (${Date.now()-t0}ms)`);
    } catch (e) {
      const attempts = job.attempts + 1;
      const is429 = e.message.includes('429') || e.message.includes('rate limit');
      const retryDelays = is429
        ? [600000, 1800000, 3600000]   // 429: 10min, 30min, 1h
        : [300000, 900000, 1800000];   // other: 5min, 15min, 30min
      if (attempts < job.max_attempts) {
        const delay = retryDelays[attempts - 1] || 3600000;
        db.prepare('UPDATE job_queue SET status=?, error=?, scheduled_at=unixepoch()+? WHERE id=?')
          .run('pending', e.message.slice(0, 500), Math.floor(delay/1000), job.id);
        console.log(`[scheduler] ✗ ${job.type} tentativa ${attempts}/${job.max_attempts} — retry em ${delay/60000}min`);
      } else {
        db.prepare('UPDATE job_queue SET status=?, completed_at=unixepoch(), duration_ms=?, error=? WHERE id=?')
          .run('failed', Date.now() - t0, e.message.slice(0, 500), job.id);
        console.error(`[scheduler] FALHA PERMANENTE ${job.type} store=${job.store_id}:`, e.message);
      }
    }
    this.currentJob = null;
  },

  async tick() {
    if (this.running) return;
    const job = this.getNext();
    if (!job) return;
    this.running = true;
    try {
      await this.processJob(job);
    } finally {
      this.running = false;
    }
  },

  start() {
    // On startup: mark any 'running' jobs as failed (they were interrupted by restart)
    const stuck = db.prepare("UPDATE job_queue SET status='pending', error='Interrompido por restart' WHERE status='running'").run();
    if (stuck.changes > 0) console.log(`[scheduler] ${stuck.changes} job(s) marcado(s) como pending após restart`);

    // Clean up duplicate pending jobs left from previous restarts
    db.prepare(`
      DELETE FROM job_queue WHERE status='pending' AND id NOT IN (
        SELECT MIN(id) FROM job_queue WHERE status='pending' GROUP BY type, store_id
      )
    `).run();

    // Process queue every 10 seconds
    setInterval(() => this.tick().catch(e => console.error('[scheduler] tick error:', e.message)), 10000);
    // Schedule recurring jobs
    this.scheduleRecurring();
    // Initial schedule — wait 5s for DB to settle
    setTimeout(() => this.scheduleAllSyncs(), 5000);
    console.log('[scheduler] Iniciado');
  },

  scheduleAllSyncs() {
    const stores = db.prepare('SELECT id FROM stores').all();
    if (!stores.length) return;
    const now = Date.now() / 1000;
    stores.forEach((s, i) => {
      const base = i * 120000;

      // Orders: only enqueue if last sync was > ordersInterval ago (respect rate limits across restarts)
      const lastO = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='orders'").get(s.id);
      const ordersDue = !lastO || (now - lastO.last_sync) > SCHEDULER_CONFIG.ordersInterval / 1000;
      if (ordersDue) this.enqueue('sync_orders', s.id, 1, {}, base);
      else console.log(`[scheduler] orders store=${s.id} recente (${Math.round((now - lastO.last_sync)/60)}min atrás) — pulando`);

      // Questions: only if stale
      const lastQ = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='questions'").get(s.id);
      const questionsDue = !lastQ || (now - lastQ.last_sync) > SCHEDULER_CONFIG.questionsInterval / 1000;
      if (questionsDue) this.enqueue('sync_questions', s.id, 2, {}, base + 120000);

      // Sync listings if never done or stale (> 2h)
      const lastL = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='listings'").get(s.id);
      const listingsStale = !lastL || (Date.now()/1000 - lastL.last_sync) > 7200;
      if (listingsStale) this.enqueue('sync_listings_batch', s.id, 4, { offset: 0 }, base + 300000);

      // Sync visits if never done (first run) or stale (> 20h)
      const lastV = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='visits'").get(s.id);
      const visitsNeverDone = !lastV;
      const visitsStale = lastV && (Date.now()/1000 - lastV.last_sync) > 72000;
      if (visitsNeverDone) {
        console.log(`[scheduler] Visitas nunca sincronizadas para store=${s.id} — agendando agora`);
        this.enqueue('sync_visits', s.id, 3, {}, base + 600000);
      } else if (visitsStale) {
        this.enqueue('sync_visits', s.id, 3, {}, base + 600000);
      }

      // Sync promotions if never done or stale (> 4h)
      const lastP = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='promotions'").get(s.id);
      const promosStale = !lastP || (Date.now()/1000 - lastP.last_sync) > 14400;
      if (promosStale) this.enqueue('sync_promotions', s.id, 3, {}, base + 180000);
    });
  },

  scheduleRecurring() {
    // Orders: every 15 minutes
    setInterval(() => this.enqueueForAllStores('sync_orders', 1), SCHEDULER_CONFIG.ordersInterval);

    // Questions: every 20 minutes
    setInterval(() => this.enqueueForAllStores('sync_questions', 2), SCHEDULER_CONFIG.questionsInterval);

    // Listings: every 2 hours
    setInterval(() => this.enqueueForAllStores('sync_listings_batch', 4, { offset: 0 }), SCHEDULER_CONFIG.stockInterval);

    // Visits: once a day at 3am (and on boot if stale — handled in scheduleAllSyncs)
    const scheduleVisitsDaily = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(SCHEDULER_CONFIG.visitsHour, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      const delay = next - now;
      console.log(`[scheduler] Próxima sync de visitas: ${next.toISOString()} (${Math.round(delay/3600000)}h)`);
      setTimeout(() => {
        this.enqueueForAllStores('sync_visits', 3);
        scheduleVisitsDaily();
      }, delay);
    };
    scheduleVisitsDaily();
  },
};

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
  // Accept token from: Authorization header, cookie, or ml_token query param
  let token = null;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) {
    const m = (req.headers.cookie || '').match(/ml_session=([a-f0-9]{64})/);
    if (m) token = m[1];
  }
  if (!token) {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const t = qs.get('ml_token');
    if (t && /^[a-f0-9]{64}$/.test(t)) token = t;
  }
  if (!token) return null;
  const sess = db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>unixepoch()').get(token);
  if (!sess) console.log('[session] Token não encontrado no DB:', token.slice(0, 16) + '...');
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
    // Serve an inline page that saves token to localStorage then redirects
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Entrando...</title></head><body>
<script>
try { localStorage.setItem('ml_token','${sess}'); } catch(e){}
location.replace('/');
</script>
<p>Redirecionando...</p></body></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `ml_state=; HttpOnly; Path=/; Max-Age=0`,
    });
    res.end(html);
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

// ── Debug (temporary) ──────────────────────────────────────
route('GET', '/api/debug-session', (req, res) => {
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/ml_session=([a-f0-9]{64})/);
  const token = m ? m[1] : null;
  const sess = token ? db.prepare('SELECT store_id, datetime(expires_at,"unixepoch") as exp FROM sessions WHERE token=?').get(token) : null;
  const sessCount = db.prepare('SELECT COUNT(*) as n FROM sessions').get();
  ok(res, { hasCookie: !!token, tokenPrefix: token ? token.slice(0,16) : null, sessionFound: !!sess, session: sess, totalSessions: sessCount.n });
}, true);

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
route('GET', '/api/dashboard', (req, res, sess) => {
  const storeId = qp(req).get('storeId') || sess.store_id;
  const cached  = cacheGet(`dashboard:${storeId}`);
  if (cached) { ok(res, cached); return; }

  try {
    const now = Math.floor(Date.now() / 1000);
    const from30 = now - 30 * 86400;
    const from7  = now - 7 * 86400;
    const from1  = now - 86400;
    const todayStr = new Date().toISOString().split('T')[0];

    const orders30 = db.prepare(
      "SELECT * FROM orders WHERE store_id=? AND date_created >= datetime(?,'unixepoch') AND status='paid'"
    ).all(storeId, from30);

    const revenue30d   = orders30.reduce((s, o) => s + (o.total_amount || 0), 0);
    const totalOrders30 = orders30.length;
    const avgTicket    = totalOrders30 > 0 ? revenue30d / totalOrders30 : 0;

    const todayOrders = orders30.filter(o => o.date_created && o.date_created.startsWith(todayStr));
    const revenueToday = todayOrders.reduce((s, o) => s + (o.total_amount || 0), 0);

    const activeListings  = db.prepare("SELECT COUNT(*) as n FROM listings WHERE store_id=? AND status='active'").get(storeId)?.n || 0;
    const pausedListings  = db.prepare("SELECT COUNT(*) as n FROM listings WHERE store_id=? AND status='paused'").get(storeId)?.n || 0;
    const pendingQuestions = db.prepare("SELECT COUNT(*) as n FROM questions_sync WHERE store_id=? AND status='UNANSWERED'").get(storeId)?.n || 0;

    const dailyMap = {};
    orders30.forEach(o => {
      const day = o.date_created?.split('T')[0];
      if (day) dailyMap[day] = (dailyMap[day] || 0) + (o.total_amount || 0);
    });

    const nowDate = new Date();
    const chartData = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(nowDate - i * 86400000).toISOString().split('T')[0];
      chartData.push({ date: d, revenue: dailyMap[d] || 0 });
    }

    const recentRaw = db.prepare(
      "SELECT o.*, GROUP_CONCAT(oi.item_title) as item_titles FROM orders o LEFT JOIN order_items oi ON o.id=oi.order_id WHERE o.store_id=? AND o.status='paid' GROUP BY o.id ORDER BY o.date_created DESC LIMIT 8"
    ).all(storeId);

    const result = {
      kpis: {
        activeListings,
        pausedListings,
        orders30d: totalOrders30,
        ordersToday: todayOrders.length,
        revenue30d,
        revenueToday,
        avgTicket,
        pendingQuestions,
      },
      chartData,
      recentOrders: recentRaw.map(o => ({
        id:     o.id,
        date:   o.date_created,
        buyer:  o.buyer_nickname || '-',
        amount: o.total_amount || 0,
        status: o.status,
        items:  o.item_titles || '',
      })),
    };

    cacheSet(`dashboard:${storeId}`, result, 60);
    ok(res, result);
  } catch (e) {
    console.error('Dashboard error:', e.message);
    apiErr(res, 500, e.message);
  }
});

// ── Listings ───────────────────────────────────────────────
route('GET', '/api/listings', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const status  = p.get('status')  || 'active';
  const limit   = Math.min(parseInt(p.get('limit') || '50'), 100);
  const offset  = parseInt(p.get('offset') || '0');

  try {
    const items = db.prepare('SELECT * FROM listings WHERE store_id=? AND status=? ORDER BY synced_at DESC LIMIT ? OFFSET ?').all(storeId, status, limit, offset);
    const total = db.prepare('SELECT COUNT(*) as n FROM listings WHERE store_id=? AND status=?').get(storeId, status).n;

    // Attach promotion info per item
    const promoItemsMap = {};
    if (items.length) {
      const placeholders = items.map(() => '?').join(',');
      const promoRows = db.prepare(`
        SELECT pi.item_id, pi.promotion_id, pi.original_price, pi.new_price, pi.discount_pct, p.name, p.type, p.finish_date
        FROM promotion_items pi
        JOIN promotions p ON p.id = pi.promotion_id AND p.store_id = pi.store_id
        WHERE pi.store_id=? AND pi.item_id IN (${placeholders})
      `).all(storeId, ...items.map(i => i.id));
      for (const r of promoRows) {
        if (!promoItemsMap[r.item_id]) promoItemsMap[r.item_id] = [];
        promoItemsMap[r.item_id].push(r);
      }
    }

    const enriched = items.map(item => ({
      ...item,
      in_promotion: !!(item.original_price > 0 || (promoItemsMap[item.id]?.length > 0) || item.deal_ids),
      discount_pct: item.original_price > 0
        ? Math.round(((item.original_price - item.price) / item.original_price) * 100)
        : (promoItemsMap[item.id]?.[0]?.discount_pct || 0),
      promotions: promoItemsMap[item.id] || [],
    }));

    ok(res, { items: enriched, total, limit, offset });
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
route('GET', '/api/orders', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const status  = p.get('status')  || '';
  const from    = p.get('from')    || '';
  const to      = p.get('to')      || '';
  const limit   = Math.min(parseInt(p.get('limit')  || '50'), 100);
  const offset  = parseInt(p.get('offset') || '0');

  try {
    let where = 'o.store_id=?';
    const args = [storeId];
    if (status) { where += ' AND o.status=?'; args.push(status); }
    if (from)   { where += ' AND o.date_created >= ?'; args.push(`${from}T00:00:00`); }
    if (to)     { where += ' AND o.date_created <= ?'; args.push(`${to}T23:59:59`); }

    const ordersRaw = db.prepare(
      `SELECT o.id, o.date_created, o.status, o.total_amount, o.buyer_id, o.buyer_nickname, o.shipping_status
       FROM orders o WHERE ${where} ORDER BY o.date_created DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);

    const totalRow = db.prepare(`SELECT COUNT(*) as n FROM orders o WHERE ${where}`).get(...args);

    const orderIds = ordersRaw.map(o => o.id);
    const itemsMap = {};
    if (orderIds.length) {
      const placeholders = orderIds.map(() => '?').join(',');
      const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`).all(...orderIds);
      items.forEach(i => {
        if (!itemsMap[i.order_id]) itemsMap[i.order_id] = [];
        itemsMap[i.order_id].push(i);
      });
    }

    const orders = ordersRaw.map(o => ({
      id:              o.id,
      date:            o.date_created,
      buyer:           { id: o.buyer_id, nickname: o.buyer_nickname },
      amount:          o.total_amount || 0,
      status:          o.status,
      payment_status:  o.status,
      shipping_status: o.shipping_status,
      pack_id:         null,
      items: (itemsMap[o.id] || []).map(i => ({
        id:         i.item_id,
        title:      i.item_title,
        quantity:   i.quantity,
        unit_price: i.unit_price,
        thumbnail:  '',
      })),
    }));

    ok(res, { orders, paging: { total: totalRow?.n || 0, limit, offset } });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Questions ──────────────────────────────────────────────
route('GET', '/api/questions', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const status  = p.get('status')  || 'UNANSWERED';
  const limit   = Math.min(parseInt(p.get('limit') || '50'), 100);
  const offset  = parseInt(p.get('offset') || '0');

  try {
    const rows = db.prepare(
      'SELECT * FROM questions_sync WHERE store_id=? AND status=? ORDER BY date_created DESC LIMIT ? OFFSET ?'
    ).all(storeId, status, limit, offset);
    const total = db.prepare('SELECT COUNT(*) as n FROM questions_sync WHERE store_id=? AND status=?').get(storeId, status).n;

    ok(res, {
      questions: rows.map(q => ({
        id:         q.id,
        text:       q.text,
        status:     q.status,
        date:       q.date_created,
        item_id:    q.item_id,
        item_title: q.item_title,
        from:       { id: null, nickname: q.buyer_nickname },
        answer:     q.answer_text ? { text: q.answer_text, date: q.answer_date } : null,
      })),
      paging: { total, limit, offset },
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

// ── Scheduler Routes ───────────────────────────────────────
// Scheduler status dashboard data
route('GET', '/api/scheduler/status', (req, res, sess) => {
  const pending = db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='pending'").get().n;
  const running = db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='running'").get().n;
  const completedToday = db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='completed' AND completed_at >= unixepoch('now','start of day')").get().n;
  const failedToday = db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='failed' AND completed_at >= unixepoch('now','start of day')").get().n;
  const retriesToday = db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE attempts > 1 AND created_at >= unixepoch('now','start of day')").get().n;
  const avgDuration = db.prepare("SELECT AVG(duration_ms) as avg FROM job_queue WHERE status='completed' AND completed_at >= unixepoch()-3600").get().avg || 0;
  const recentJobs = db.prepare("SELECT type, store_id, status, attempts, duration_ms, error, created_at, completed_at FROM job_queue ORDER BY id DESC LIMIT 20").all();
  const syncLogs = db.prepare("SELECT * FROM sync_log").all();
  const pendingJobs = db.prepare("SELECT type, store_id, priority, scheduled_at, attempts FROM job_queue WHERE status='pending' ORDER BY priority, scheduled_at LIMIT 10").all();
  const apiStats = db.prepare("SELECT COUNT(*) as calls, AVG(duration_ms) as avg_ms, SUM(CASE WHEN status_code=429 THEN 1 ELSE 0 END) as rate_limits FROM api_log WHERE logged_at >= unixepoch()-3600").get();
  const recentApiLogs = db.prepare("SELECT endpoint, status_code, duration_ms, rate_limit_remaining, logged_at FROM api_log ORDER BY id DESC LIMIT 10").all();

  ok(res, {
    queue: { pending, running, completedToday, failedToday, retriesToday },
    currentJob: Scheduler.currentJob,
    rateLimiter: { currentDelay: RateLimiter.currentDelay, callsThisMinute: RateLimiter.callsThisMinute, consecutive429: RateLimiter.consecutive429 },
    avgDuration: Math.round(avgDuration),
    recentJobs,
    pendingJobs,
    syncLogs,
    apiStats,
    recentApiLogs,
    config: SCHEDULER_CONFIG,
  });
});

// Manual trigger for a specific sync type
route('POST', '/api/scheduler/trigger', async (req, res, sess) => {
  const body = await readBody(req);
  const type = body.type || 'sync_orders';
  const storeId = body.storeId || sess.store_id;
  Scheduler.enqueue(type, storeId, 1); // priority 1 = immediate
  ok(res, { ok: true, message: `Job ${type} adicionado à fila` });
});

// Clear completed/failed jobs older than 24h
route('DELETE', '/api/scheduler/cleanup', (req, res, sess) => {
  const deleted = db.prepare("DELETE FROM job_queue WHERE status IN ('completed','failed') AND created_at < unixepoch()-86400").run();
  ok(res, { ok: true, deleted: deleted.changes });
});

// ── Promotions ────────────────────────────────────────────
route('GET', '/api/promotions', (req, res, sess) => {
  const storeId = qp(req).get('storeId') || sess.store_id;
  try {
    const promos = db.prepare('SELECT * FROM promotions WHERE store_id=? ORDER BY start_date DESC').all(storeId);
    const items  = db.prepare('SELECT * FROM promotion_items WHERE store_id=?').all(storeId);
    const syncLog = db.prepare("SELECT last_sync,status FROM sync_log WHERE store_id=? AND entity='promotions'").get(storeId);
    ok(res, { promotions: promos, items, last_sync: syncLog?.last_sync || 0 });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('POST', '/api/promotions/sync', (req, res, sess) => {
  Scheduler.enqueue('sync_promotions', sess.store_id, 2);
  ok(res, { ok: true, message: 'Sync de promoções enfileirada' });
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

// ── Analytics: hourly ──────────────────────────────────────
route('GET', '/api/analytics/hourly', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const days    = Math.min(parseInt(p.get('days') || '7'), 30);
  const cKey    = `analytics:hourly:${storeId}:${days}`;
  const cached  = cacheGet(cKey);
  if (cached) { ok(res, cached); return; }

  try {
    const fromDate = new Date(Date.now() - days * 86400000).toISOString();
    const allOrders = db.prepare(
      "SELECT date_created, total_amount FROM orders WHERE store_id=? AND date_created>=? AND status='paid'"
    ).all(storeId, fromDate);

    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }));
    allOrders.forEach(o => {
      const d = new Date(o.date_created);
      const h = ((d.getUTCHours() - 3) + 24) % 24;
      byHour[h].orders++;
      byHour[h].revenue += o.total_amount || 0;
    });
    byHour.forEach(h => { h.avgTicket = h.orders > 0 ? h.revenue / h.orders : 0; });

    const sorted = [...byHour].sort((a, b) => b.orders - a.orders);
    const bestHours = sorted.slice(0, 3);

    const result = {
      byHour,
      bestHours,
      totalOrders: allOrders.length,
      totalRevenue: allOrders.reduce((s, o) => s + (o.total_amount || 0), 0),
      days,
    };
    cacheSet(cKey, result, 60);
    ok(res, result);
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Analytics: weekday ─────────────────────────────────────
route('GET', '/api/analytics/weekday', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const days    = Math.min(parseInt(p.get('days') || '30'), 90);
  const cKey    = `analytics:weekday:${storeId}:${days}`;
  const cached  = cacheGet(cKey);
  if (cached) { ok(res, cached); return; }

  try {
    const fromDate = new Date(Date.now() - days * 86400000).toISOString();
    const allOrders = db.prepare(
      "SELECT date_created, total_amount FROM orders WHERE store_id=? AND date_created>=? AND status='paid'"
    ).all(storeId, fromDate);

    const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const byDay = Array.from({ length: 7 }, (_, d) => ({ day: d, name: dayNames[d], orders: 0, revenue: 0 }));

    allOrders.forEach(o => {
      const d = new Date(o.date_created);
      const adjustedMs = d.getTime() - 3 * 3600000;
      const dow = new Date(adjustedMs).getUTCDay();
      byDay[dow].orders++;
      byDay[dow].revenue += o.total_amount || 0;
    });
    byDay.forEach(d => { d.avgTicket = d.orders > 0 ? d.revenue / d.orders : 0; });

    const bestDay = [...byDay].sort((a, b) => b.orders - a.orders)[0];
    const avgOrdersPerDay = allOrders.length / (days || 1);

    const result = { byDay, bestDay, avgOrdersPerDay, days };
    cacheSet(cKey, result, 60);
    ok(res, result);
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Analytics: products ────────────────────────────────────
route('GET', '/api/analytics/products', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const days    = Math.min(parseInt(p.get('days') || '30'), 90);
  const type    = p.get('type') || 'ranking';
  const cKey    = `analytics:products:${storeId}:${days}:${type}`;
  const cached  = cacheGet(cKey);
  if (cached) { ok(res, cached); return; }

  try {
    const fromDate = new Date(Date.now() - days * 86400000).toISOString();

    if (type === 'ranking') {
      const products = db.prepare(`
        SELECT oi.item_id, oi.item_title, COUNT(DISTINCT oi.order_id) as orders, SUM(oi.quantity) as units, SUM(oi.quantity * oi.unit_price) as revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.store_id=? AND o.date_created>=? AND o.status='paid'
        GROUP BY oi.item_id
        ORDER BY revenue DESC
        LIMIT 50
      `).all(storeId, fromDate);

      const result = {
        products: products.map(p => ({ id: p.item_id, title: p.item_title || p.item_id, orders: p.orders, units: p.units, revenue: p.revenue, avgTicket: p.orders > 0 ? p.revenue / p.orders : 0 })),
        days, type,
      };
      cacheSet(cKey, result, 60);
      ok(res, result);

    } else if (type === 'trending' || type === 'declining') {
      const from7 = new Date(Date.now() - 7 * 86400000).toISOString();
      const prevDays = days - 7;

      const recentRows = db.prepare(`
        SELECT oi.item_id, oi.item_title, COUNT(DISTINCT oi.order_id) as orders
        FROM order_items oi JOIN orders o ON o.id=oi.order_id
        WHERE oi.store_id=? AND o.date_created>=? AND o.status='paid'
        GROUP BY oi.item_id
      `).all(storeId, from7);

      const prevRows = db.prepare(`
        SELECT oi.item_id, oi.item_title, COUNT(DISTINCT oi.order_id) as orders
        FROM order_items oi JOIN orders o ON o.id=oi.order_id
        WHERE oi.store_id=? AND o.date_created>=? AND o.date_created<? AND o.status='paid'
        GROUP BY oi.item_id
      `).all(storeId, fromDate, from7);

      const recentMap = {};
      recentRows.forEach(r => { recentMap[r.item_id] = r; });
      const prevMap = {};
      prevRows.forEach(r => { prevMap[r.item_id] = r; });
      const allIds = new Set([...Object.keys(recentMap), ...Object.keys(prevMap)]);

      const products = [];
      allIds.forEach(id => {
        const recent = recentMap[id] || { orders: 0 };
        const prev   = prevMap[id]   || { orders: 0 };
        const recentRate = recent.orders / 7;
        const prevRate   = prevDays > 0 ? prev.orders / prevDays : 0;
        if (prevRate === 0 && recentRate === 0) return;
        const variation = prevRate > 0 ? ((recentRate - prevRate) / prevRate) * 100 : (recentRate > 0 ? 100 : 0);
        const title = (recentMap[id] || prevMap[id])?.item_title || id;
        if (type === 'trending'  && variation >= 20)  products.push({ id, title, recent7d: recent.orders, prevPeriod: prev.orders, variation });
        if (type === 'declining' && variation <= -20) products.push({ id, title, recent7d: recent.orders, prevPeriod: prev.orders, variation });
      });

      products.sort((a, b) => type === 'trending' ? b.variation - a.variation : a.variation - b.variation);
      const result = { products, days, type };
      cacheSet(cKey, result, 60);
      ok(res, result);

    } else if (type === 'problematic') {
      const soldIds = new Set(
        db.prepare(`SELECT DISTINCT oi.item_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.store_id=? AND o.date_created>=? AND o.status='paid'`)
          .all(storeId, fromDate).map(r => r.item_id)
      );

      const activeListings = db.prepare("SELECT id FROM listings WHERE store_id=? AND status='active' LIMIT 100").all(storeId);
      const problematic = activeListings
        .filter(l => !soldIds.has(l.id))
        .map(l => ({ id: l.id, title: l.id, daysSinceLastSale: days }));

      const result = { products: problematic, days, type };
      cacheSet(cKey, result, 60);
      ok(res, result);
    } else {
      apiErr(res, 400, 'type inválido');
    }
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Metrics ────────────────────────────────────────────────
route('GET', '/api/metrics', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const days    = Math.min(parseInt(p.get('days') || '30'), 90);
  const cKey    = `metrics:${storeId}:${days}`;
  const cached  = cacheGet(cKey);
  if (cached) { ok(res, cached); return; }

  try {
    const fromDate = new Date(Date.now() - days * 86400000).toISOString();
    const allOrders = db.prepare(
      "SELECT id, date_created, total_amount FROM orders WHERE store_id=? AND date_created>=? AND status='paid'"
    ).all(storeId, fromDate);

    const totalRevenue = allOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
    const totalOrders  = allOrders.length;
    const avgTicket    = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const topProducts = db.prepare(`
      SELECT oi.item_id as id, oi.item_title as title, SUM(oi.quantity * oi.unit_price) as revenue, SUM(oi.quantity) as units
      FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE oi.store_id=? AND o.date_created>=? AND o.status='paid'
      GROUP BY oi.item_id ORDER BY revenue DESC LIMIT 10
    `).all(storeId, fromDate);

    const daily = {};
    allOrders.forEach(o => {
      const day = o.date_created?.split('T')[0];
      if (!day) return;
      if (!daily[day]) daily[day] = { date: day, revenue: 0, orders: 0 };
      daily[day].revenue += o.total_amount || 0;
      daily[day].orders++;
    });

    const now = new Date();
    const dailyChart = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000).toISOString().split('T')[0];
      dailyChart.push(daily[d] || { date: d, revenue: 0, orders: 0 });
    }

    const result = {
      summary: { totalRevenue, totalOrders, avgTicket },
      dailyChart,
      topProducts: topProducts.map(p => ({ id: p.id, title: p.title || p.id, revenue: p.revenue, units: p.units })),
    };

    cacheSet(cKey, result, 60);
    ok(res, result);
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Performance ────────────────────────────────────────────
route('GET', '/api/performance', async (req, res, sess) => {
  const p = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const period = p.get('period') || '7d';
  const sort = p.get('sort') || 'visits';
  const order = p.get('order') || 'desc';
  const search = (p.get('search') || '').toLowerCase();

  const now = new Date();
  const today = now.toISOString().split('T')[0];

  const periodDays = { yesterday: 1, '3d': 3, '7d': 7, '15d': 15, '30d': 30 };
  const days = periodDays[period] || 7;

  const fromDate = new Date(now - days * 86400000).toISOString().split('T')[0];
  const prevFromDate = new Date(now - days * 2 * 86400000).toISOString().split('T')[0];

  let dateFrom = fromDate;
  let dateTo = today;
  if (period === 'yesterday') {
    const yesterday = new Date(now - 86400000).toISOString().split('T')[0];
    dateFrom = yesterday;
    dateTo = yesterday;
  }

  try {
    const listings = db.prepare('SELECT * FROM listings WHERE store_id=?').all(storeId);

    const visitsRows = db.prepare(`
      SELECT item_id, SUM(visits) as total_visits
      FROM item_visits
      WHERE store_id=? AND date >= ? AND date <= ?
      GROUP BY item_id
    `).all(storeId, dateFrom, dateTo);
    const visitsMap = {};
    visitsRows.forEach(r => { visitsMap[r.item_id] = r.total_visits; });

    const prevVisitsRows = db.prepare(`
      SELECT item_id, SUM(visits) as total_visits
      FROM item_visits
      WHERE store_id=? AND date >= ? AND date < ?
      GROUP BY item_id
    `).all(storeId, prevFromDate, fromDate);
    const prevVisitsMap = {};
    prevVisitsRows.forEach(r => { prevVisitsMap[r.item_id] = r.total_visits; });

    const salesRows = db.prepare(`
      SELECT oi.item_id, COUNT(DISTINCT oi.order_id) as sales, SUM(oi.quantity) as units, SUM(oi.quantity * oi.unit_price) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.store_id=? AND o.date_created >= ? AND o.date_created <= ? AND o.status='paid'
      GROUP BY oi.item_id
    `).all(storeId, dateFrom + 'T00:00:00', dateTo + 'T23:59:59');
    const salesMap = {};
    salesRows.forEach(r => { salesMap[r.item_id] = { sales: r.sales, units: r.units, revenue: r.revenue }; });

    const prevSalesRows = db.prepare(`
      SELECT oi.item_id, COUNT(DISTINCT oi.order_id) as sales, SUM(oi.quantity * oi.unit_price) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.store_id=? AND o.date_created >= ? AND o.date_created < ? AND o.status='paid'
      GROUP BY oi.item_id
    `).all(storeId, prevFromDate + 'T00:00:00', fromDate + 'T00:00:00');
    const prevSalesMap = {};
    prevSalesRows.forEach(r => { prevSalesMap[r.item_id] = { sales: r.sales, revenue: r.revenue }; });

    let items = listings.map(l => {
      const v = visitsMap[l.id] || 0;
      const s = salesMap[l.id] || { sales: 0, units: 0, revenue: 0 };
      const pv = prevVisitsMap[l.id] || 0;
      const ps = prevSalesMap[l.id] || { sales: 0, revenue: 0 };

      const conversion = v > 0 ? (s.units / v) * 100 : 0;
      const prevConversion = pv > 0 ? (ps.sales / pv) * 100 : 0;
      const avgTicket = s.sales > 0 ? s.revenue / s.sales : 0;
      const revenuePerVisit = v > 0 ? s.revenue / v : 0;
      const visitsPerSale = s.sales > 0 ? v / s.sales : 0;

      const visitGrowth = pv > 0 ? ((v - pv) / pv) * 100 : (v > 0 ? 100 : 0);
      const saleGrowth = ps.sales > 0 ? ((s.sales - ps.sales) / ps.sales) * 100 : (s.sales > 0 ? 100 : 0);
      const revenueGrowth = ps.revenue > 0 ? ((s.revenue - ps.revenue) / ps.revenue) * 100 : (s.revenue > 0 ? 100 : 0);

      return {
        id: l.id,
        title: l.title,
        thumbnail: l.thumbnail,
        status: l.status,
        category_id: l.category_id,
        listing_type_id: l.listing_type_id,
        available_quantity: l.available_quantity,
        sold_quantity: l.sold_quantity,
        price: l.price,
        visits: v,
        sales: s.sales,
        units: s.units,
        revenue: s.revenue,
        conversion,
        avgTicket,
        revenuePerVisit,
        visitsPerSale,
        visitGrowth,
        saleGrowth,
        revenueGrowth,
        prevVisits: pv,
        prevSales: ps.sales,
        prevRevenue: ps.revenue,
        prevConversion,
      };
    });

    if (search) {
      items = items.filter(i =>
        i.title.toLowerCase().includes(search) ||
        i.id.toLowerCase().includes(search)
      );
    }

    const withVisits = items.filter(i => i.visits > 0);
    const avgConversion = withVisits.length > 0
      ? withVisits.reduce((s, i) => s + i.conversion, 0) / withVisits.length
      : 0;

    const sortFns = {
      visits:     (a, b) => b.visits - a.visits,
      sales:      (a, b) => b.sales - a.sales,
      revenue:    (a, b) => b.revenue - a.revenue,
      conversion: (a, b) => b.conversion - a.conversion,
      growth:     (a, b) => b.visitGrowth - a.visitGrowth,
    };
    const sortFn = sortFns[sort] || sortFns.visits;
    items.sort(order === 'asc' ? (a, b) => -sortFn(a, b) : sortFn);

    const totalVisits = items.reduce((s, i) => s + i.visits, 0);
    const totalSales = items.reduce((s, i) => s + i.sales, 0);
    const totalRevenue = items.reduce((s, i) => s + i.revenue, 0);
    const avgConversionFinal = totalVisits > 0 ? (totalSales / totalVisits) * 100 : 0;
    const avgTicketFinal = totalSales > 0 ? totalRevenue / totalSales : 0;
    const revenuePerVisitFinal = totalVisits > 0 ? totalRevenue / totalVisits : 0;

    const alerts = [];
    items.forEach(item => {
      if (item.visits > 100 && item.sales === 0)
        alerts.push({ type: 'danger', item_id: item.id, title: item.title, msg: `Alto tráfego (${item.visits} visitas) mas nenhuma venda` });
      else if (item.visits > 50 && item.conversion < avgConversion * 0.5 && avgConversion > 0)
        alerts.push({ type: 'warning', item_id: item.id, title: item.title, msg: `Conversão muito abaixo da média (${item.conversion.toFixed(1)}% vs ${avgConversion.toFixed(1)}%)` });
      if (item.visitGrowth < -30 && item.prevVisits > 20)
        alerts.push({ type: 'danger', item_id: item.id, title: item.title, msg: `Queda de ${Math.abs(item.visitGrowth).toFixed(0)}% nas visitas` });
      if (item.saleGrowth < -20 && item.prevSales > 5)
        alerts.push({ type: 'warning', item_id: item.id, title: item.title, msg: `Queda de ${Math.abs(item.saleGrowth).toFixed(0)}% nas vendas` });
      if (item.visits < 10 && item.conversion > avgConversion * 2 && item.sales > 0)
        alerts.push({ type: 'success', item_id: item.id, title: item.title, msg: `Excelente conversão (${item.conversion.toFixed(1)}%) com baixo tráfego — potencial para Ads` });
      if (item.visitGrowth > 50 && item.saleGrowth < -10)
        alerts.push({ type: 'warning', item_id: item.id, title: item.title, msg: `Tráfego cresceu mas vendas caíram — revisar preço/título/imagens` });
      if (item.conversion > avgConversion * 1.5 && item.sales > 3)
        alerts.push({ type: 'success', item_id: item.id, title: item.title, msg: `Conversão acima da média do catálogo` });
      if (item.available_quantity === 0 && item.visits > 30)
        alerts.push({ type: 'danger', item_id: item.id, title: item.title, msg: `Sem estoque mas recebendo visitas` });
    });

    const itemsWithAvg = items.map(i => ({ ...i, avgConversion }));

    ok(res, {
      items: itemsWithAvg,
      summary: { totalVisits, totalSales, totalRevenue, avgConversion: avgConversionFinal, avgTicket: avgTicketFinal, revenuePerVisit: revenuePerVisitFinal, totalItems: items.length },
      alerts: alerts.slice(0, 20),
      period,
      days,
    });
  } catch (e) {
    console.error('Performance error:', e.message);
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

  // API routes require auth
  if (urlPath.startsWith('/api/')) {
    const sess = getSession(req);
    if (!sess) { apiErr(res, 401, 'Autenticação necessária'); return; }
    if (entry) {
      Promise.resolve(entry.fn(req, res, sess)).catch(e => {
        console.error('API error:', e.message);
        apiErr(res, 500, 'Erro interno');
      });
    } else {
      apiErr(res, 404, 'Não encontrado');
    }
    return;
  }

  // All other routes: serve SPA (frontend handles auth state)
  if (entry) {
    const sess = getSession(req);
    Promise.resolve(entry.fn(req, res, sess)).catch(e => {
      console.error('Route error:', e.message);
      apiErr(res, 500, 'Erro interno');
    });
    return;
  }

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

  Scheduler.start();
});

process.on('SIGTERM', () => { db.close(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
