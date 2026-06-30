'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ============================================================
// CONFIGURATION
// ============================================================
const ML_APP_ID      = process.env.ML_APP_ID;
const ML_APP_SECRET  = process.env.ML_APP_SECRET;
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://multimixvendas.duckdns.org/ml/callback';

if (!ML_APP_ID || !ML_APP_SECRET) {
  console.error('ERRO: ML_APP_ID e ML_APP_SECRET devem ser definidos como variáveis de ambiente.');
  console.error('Copie .env.example para /etc/ml-dashboard.env e preencha os valores.');
  process.exit(1);
}
const PORT           = parseInt(process.env.PORT   || '3001', 10);
const DATA_DIR       = process.env.DATA_DIR        || path.join(__dirname, '..', 'data');
const PUBLIC_DIR     = path.join(__dirname, '..', 'public');

const ML_AUTH_URL  = 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const ML_API       = 'https://api.mercadolibre.com';

const SCHEDULER_CONFIG = {
  batchSize: 50,            // IDs per batch (ML /items?ids= allows up to 20 at a time, we page 50 IDs)
  batchDelay: 60000,        // 1 minute between listing batch pages
  minDelay: 1000,           // minimum delay between API calls (ms)
  maxCallsPerMinute: 15,    // max API calls per minute (ML free tier ~20/min, leave headroom)
  ordersInterval: 300000,   // 5 minutes
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
    last_sync        INTEGER DEFAULT 0,
    -- Multi-tenant enrichment fields (added via migration below)
    country_id       TEXT DEFAULT 'BR',
    currency_id      TEXT DEFAULT 'BRL',
    status           TEXT DEFAULT 'active',
    store_color      TEXT DEFAULT '#FFE600',
    store_icon       TEXT DEFAULT '🏪',
    account_type     TEXT DEFAULT 'seller',
    last_error       TEXT DEFAULT '',
    last_error_at    INTEGER DEFAULT 0,
    sync_status      TEXT DEFAULT 'idle',
    connected_at     INTEGER DEFAULT (unixepoch()),
    permissions      TEXT DEFAULT '[]'
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
    store_id TEXT NOT NULL DEFAULT '',
    key      TEXT NOT NULL,
    value    TEXT,
    PRIMARY KEY (store_id, key)
  );

  CREATE TABLE IF NOT EXISTS sync_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id    TEXT NOT NULL,
    entity      TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    records     INTEGER DEFAULT 0,
    errors      INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'running',
    message     TEXT DEFAULT '',
    endpoints   TEXT DEFAULT '[]'
  );
`);

// Schema migrations (safe to run on every start)
for (const col of [
  "ALTER TABLE listings ADD COLUMN original_price REAL DEFAULT 0",
  "ALTER TABLE listings ADD COLUMN deal_ids TEXT DEFAULT ''",
  // Multi-tenant stores enrichment
  "ALTER TABLE stores ADD COLUMN country_id TEXT DEFAULT 'BR'",
  "ALTER TABLE stores ADD COLUMN currency_id TEXT DEFAULT 'BRL'",
  "ALTER TABLE stores ADD COLUMN status TEXT DEFAULT 'active'",
  "ALTER TABLE stores ADD COLUMN store_color TEXT DEFAULT '#FFE600'",
  "ALTER TABLE stores ADD COLUMN store_icon TEXT DEFAULT '🏪'",
  "ALTER TABLE stores ADD COLUMN account_type TEXT DEFAULT 'seller'",
  "ALTER TABLE stores ADD COLUMN last_error TEXT DEFAULT ''",
  "ALTER TABLE stores ADD COLUMN last_error_at INTEGER DEFAULT 0",
  "ALTER TABLE stores ADD COLUMN sync_status TEXT DEFAULT 'idle'",
  "ALTER TABLE stores ADD COLUMN connected_at INTEGER DEFAULT 0",
  "ALTER TABLE stores ADD COLUMN permissions TEXT DEFAULT '[]'",
  "ALTER TABLE stores ADD COLUMN tax_rate REAL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN shipping_cost REAL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN shipping_id TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN buyer_shipping_cost REAL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN seller_shipping_cost REAL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN shipping_logistic_type TEXT DEFAULT ''",
  "ALTER TABLE order_items ADD COLUMN sale_fee REAL DEFAULT 0",
  // Audit table index
  "CREATE INDEX IF NOT EXISTS idx_sync_audit_store ON sync_audit(store_id, started_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_api_log_store ON api_log(store_id, logged_at DESC)",
]) {
  try { db.exec(col); } catch {}
}

// Monitor config table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
} catch {}

// Messages cache (para detectar novas mensagens)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_cache (
      pack_id    TEXT NOT NULL,
      store_id   TEXT NOT NULL,
      msg_id     TEXT NOT NULL,
      from_user  TEXT DEFAULT '',
      text       TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      notified   INTEGER DEFAULT 0,
      PRIMARY KEY (pack_id, msg_id)
    );
    CREATE TABLE IF NOT EXISTS packs_seen (
      pack_id  TEXT NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT DEFAULT '',
      buyer    TEXT DEFAULT '',
      synced_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (pack_id, store_id)
    );
  `);
} catch {}

// Mapeia mensagens do Telegram para perguntas/conversas ML, permitindo responder via reply no Telegram
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_reply_map (
      tg_message_id INTEGER PRIMARY KEY,
      kind          TEXT NOT NULL,
      question_id   TEXT DEFAULT '',
      pack_id       TEXT DEFAULT '',
      order_id      TEXT DEFAULT '',
      store_id      TEXT NOT NULL,
      item_title    TEXT DEFAULT '',
      buyer         TEXT DEFAULT '',
      created_at    INTEGER DEFAULT (unixepoch())
    );
  `);
} catch {}

// Order costs — manual COGS per order item
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_costs (
      order_id  TEXT NOT NULL,
      item_id   TEXT NOT NULL,
      store_id  TEXT NOT NULL,
      cost      REAL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (order_id, item_id)
    )
  `);
} catch {}

// Reputation table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reputation (
      store_id          TEXT PRIMARY KEY,
      level_id          TEXT DEFAULT '',
      power_seller_status TEXT DEFAULT '',
      transactions_total INTEGER DEFAULT 0,
      transactions_completed INTEGER DEFAULT 0,
      transactions_canceled INTEGER DEFAULT 0,
      ratings_positive  INTEGER DEFAULT 0,
      ratings_negative  INTEGER DEFAULT 0,
      ratings_neutral   INTEGER DEFAULT 0,
      metrics_sales_delayed_pct REAL DEFAULT 0,
      metrics_claims_rate REAL DEFAULT 0,
      metrics_cancellations_rate REAL DEFAULT 0,
      synced_at         INTEGER DEFAULT (unixepoch())
    )
  `);
} catch {}

// Dimensional model — dim_customers
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dim_customers (
      buyer_id       TEXT NOT NULL,
      store_id       TEXT NOT NULL,
      nickname       TEXT DEFAULT '',
      city           TEXT DEFAULT '',
      state          TEXT DEFAULT '',
      state_code     TEXT DEFAULT '',
      country        TEXT DEFAULT 'BR',
      first_order_at TEXT DEFAULT '',
      last_order_at  TEXT DEFAULT '',
      total_orders   INTEGER DEFAULT 0,
      total_spent    REAL DEFAULT 0,
      avg_ticket     REAL DEFAULT 0,
      is_recurrent   INTEGER DEFAULT 0,
      synced_at      INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (buyer_id, store_id)
    )
  `);
} catch {}

// Rastreamento de alertas de anúncios e cancelamentos (evita reenvio)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_alerts_sent (
      kind     TEXT NOT NULL,
      ref_id   TEXT NOT NULL,
      store_id TEXT NOT NULL,
      sent_at  INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (kind, ref_id)
    );
  `);
} catch {}

// cancel_notified and pack_id columns
try { db.exec("ALTER TABLE orders ADD COLUMN cancel_notified INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN pack_id TEXT DEFAULT ''"); } catch {}

// Shipping address column on orders (migration)
for (const col of [
  "ALTER TABLE orders ADD COLUMN receiver_city TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN receiver_state TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN receiver_state_code TEXT DEFAULT ''",
]) { try { db.exec(col); } catch {} }

// Ads tables
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ads_campaigns (
      id           TEXT PRIMARY KEY,
      store_id     TEXT NOT NULL,
      name         TEXT DEFAULT '',
      status       TEXT DEFAULT '',
      type         TEXT DEFAULT '',
      daily_budget REAL DEFAULT 0,
      created_date TEXT DEFAULT '',
      updated_date TEXT DEFAULT '',
      synced_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS ads_groups (
      id          TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      store_id    TEXT NOT NULL,
      name        TEXT DEFAULT '',
      status      TEXT DEFAULT '',
      synced_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS ads_daily_metrics (
      date                   TEXT NOT NULL,
      store_id               TEXT NOT NULL,
      campaign_id            TEXT DEFAULT '',
      group_id               TEXT DEFAULT '',
      item_id                TEXT DEFAULT '',
      sku                    TEXT DEFAULT '',
      ad_id                  TEXT NOT NULL,
      spend                  REAL DEFAULT 0,
      clicks                 INTEGER DEFAULT 0,
      impressions            INTEGER DEFAULT 0,
      conversions            INTEGER DEFAULT 0,
      attributed_revenue     REAL DEFAULT 0,
      ctr                    REAL DEFAULT 0,
      cpc                    REAL DEFAULT 0,
      cpm                    REAL DEFAULT 0,
      roas                   REAL DEFAULT 0,
      acos                   REAL DEFAULT 0,
      tacos                  REAL DEFAULT 0,
      cost_per_conversion    REAL DEFAULT 0,
      revenue_per_click      REAL DEFAULT 0,
      revenue_per_impression REAL DEFAULT 0,
      avg_position           REAL DEFAULT 0,
      synced_at              INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (date, ad_id, store_id)
    );
  `);
} catch {}

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
// RATE LIMITER — per-store, independent buckets
// ============================================================
function makeRateLimiterBucket() {
  return {
    callsThisMinute: 0,
    lastMinuteReset: Date.now(),
    currentDelay: SCHEDULER_CONFIG.minDelay,
    consecutive429: 0,
  };
}

const _rlBuckets = new Map(); // storeId -> bucket

const RateLimiter = {
  // Get or create per-store bucket
  _bucket(storeId) {
    const key = storeId || '_global';
    if (!_rlBuckets.has(key)) _rlBuckets.set(key, makeRateLimiterBucket());
    return _rlBuckets.get(key);
  },

  async wait(storeId) {
    const b = this._bucket(storeId);
    const now = Date.now();
    if (now - b.lastMinuteReset >= 60000) {
      b.callsThisMinute = 0;
      b.lastMinuteReset = now;
    }
    if (b.callsThisMinute >= SCHEDULER_CONFIG.maxCallsPerMinute) {
      const wait = 60000 - (now - b.lastMinuteReset);
      console.log(`[ratelimit:${storeId}] Limite/min atingido — aguardando ${Math.ceil(wait/1000)}s`);
      await new Promise(r => setTimeout(r, wait + 100));
      b.callsThisMinute = 0;
      b.lastMinuteReset = Date.now();
    }
    if (b.currentDelay > SCHEDULER_CONFIG.minDelay) {
      await new Promise(r => setTimeout(r, b.currentDelay));
    }
    b.callsThisMinute++;
  },

  on429(storeId, retryAfterSec = 30) {
    const b = this._bucket(storeId);
    b.consecutive429++;
    const backoffMs = Math.max(retryAfterSec * 1000, 30000);
    b.currentDelay = Math.min(Math.max(b.currentDelay * 2, backoffMs), 120000);
    console.log(`[ratelimit:${storeId}] 429 detectado (#${b.consecutive429}) — delay aumentado para ${b.currentDelay}ms`);
  },

  onSuccess(storeId) {
    const b = this._bucket(storeId);
    if (b.consecutive429 > 0) {
      b.consecutive429 = 0;
      b.currentDelay = Math.max(b.currentDelay * 0.85, SCHEDULER_CONFIG.minDelay);
    }
  },

  async pause(storeId, ms) {
    console.log(`[ratelimit:${storeId}] Pausa forçada de ${ms/1000}s para recuperar rate limit`);
    await new Promise(r => setTimeout(r, ms));
  },

  // Stats for all stores (used in /api/scheduler/status)
  get consecutive429() {
    let max = 0;
    for (const b of _rlBuckets.values()) max = Math.max(max, b.consecutive429);
    return max;
  },
  get currentDelay() {
    let max = SCHEDULER_CONFIG.minDelay;
    for (const b of _rlBuckets.values()) max = Math.max(max, b.currentDelay);
    return max;
  },
  get callsThisMinute() {
    let total = 0;
    for (const b of _rlBuckets.values()) total += b.callsThisMinute;
    return total;
  },
  allStats() {
    const out = {};
    for (const [k, b] of _rlBuckets.entries()) out[k] = { ...b };
    return out;
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
    await RateLimiter.wait(storeId);
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
      RateLimiter.on429(storeId, retrySec);
      console.log(`[api:${storeId}] 429 em ${apiPath} — aguardando ${retrySec}s...`);
      await new Promise(r => setTimeout(r, Math.min(retrySec, 60) * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      db.prepare('UPDATE api_log SET error=? WHERE id=(SELECT MAX(id) FROM api_log)').run(text.slice(0, 200));
      throw new Error(`ML API ${res.status}: ${text.slice(0, 200)}`);
    }
    RateLimiter.onSuccess(storeId);
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

  // Log first item to verify original_price is returned by ML batch API
  const sample = Array.isArray(batch) ? (batch[0]?.body || batch[0]) : null;
  if (sample) console.log(`[listings_batch] sample id=${sample.id} price=${sample.price} original_price=${sample.original_price} deal_ids=${JSON.stringify(sample.deal_ids)}`);

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

    // Detect gap: if last order in DB is older than lastSync, backfill from max DB date
    const maxRow = db.prepare("SELECT MAX(date_created) as max_d FROM orders WHERE store_id=?").get(storeId);
    const maxDbDate = maxRow?.max_d ? new Date(maxRow.max_d) : null;
    const lastSyncDate = lastSync > 0 ? new Date(lastSync * 1000) : null;

    let from;
    if (!lastSync) {
      from = new Date(Date.now() - 30 * 86400000).toISOString(); // first run: 30 days back
    } else {
      from = new Date(lastSync * 1000 - 300000).toISOString(); // 5min overlap
    }
    // Use full datetime to avoid re-fetching all orders from midnight on each sync
    const fromISO = from.slice(0, 19).replace('T', 'T') + '.000-03:00';

    console.log(`[sync] orders store=${storeId} from=${fromISO.slice(0,16)}`);
    let offset = 0, total = 0;

    while (true) {
      const page = await mlFetch(
        `/orders/search?seller=${storeId}&order.status=paid&date_created.from=${encodeURIComponent(fromISO)}&limit=50&offset=${offset}&sort=date_desc`,
        {}, storeId
      );
      if (!page?.results?.length) break;

      const insertOrder = db.prepare(`INSERT OR REPLACE INTO orders(id,store_id,status,total_amount,date_created,date_closed,buyer_id,buyer_nickname,shipping_status,receiver_city,receiver_state,receiver_state_code,shipping_cost,shipping_id,buyer_shipping_cost,seller_shipping_cost,pack_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const deleteItems = db.prepare('DELETE FROM order_items WHERE order_id=?');
      const insertItem = db.prepare(`INSERT INTO order_items(order_id,store_id,item_id,item_title,quantity,unit_price,category_id,sale_fee) VALUES(?,?,?,?,?,?,?,?)`);
      const newOrdersForAlert = [];
      db.transaction((orders) => {
        for (const o of orders) {
          const existing = db.prepare('SELECT id FROM orders WHERE id=?').get(String(o.id));
          const addr = o.shipping?.receiver_address || {};
          // payments[].shipping_cost = what ML charges the SELLER for shipping (not buyer)
          const sellerShipping = (o.payments || []).reduce((s, p) => s + (p.shipping_cost || 0), 0);
          const shippingId = String(o.shipping?.id || '');
          insertOrder.run(
            String(o.id), storeId, o.status, o.total_amount||0, o.date_created, o.date_closed,
            String(o.buyer?.id||''), o.buyer?.nickname||'', o.shipping?.status||'',
            addr.city?.name || addr.city || '',
            addr.state?.name || addr.state || '',
            addr.state?.id || addr.state_code || '',
            sellerShipping, shippingId, 0, sellerShipping,
            String(o.pack_id || '')
          );
          const orderId = String(o.id);
          deleteItems.run(orderId);
          for (const item of (o.order_items||[])) {
            insertItem.run(orderId, storeId, item.item?.id||'', item.item?.title||'', item.quantity||1, item.unit_price||0, item.item?.category_id||'', item.sale_fee||0);
          }
          // logistic_type será buscado pelo job sync_shipment_types separadamente
          if (!existing && o.status === 'paid') {
            newOrdersForAlert.push(o);
          }
        }
      })(page.results);

      // Alerta Telegram para pedidos novos
      if (newOrdersForAlert.length && monitorGet('enabled', false) && monitorGet('alert_pedido_novo', true)) {
        const tgToken  = monitorGet('telegram_token', '');
        const tgChat   = monitorGet('telegram_chat_id', '');
        const store    = db.prepare('SELECT nickname FROM stores WHERE id=?').get(storeId);
        if (tgToken && tgChat) {
          for (const o of newOrdersForAlert) {
            const firstItem = (o.order_items||[])[0];
            const itemTitle = firstItem?.item?.title || 'Produto';
            const shortTitle = itemTitle.length > 40 ? itemTitle.slice(0, 40) + '…' : itemTitle;
            const qtd = (o.order_items||[]).reduce((s, i) => s + (i.quantity||1), 0);
            const msg = `🛒 <b>Novo Pedido!</b>\n👤 ${o.buyer?.nickname || 'Comprador'}\n📦 ${shortTitle}${qtd > 1 ? ` (${qtd} un.)` : ''}\n💰 <b>R$ ${(o.total_amount||0).toFixed(2).replace('.',',')}</b>\n🏪 ${store?.nickname || storeId}`;
            sendTelegram(tgToken, tgChat, msg).catch(() => {});
          }
        }
      }

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
    // ML API /items/visits/time_window accepts only 1 item per call
    const insert = db.prepare('INSERT OR REPLACE INTO item_visits(item_id,store_id,date,visits) VALUES(?,?,?,?)');

    const allIds = db.prepare("SELECT id FROM listings WHERE store_id=? AND status='active'").all(storeId).map(r => r.id);
    if (!allIds.length) {
      console.log(`[sync] visits store=${storeId} — sem anúncios ativos`);
      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'visits', 'ok', '');
      return;
    }

    // Track which items already have visit data so we can skip them on resume
    const doneSet = new Set(
      db.prepare('SELECT DISTINCT item_id FROM item_visits WHERE store_id=?').all(storeId).map(r => r.item_id)
    );
    const pending = allIds.filter(id => !doneSet.has(id));
    console.log(`[sync] visits store=${storeId} total=${allIds.length} pending=${pending.length} done=${doneSet.size}`);

    let totalEntries = 0;
    let errors = 0;
    let baseDelay = 3000; // 3s between calls — conservative to avoid 429
    for (let i = 0; i < pending.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, baseDelay));
      const itemId = pending[i];
      const data = await mlFetch(
        `/items/visits/time_window?ids=${itemId}&last=30&unit=day`,
        {}, storeId
      ).catch(e => {
        errors++;
        console.error(`[sync] visits item ${itemId} error:`, e.message);
        if (e.message.includes('429')) {
          baseDelay = Math.min(baseDelay * 2, 15000); // back off up to 15s
          console.log(`[sync] visits 429 — baseDelay aumentado para ${baseDelay}ms`);
        }
        return null;
      });

      if (!data) continue;

      if (i === 0) {
        console.log(`[sync_visits] first item raw: ${JSON.stringify(data).slice(0, 400)}`);
      }

      const item = Array.isArray(data) ? data[0] : data;
      if (!item) {
        // Insert a zero-placeholder so this item is skipped on resume
        insert.run(itemId, storeId, new Date().toISOString().split('T')[0], 0);
        continue;
      }

      // API returns { results: [{date, total}] }
      const visitList = item.results || item.visits || [];
      if (!visitList.length) {
        // Placeholder so resume skips it
        insert.run(itemId, storeId, new Date().toISOString().split('T')[0], 0);
        continue;
      }
      db.transaction((rows) => {
        for (const v of rows) {
          const date = (v.date || v.day || '').split('T')[0];
          if (!date) continue;
          const total = v.total || v.visits || 0;
          insert.run(itemId, storeId, date, total);
          if (total > 0) totalEntries++;
        }
      })(visitList);

      // Log progress every 10 items
      if ((i + 1) % 10 === 0) {
        console.log(`[sync] visits progress ${i + 1}/${pending.length} entries=${totalEntries}`);
        // Update sync_log so partial progress is visible
        db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'visits', 'partial', `${i+1}/${pending.length}`);
      }
    }

    db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'visits', 'ok', '');
    console.log(`[sync] visits done store=${storeId} ids=${allIds.length} entries=${totalEntries} errors=${errors}`);
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
      console.log(`[sync] promotions promo=${promo.id} items=${promoItems.length} sample=${JSON.stringify(promoItems[0] || {}).slice(0,200)}`);

      const updateListing = db.prepare(`UPDATE listings SET original_price=? WHERE id=? AND store_id=? AND original_price=0`);

      db.transaction((rows) => {
        for (const pi of rows) {
          // ML returns item_id as the ML item ID (e.g. MLB123456789)
          // id may be a numeric promo-item ID — always prefer item_id
          const itemId    = pi.item_id || (typeof pi.id === 'string' && pi.id.startsWith('ML') ? pi.id : null);
          if (!itemId) continue;

          const origPrice = pi.original_price || pi.regular_price || 0;
          const newPrice  = pi.new_price || pi.sale_price || pi.price || 0;
          const discPct   = origPrice > 0 && newPrice > 0 ? ((origPrice - newPrice) / origPrice) * 100 : 0;

          upsertItem.run(String(promo.id), itemId, storeId, origPrice, newPrice, discPct);

          // Also stamp original_price on the listing directly so enrichment works even without JOIN
          if (origPrice > 0) updateListing.run(origPrice, itemId, storeId);
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

  async sync_reputation(storeId) {
    console.log(`[sync] reputation store=${storeId}`);
    const data = await mlFetch(`/users/${storeId}`, {}, storeId).catch(e => {
      console.error('[sync] reputation error:', e.message);
      return null;
    });
    if (!data) return;

    const rep = data.seller_reputation || {};
    const tx  = rep.transactions || {};
    const rat = tx.ratings || {};
    const met = rep.metrics || {};

    db.prepare(`
      INSERT OR REPLACE INTO reputation(
        store_id, level_id, power_seller_status,
        transactions_total, transactions_completed, transactions_canceled,
        ratings_positive, ratings_negative, ratings_neutral,
        metrics_sales_delayed_pct, metrics_claims_rate, metrics_cancellations_rate,
        synced_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
    `).run(
      storeId,
      rep.level_id || '',
      rep.power_seller_status || '',
      tx.total || 0,
      tx.completed || 0,
      tx.canceled || 0,
      rat.positive || 0,
      rat.negative || 0,
      rat.neutral || 0,
      met.sales?.delayed?.rate || 0,
      met.claims?.rate || 0,
      met.cancellations?.rate || 0
    );

    db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'reputation', 'ok', '');
    console.log(`[sync] reputation done store=${storeId} level=${rep.level_id}`);
  },

  sync_customers(storeId) {
    console.log(`[sync] customers store=${storeId}`);

    // Aggregate dim_customers from orders — pure SQL, no API calls needed
    const rows = db.prepare(`
      SELECT
        o.buyer_id,
        o.buyer_nickname AS nickname,
        MAX(o.receiver_city)       AS city,
        MAX(o.receiver_state)      AS state,
        MAX(o.receiver_state_code) AS state_code,
        MIN(o.date_created) AS first_order_at,
        MAX(o.date_created) AS last_order_at,
        COUNT(*)            AS total_orders,
        SUM(o.total_amount) AS total_spent
      FROM orders o
      WHERE o.store_id=? AND o.buyer_id != '' AND o.status='paid'
      GROUP BY o.buyer_id
    `).all(storeId);

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO dim_customers(
        buyer_id, store_id, nickname, city, state, state_code,
        first_order_at, last_order_at,
        total_orders, total_spent, avg_ticket, is_recurrent, synced_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
    `);

    db.transaction((customers) => {
      for (const c of customers) {
        const avg = c.total_orders > 0 ? (c.total_spent / c.total_orders) : 0;
        upsert.run(
          c.buyer_id, storeId,
          c.nickname || '', c.city || '', c.state || '', c.state_code || '',
          c.first_order_at || '', c.last_order_at || '',
          c.total_orders, c.total_spent, avg,
          c.total_orders > 1 ? 1 : 0
        );
      }
    })(rows);

    db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'customers', 'ok', '');
    console.log(`[sync] customers done store=${storeId} count=${rows.length}`);
  },

  async sync_ads_campaigns(storeId) {
    console.log(`[sync] ads_campaigns store=${storeId}`);
    try {
      // Get advertiser_id
      const advData = await mlFetch(`/advertising/advertisers?user_id=${storeId}`, {}, storeId).catch(e => {
        console.log(`[sync] ads_campaigns advertisers error: ${e.message.slice(0,200)}`);
        return null;
      });
      if (!advData) {
        db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_campaigns', 'ok', '');
        console.log(`[sync] ads_campaigns store=${storeId} — sem acesso a advertising`);
        return;
      }
      console.log(`[sync] ads_campaigns advData=${JSON.stringify(advData).slice(0,200)}`);
      const advertiserId = advData.advertiser_id || advData.id || (Array.isArray(advData) ? advData[0]?.id : null);
      if (!advertiserId) {
        db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_campaigns', 'ok', '');
        console.log(`[sync] ads_campaigns — advertiserId não encontrado em:`, JSON.stringify(advData).slice(0,300));
        return;
      }

      const campData = await mlFetch(`/advertising/advertisers/${advertiserId}/campaigns?limit=100`, {}, storeId).catch(e => {
        console.log(`[sync] ads_campaigns campaigns error: ${e.message.slice(0,200)}`); return null;
      });
      const campaigns = campData?.results || campData || [];

      const upsertCampaign = db.prepare(`
        INSERT OR REPLACE INTO ads_campaigns(id,store_id,name,status,type,daily_budget,created_date,updated_date,synced_at)
        VALUES(?,?,?,?,?,?,?,?,unixepoch())
      `);

      db.transaction((rows) => {
        for (const c of rows) {
          upsertCampaign.run(
            String(c.id), storeId,
            c.name || '', c.status || '', c.type || '',
            c.daily_budget || 0,
            c.date_created || c.created_date || '',
            c.last_updated || c.updated_date || ''
          );
        }
      })(campaigns);

      const upsertGroup = db.prepare(`
        INSERT OR REPLACE INTO ads_groups(id,campaign_id,store_id,name,status,synced_at)
        VALUES(?,?,?,?,?,unixepoch())
      `);

      for (const c of campaigns) {
        await new Promise(r => setTimeout(r, 1000));
        const groupData = await mlFetch(`/advertising/advertisers/${advertiserId}/ad_groups?campaign_id=${c.id}&limit=50`, {}, storeId).catch(() => null);
        const groups = groupData?.results || groupData || [];
        db.transaction((rows) => {
          for (const g of rows) {
            upsertGroup.run(String(g.id), String(c.id), storeId, g.name || '', g.status || '');
          }
        })(groups);
      }

      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_campaigns', 'ok', '');
      console.log(`[sync] ads_campaigns done store=${storeId} count=${campaigns.length}`);
    } catch (e) {
      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_campaigns', 'ok', e.message.slice(0, 200));
      console.log(`[sync] ads_campaigns soft-error store=${storeId}: ${e.message.slice(0,200)}`);
      // Don't rethrow — ads is optional, don't break the scheduler
    }
  },

  async sync_ads_metrics(storeId) {
    console.log(`[sync] ads_metrics store=${storeId}`);
    try {
      const advData = await mlFetch(`/advertising/advertisers?user_id=${storeId}`, {}, storeId).catch(e => {
        if (e.message.includes('403') || e.message.includes('404')) return null;
        throw e;
      });
      if (!advData) {
        db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_metrics', 'ok', '');
        return;
      }
      const advertiserId = advData.advertiser_id || advData.id || (Array.isArray(advData) ? advData[0]?.id : null);
      if (!advertiserId) {
        db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_metrics', 'ok', '');
        return;
      }

      const upsert = db.prepare(`
        INSERT OR REPLACE INTO ads_daily_metrics(
          date,store_id,campaign_id,group_id,item_id,sku,ad_id,
          spend,clicks,impressions,conversions,attributed_revenue,
          ctr,cpc,cpm,roas,acos,tacos,cost_per_conversion,revenue_per_click,revenue_per_impression,avg_position,
          synced_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
      `);

      // Sync past 7 days
      const now = new Date();
      const yesterday = new Date(now - 86400000);
      const dateFrom = new Date(now - 7 * 86400000).toISOString().split('T')[0];
      const dateTo   = yesterday.toISOString().split('T')[0];

      await new Promise(r => setTimeout(r, 1000));

      // Try campaign-level summary first (no product_id required)
      let reportData = await mlFetch(
        `/advertising/advertisers/${advertiserId}/reports/campaigns?date_from=${dateFrom}&date_to=${dateTo}&limit=100`,
        {}, storeId
      ).catch(e => {
        console.log(`[sync] ads_metrics campaigns report error: ${e.message.slice(0,200)}`);
        return null;
      });

      // Fallback: try product-level report without product_id filter
      if (!reportData) {
        reportData = await mlFetch(
          `/advertising/advertisers/${advertiserId}/reports?date_from=${dateFrom}&date_to=${dateTo}&limit=100`,
          {}, storeId
        ).catch(e => {
          console.log(`[sync] ads_metrics fallback report error: ${e.message.slice(0,200)}`);
          return null;
        });
      }

      if (!reportData) {
        db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_metrics', 'ok', 'no report data from ML API');
        console.log(`[sync] ads_metrics store=${storeId} — sem dados de relatório da API`);
        return;
      }

      const rows = reportData?.results || reportData?.data || reportData?.summary || (Array.isArray(reportData) ? reportData : []);
      console.log(`[sync] ads_metrics rows=${rows.length} sample=${JSON.stringify(rows[0]||{}).slice(0,300)}`);

      db.transaction((items) => {
        for (const row of items) {
          const spend     = row.spend || 0;
          const clicks    = row.clicks || 0;
          const imps      = row.impressions || 0;
          const convs     = row.conversions || 0;
          const revenue   = row.attributed_revenue || 0;
          const date      = (row.date || '').split('T')[0];

          // Get total sales for tacos (organic + paid)
          const totalRevRow = db.prepare(`
            SELECT SUM(oi.quantity * oi.unit_price) as total
            FROM order_items oi JOIN orders o ON o.id=oi.order_id
            WHERE oi.store_id=? AND oi.item_id=? AND o.date_created >= ? AND o.date_created <= ? AND o.status='paid'
          `).get(storeId, row.item_id || '', date + 'T00:00:00', date + 'T23:59:59');
          const totalRev = totalRevRow?.total || 0;

          const ctr   = imps > 0 ? (clicks / imps) * 100 : 0;
          const cpc   = clicks > 0 ? spend / clicks : 0;
          const cpm   = imps > 0 ? (spend / imps) * 1000 : 0;
          const roas  = spend > 0 ? revenue / spend : 0;
          const acos  = revenue > 0 ? (spend / revenue) * 100 : 0;
          const tacos = totalRev > 0 ? (spend / totalRev) * 100 : 0;
          const cpc2  = convs > 0 ? spend / convs : 0;
          const rpc   = clicks > 0 ? revenue / clicks : 0;
          const rpi   = imps > 0 ? revenue / imps : 0;

          upsert.run(
            date, storeId,
            String(row.campaign_id || ''), String(row.group_id || ''),
            String(row.item_id || ''), String(row.sku || ''), String(row.ad_id || row.item_id || ''),
            spend, clicks, imps, convs, revenue,
            ctr, cpc, cpm, roas, acos, tacos, cpc2, rpc, rpi,
            row.avg_position || 0
          );
        }
      })(rows);

      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_metrics', 'ok', '');
      console.log(`[sync] ads_metrics done store=${storeId} rows=${rows.length}`);
    } catch (e) {
      db.prepare('INSERT OR REPLACE INTO sync_log(store_id,entity,last_sync,status,error) VALUES(?,?,unixepoch(),?,?)').run(storeId, 'ads_metrics', 'error', e.message.slice(0, 500));
      console.error('[sync] ads_metrics error:', e.message);
      throw e;
    }
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
    db.prepare("UPDATE stores SET sync_status='syncing' WHERE id=?").run(job.store_id);
    this.currentJob = job;
    const t0 = Date.now();
    const auditId = db.prepare(
      'INSERT INTO sync_audit(store_id,entity,started_at) VALUES(?,?,unixepoch())'
    ).run(job.store_id, job.type).lastInsertRowid;

    try {
      // If this store has been getting 429s, pause before starting
      const rl = RateLimiter._bucket(job.store_id);
      if (rl.consecutive429 >= 3) {
        await RateLimiter.pause(job.store_id, 60000);
      }

      const payload = JSON.parse(job.payload || '{}');
      await JOB_HANDLERS[job.type]?.(job.store_id, payload);
      const dur = Date.now() - t0;
      db.prepare('UPDATE job_queue SET status=?, completed_at=unixepoch(), duration_ms=? WHERE id=?')
        .run('completed', dur, job.id);
      db.prepare("UPDATE stores SET sync_status='idle', last_sync=unixepoch() WHERE id=?").run(job.store_id);
      db.prepare('UPDATE sync_audit SET status=?,finished_at=unixepoch(),duration_ms=? WHERE id=?')
        .run('ok', dur, auditId);
      console.log(`[scheduler] ✓ ${job.type} store=${job.store_id} (${dur}ms)`);
    } catch (e) {
      const attempts = job.attempts + 1;
      const is429 = e.message.includes('429') || e.message.includes('rate limit');
      const retryDelays = is429
        ? [600000, 1800000, 3600000]
        : [300000, 900000, 1800000];
      const dur = Date.now() - t0;
      if (attempts < job.max_attempts) {
        const delay = retryDelays[attempts - 1] || 3600000;
        db.prepare('UPDATE job_queue SET status=?, error=?, scheduled_at=unixepoch()+? WHERE id=?')
          .run('pending', e.message.slice(0, 500), Math.floor(delay/1000), job.id);
        db.prepare("UPDATE stores SET sync_status='idle' WHERE id=?").run(job.store_id);
        console.log(`[scheduler] ✗ ${job.type} tentativa ${attempts}/${job.max_attempts} — retry em ${delay/60000}min`);
      } else {
        db.prepare('UPDATE job_queue SET status=?, completed_at=unixepoch(), duration_ms=?, error=? WHERE id=?')
          .run('failed', dur, e.message.slice(0, 500), job.id);
        db.prepare("UPDATE stores SET sync_status='error', last_error=?, last_error_at=unixepoch() WHERE id=?")
          .run(e.message.slice(0, 300), job.store_id);
        console.error(`[scheduler] FALHA PERMANENTE ${job.type} store=${job.store_id}:`, e.message);
      }
      db.prepare('UPDATE sync_audit SET status=?,finished_at=unixepoch(),duration_ms=?,message=? WHERE id=?')
        .run('error', dur, e.message.slice(0, 300), auditId);
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
    // On startup: reschedule interrupted jobs based on last_sync — don't run immediately
    const JOB_INTERVALS = {
      sync_orders:        SCHEDULER_CONFIG.ordersInterval / 1000,
      sync_questions:     SCHEDULER_CONFIG.questionsInterval / 1000,
      sync_listings_batch: SCHEDULER_CONFIG.stockInterval / 1000,
      sync_visits:        86400,
      sync_promotions:    14400,
      sync_reputation:    21600,
      sync_customers:     3600,
      sync_ads_campaigns: 1800,
      sync_ads_metrics:   7200,
    };
    const stuckJobs = db.prepare("SELECT * FROM job_queue WHERE status='running' OR status='pending'").all();
    let rescheduled = 0;
    const seen = new Set();
    for (const job of stuckJobs) {
      const key = `${job.type}:${job.store_id}`;
      // Deduplicate: keep only first occurrence per type+store
      if (seen.has(key)) {
        db.prepare("DELETE FROM job_queue WHERE id=?").run(job.id);
        continue;
      }
      seen.add(key);

      const entity = job.type.replace('sync_', '');
      const lastSync = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity=?").get(job.store_id, entity);
      const interval = JOB_INTERVALS[job.type] || 1800;
      const nowSec = Math.floor(Date.now() / 1000);

      if (lastSync && (nowSec - lastSync.last_sync) < interval) {
        // Recently synced — delay until next window
        const nextRun = lastSync.last_sync + interval;
        const waitMin = Math.round((nextRun - nowSec) / 60);
        db.prepare("UPDATE job_queue SET status='pending', scheduled_at=?, error='' WHERE id=?").run(nextRun, job.id);
        console.log(`[scheduler] ${job.type} store=${job.store_id} já sincronizado — próxima execução em ${waitMin}min`);
        rescheduled++;
      } else {
        db.prepare("UPDATE job_queue SET status='pending', scheduled_at=unixepoch(), error='' WHERE id=?").run(job.id);
      }
    }
    if (rescheduled > 0) console.log(`[scheduler] ${rescheduled} job(s) reagendados para próxima janela`);

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

      // Sync reputation if never done or stale (> 6h)
      const lastR = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='reputation'").get(s.id);
      const repStale = !lastR || (Date.now()/1000 - lastR.last_sync) > 21600;
      if (repStale) this.enqueue('sync_reputation', s.id, 4, {}, base + 240000);

      // Sync customers dimension if never done or stale (> 1h) — runs after orders
      const lastCust = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='customers'").get(s.id);
      const custStale = !lastCust || (Date.now()/1000 - lastCust.last_sync) > 3600;
      if (custStale) this.enqueue('sync_customers', s.id, 5, {}, base + 300000);

      // Sync ads campaigns if never done or stale (> 30min)
      const lastAC = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='ads_campaigns'").get(s.id);
      const adsCampStale = !lastAC || (Date.now()/1000 - lastAC.last_sync) > 1800;
      if (adsCampStale) this.enqueue('sync_ads_campaigns', s.id, 5, {}, base + 360000);

      // Sync ads metrics if never done or stale (> 2h)
      const lastAM = db.prepare("SELECT last_sync FROM sync_log WHERE store_id=? AND entity='ads_metrics'").get(s.id);
      const adsMetStale = !lastAM || (Date.now()/1000 - lastAM.last_sync) > 7200;
      if (adsMetStale) this.enqueue('sync_ads_metrics', s.id, 5, {}, base + 420000);
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

    // Customers dimension: every 1h (after orders sync)
    setInterval(() => this.enqueueForAllStores('sync_customers', 5), 3600000);

    // Ads campaigns: every 30 min
    setInterval(() => this.enqueueForAllStores('sync_ads_campaigns', 5), 1800000);
    // Ads metrics: every 2h
    setInterval(() => this.enqueueForAllStores('sync_ads_metrics', 5), 7200000);
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
      INSERT INTO stores(id,nickname,email,access_token,refresh_token,token_expires_at,site_id,permalink,thumbnail,
                         country_id,currency_id,status,connected_at,sync_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',unixepoch(),'idle')
      ON CONFLICT(id) DO UPDATE SET
        nickname=excluded.nickname, email=excluded.email,
        access_token=excluded.access_token, refresh_token=excluded.refresh_token,
        token_expires_at=excluded.token_expires_at, permalink=excluded.permalink, thumbnail=excluded.thumbnail,
        status='active', sync_status='idle', last_error='', last_error_at=0
    `).run(
      String(user.id), user.nickname || '', user.email || '',
      tokens.access_token, tokens.refresh_token || '', exp,
      user.site_id || 'MLB', user.permalink || '', thumbUrl,
      user.country_id || 'BR', user.currency_id || 'BRL',
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
  const stores = db.prepare(`
    SELECT s.id, s.nickname, s.email, s.site_id, s.permalink, s.thumbnail,
           s.created_at, s.last_sync, s.status, s.store_color, s.store_icon,
           s.account_type, s.sync_status, s.last_error, s.last_error_at,
           s.country_id, s.currency_id, s.connected_at, s.tax_rate,
           (SELECT sl.status FROM sync_log sl WHERE sl.store_id=s.id ORDER BY sl.last_sync DESC LIMIT 1) as last_sync_status,
           (SELECT COUNT(*) FROM orders WHERE store_id=s.id AND status='paid') as total_orders,
           (SELECT COUNT(*) FROM listings WHERE store_id=s.id AND status='active') as active_listings
    FROM stores s
    ORDER BY s.nickname
  `).all();
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
  const store  = db.prepare('SELECT id,nickname,email,site_id,permalink,thumbnail,store_color,store_icon,account_type,sync_status,status FROM stores WHERE id=?').get(sess.store_id);
  const stores = db.prepare('SELECT id,nickname,thumbnail,store_color,store_icon,status,sync_status FROM stores ORDER BY nickname').all();
  ok(res, { store, stores });
});

// ── Store sync status ────────────────────────────────────────
route('GET', '/api/stores/sync-status', (req, res, sess) => {
  const rows = db.prepare(`
    SELECT s.id, s.nickname, s.sync_status, s.last_sync, s.last_error,
           sl.entity, sl.last_sync as entity_sync, sl.status as entity_status
    FROM stores s
    LEFT JOIN sync_log sl ON sl.store_id = s.id
    ORDER BY s.nickname, sl.entity
  `).all();
  // Group by store
  const byStore = {};
  rows.forEach(r => {
    if (!byStore[r.id]) byStore[r.id] = { id: r.id, nickname: r.nickname, sync_status: r.sync_status, last_sync: r.last_sync, last_error: r.last_error, entities: [] };
    if (r.entity) byStore[r.id].entities.push({ entity: r.entity, last_sync: r.entity_sync, status: r.entity_status });
  });
  ok(res, { stores: Object.values(byStore) });
});

// ── Update store settings ────────────────────────────────────
route('PUT', '/api/stores', async (req, res, sess) => {
  const body = await readBody(req);
  const id   = qp(req).get('id') || sess.store_id;
  const allowed = ['store_color', 'store_icon', 'nickname', 'tax_rate'];
  const updates = {};
  allowed.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
  if (!Object.keys(updates).length) { apiErr(res, 400, 'Nenhum campo válido para atualizar'); return; }
  const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE stores SET ${sets} WHERE id=?`).run(...Object.values(updates), id);
  ok(res, { ok: true });
});

// ── Vendas Totais ──────────────────────────────────────────
route('GET', '/api/vendas-totais', (req, res, sess) => {
  const p      = qp(req);
  const limit  = Math.min(parseInt(p.get('limit') || '50', 10), 200);
  const offset = parseInt(p.get('offset') || '0', 10);
  const sortCol = { date: 'o.date_created', faturamento: 'faturamento', custo: 'oc_cost', loja: 's.nickname' }[p.get('sort')] || 'o.date_created';
  const sortDir = p.get('order') === 'asc' ? 'ASC' : 'DESC';
  const storeFilter = p.get('storeId'); // optional — omit to get all

  const dateFrom = p.get('dateFrom');
  const dateTo   = p.get('dateTo');
  const conditions = [];
  const params = [];
  if (storeFilter) { conditions.push('o.store_id=?');           params.push(storeFilter); }
  if (dateFrom)    { conditions.push("o.date_created >= ?");    params.push(dateFrom + 'T00:00:00'); }
  if (dateTo)      { conditions.push("o.date_created <= ?");    params.push(dateTo   + 'T23:59:59'); }
  const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      oi.order_id, oi.item_id, oi.item_title, oi.quantity, oi.unit_price,
      COALESCE(oi.sale_fee, 0) AS sale_fee,
      o.date_created, o.store_id, o.total_amount,
      COALESCE(o.buyer_shipping_cost, o.shipping_cost, 0) AS buyer_shipping_cost,
      COALESCE(o.seller_shipping_cost, 0) AS seller_shipping_cost,
      COALESCE(o.shipping_logistic_type, '') AS shipping_logistic_type,
      o.buyer_id, o.buyer_nickname,
      o.receiver_city, o.receiver_state, o.receiver_state_code,
      s.nickname  AS store_name,
      s.store_color,
      s.store_icon,
      COALESCE(s.tax_rate, 0)  AS tax_rate,
      COALESCE(l.thumbnail, '') AS thumbnail,
      COALESCE(oc.cost, 0) AS oc_cost,
      (oi.unit_price * oi.quantity) AS faturamento
    FROM order_items oi
    JOIN orders o  ON o.id = oi.order_id
    JOIN stores s  ON s.id = o.store_id
    LEFT JOIN listings l    ON l.id = oi.item_id AND l.store_id = oi.store_id
    LEFT JOIN order_costs oc ON oc.order_id = oi.order_id AND oc.item_id = oi.item_id
    WHERE o.status = 'paid' ${where}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS n
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' ${where}
  `).get(...params).n;

  const totRow = db.prepare(`
    SELECT
      SUM(oi.unit_price * oi.quantity) AS fat_total,
      SUM(COALESCE(oc.cost, 0)) AS custo_total,
      SUM((oi.unit_price * oi.quantity) * COALESCE(s.tax_rate, 0) / 100) AS imposto_total,
      SUM(COALESCE(oi.sale_fee, 0)) AS tarifa_total,
      SUM(COALESCE(o.buyer_shipping_cost, o.shipping_cost, 0)) AS frete_c_total,
      SUM(COALESCE(o.seller_shipping_cost, 0)) AS frete_v_total,
      SUM(oi.quantity) AS unidades_total,
      COUNT(DISTINCT o.id) AS pedidos_total,
      COUNT(*) AS qty
    FROM order_items oi
    JOIN orders o  ON o.id = oi.order_id
    JOIN stores s  ON s.id = o.store_id
    LEFT JOIN order_costs oc ON oc.order_id = oi.order_id AND oc.item_id = oi.item_id
    WHERE o.status = 'paid' ${where}
  `).get(...params);

  const cancelRow = db.prepare(`
    SELECT SUM(COALESCE(oi.unit_price * oi.quantity, 0)) AS cancelled_total
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('cancelled','invalid') ${where}
  `).get(...params);

  const fat_t    = totRow.fat_total    || 0;
  const custo_t  = totRow.custo_total  || 0;
  const imp_t    = totRow.imposto_total|| 0;
  const tar_t    = totRow.tarifa_total || 0;
  const fretec_t = totRow.frete_c_total|| 0;
  const fretev_t = totRow.frete_v_total|| 0;
  const margem_t = fat_t - custo_t - imp_t - tar_t - fretev_t;
  const mc_pct_t = fat_t > 0 ? (margem_t / fat_t) * 100 : 0;

  const totals = {
    faturamento:       fat_t,
    vendas_canceladas: cancelRow.cancelled_total || 0,
    custo:             custo_t,
    imposto:           imp_t,
    custo_imposto:     custo_t + imp_t,
    tarifa:            tar_t,
    frete_comprador:   fretec_t,
    frete_vendedor:    fretev_t,
    frete_total:       fretec_t + fretev_t,
    margem:            margem_t,
    mc_pct:            mc_pct_t,
    count:             totRow.qty || 0,
    pedidos:           totRow.pedidos_total || 0,
    unidades:          totRow.unidades_total || 0,
  };

  // Comparativo: vendas de hoje (até agora) vs. vendas de ontem no mesmo horário
  // Usa deslocamento fixo de -3h (Brasília) a partir do UTC, em vez de 'localtime' do SO
  // (o servidor roda em UTC — 'localtime' daria o horário errado, mesmo bug já corrigido nos alertas do Telegram)
  const compStoreWhere = storeFilter ? 'AND o.store_id = ?' : '';
  const compParams = storeFilter ? [storeFilter] : [];
  const hojeRow = db.prepare(`
    SELECT COUNT(DISTINCT o.id) AS pedidos, SUM(oi.unit_price * oi.quantity) AS faturamento, SUM(oi.quantity) AS unidades
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' ${compStoreWhere}
      AND date(o.date_created, '-3 hours') = date('now', '-3 hours')
      AND time(o.date_created, '-3 hours') <= time('now', '-3 hours')
  `).get(...compParams);
  const ontemRow = db.prepare(`
    SELECT COUNT(DISTINCT o.id) AS pedidos, SUM(oi.unit_price * oi.quantity) AS faturamento, SUM(oi.quantity) AS unidades
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' ${compStoreWhere}
      AND date(o.date_created, '-3 hours') = date('now', '-1 day', '-3 hours')
      AND time(o.date_created, '-3 hours') <= time('now', '-3 hours')
  `).get(...compParams);

  const variacaoPct = (atual, anterior) => anterior > 0 ? ((atual - anterior) / anterior) * 100 : (atual > 0 ? 100 : 0);
  const comparativo = {
    hoje:  { pedidos: hojeRow.pedidos || 0,  faturamento: hojeRow.faturamento || 0,  unidades: hojeRow.unidades || 0 },
    ontem: { pedidos: ontemRow.pedidos || 0, faturamento: ontemRow.faturamento || 0, unidades: ontemRow.unidades || 0 },
    variacao_faturamento_pct: variacaoPct(hojeRow.faturamento || 0, ontemRow.faturamento || 0),
    variacao_pedidos_pct:     variacaoPct(hojeRow.pedidos || 0, ontemRow.pedidos || 0),
    hora_referencia: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
  };

  const vendas = rows.map(r => {
    const fat      = r.faturamento  || 0;
    const custo    = r.oc_cost      || 0;
    const imposto  = fat * (r.tax_rate / 100);
    const tarifa   = r.sale_fee     || 0;
    const frete_c  = r.buyer_shipping_cost  || 0;
    const frete_v  = r.seller_shipping_cost || 0;
    const margem   = fat - custo - imposto - tarifa - frete_v;
    const mc_pct   = fat > 0 ? (margem / fat) * 100 : 0;
    return {
      order_id:    r.order_id,
      item_id:     r.item_id,
      item_title:  r.item_title,
      sku:         r.item_id || '',
      date:        r.date_created,
      store_id:    r.store_id,
      store_name:  r.store_name,
      store_color: r.store_color,
      store_icon:  r.store_icon,
      tax_rate:    r.tax_rate,
      unit_price:  r.unit_price,
      quantity:    r.quantity,
      thumbnail:       r.thumbnail || '',
      buyer_id:        r.buyer_id || '',
      buyer_nickname:  r.buyer_nickname || '',
      receiver_city:   r.receiver_city || '',
      receiver_state:  r.receiver_state || '',
      receiver_state_code: r.receiver_state_code || '',
      faturamento:     fat,
      custo,
      imposto,
      tarifa,
      frete_comprador:     frete_c,
      frete_vendedor:      frete_v,
      frete_total:         frete_c + frete_v,
      shipping_type:       r.shipping_logistic_type || '',
      margem,
      mc_pct,
    };
  });

  ok(res, { vendas, totals, comparativo, paging: { total, limit, offset } });
});

route('PUT', '/api/vendas-totais/cost', async (req, res, sess) => {
  const body = await readBody(req);
  const { order_id, item_id, store_id, cost } = body;
  if (!order_id || !item_id) { apiErr(res, 400, 'order_id e item_id obrigatórios'); return; }
  const c = parseFloat(cost) || 0;
  db.prepare(`
    INSERT INTO order_costs(order_id, item_id, store_id, cost, updated_at)
    VALUES(?,?,?,?,unixepoch())
    ON CONFLICT(order_id, item_id) DO UPDATE SET cost=excluded.cost, updated_at=unixepoch()
  `).run(order_id, item_id, store_id || '', c);
  ok(res, { ok: true });
});

// ── CFO Briefing ───────────────────────────────────────────
route('GET', '/api/cfo-briefing', (req, res, sess) => {
  const days = parseInt(qp(req).get('days') || '30', 10);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const stores = db.prepare(`SELECT id, nickname, store_color, tax_rate FROM stores WHERE active=1`).all();

  // Revenue & margin per product (all stores)
  const products = db.prepare(`
    SELECT
      oi.item_id, oi.item_title,
      s.nickname AS store,
      COUNT(*) AS pedidos,
      SUM(oi.quantity) AS unidades,
      ROUND(SUM(oi.unit_price * oi.quantity), 2) AS faturamento,
      ROUND(AVG(oi.unit_price), 2) AS preco_medio,
      ROUND(SUM(COALESCE(oc.cost,0)), 2) AS custo_total,
      ROUND(SUM(COALESCE(oi.sale_fee,0)), 2) AS tarifa_total,
      ROUND(SUM(COALESCE(o.seller_shipping_cost,0)), 2) AS frete_total,
      ROUND(SUM((oi.unit_price*oi.quantity)*COALESCE(s.tax_rate,0)/100), 2) AS imposto_total,
      ROUND(SUM(oi.unit_price*oi.quantity) - SUM(COALESCE(oc.cost,0)) - SUM(COALESCE(oi.sale_fee,0)) - SUM(COALESCE(o.seller_shipping_cost,0)) - SUM((oi.unit_price*oi.quantity)*COALESCE(s.tax_rate,0)/100), 2) AS margem,
      ROUND(100.0*(SUM(oi.unit_price*oi.quantity) - SUM(COALESCE(oc.cost,0)) - SUM(COALESCE(oi.sale_fee,0)) - SUM(COALESCE(o.seller_shipping_cost,0)) - SUM((oi.unit_price*oi.quantity)*COALESCE(s.tax_rate,0)/100)) / NULLIF(SUM(oi.unit_price*oi.quantity),0), 2) AS mc_pct
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN stores s ON s.id = o.store_id
    LEFT JOIN order_costs oc ON oc.order_id=oi.order_id AND oc.item_id=oi.item_id
    WHERE o.status='paid' AND o.date_created >= ?
    GROUP BY oi.item_id, o.store_id
    ORDER BY faturamento DESC
  `).all(since);

  // Daily revenue trend
  const daily = db.prepare(`
    SELECT
      substr(o.date_created,1,10) AS dia,
      ROUND(SUM(oi.unit_price*oi.quantity),2) AS faturamento,
      COUNT(DISTINCT o.id) AS pedidos
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    WHERE o.status='paid' AND o.date_created >= ?
    GROUP BY dia ORDER BY dia
  `).all(since);

  // Totals per store
  const byStore = db.prepare(`
    SELECT
      s.nickname,
      COUNT(DISTINCT o.id) AS pedidos,
      ROUND(SUM(oi.unit_price*oi.quantity),2) AS faturamento,
      ROUND(SUM(COALESCE(oc.cost,0)),2) AS custo,
      ROUND(SUM(COALESCE(oi.sale_fee,0)),2) AS tarifa,
      ROUND(SUM(COALESCE(o.seller_shipping_cost,0)),2) AS frete_v
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    JOIN stores s ON s.id=o.store_id
    LEFT JOIN order_costs oc ON oc.order_id=oi.order_id AND oc.item_id=oi.item_id
    WHERE o.status='paid' AND o.date_created >= ?
    GROUP BY o.store_id
  `).all(since);

  // Products with no cost defined (blind spots)
  const semCusto = db.prepare(`
    SELECT oi.item_id, oi.item_title, s.nickname AS store,
      COUNT(*) AS pedidos,
      ROUND(SUM(oi.unit_price*oi.quantity),2) AS faturamento
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    JOIN stores s ON s.id=o.store_id
    LEFT JOIN order_costs oc ON oc.order_id=oi.order_id AND oc.item_id=oi.item_id
    WHERE o.status='paid' AND o.date_created >= ? AND COALESCE(oc.cost,0)=0
    GROUP BY oi.item_id, o.store_id
    ORDER BY faturamento DESC LIMIT 20
  `).all(since);

  const top10 = products.slice(0, 10);
  const bottom10 = [...products].sort((a,b) => a.faturamento - b.faturamento).slice(0, 10);
  const worstMargin = [...products].filter(p => p.mc_pct !== null).sort((a,b) => a.mc_pct - b.mc_pct).slice(0, 10);
  const bestMargin  = [...products].filter(p => p.mc_pct !== null).sort((a,b) => b.mc_pct - a.mc_pct).slice(0, 10);

  ok(res, {
    periodo: { dias: days, desde: since },
    lojas: byStore,
    tendencia_diaria: daily,
    top10_faturamento: top10,
    bottom10_faturamento: bottom10,
    top10_margem: bestMargin,
    bottom10_margem: worstMargin,
    sem_custo_cadastrado: semCusto,
    total_produtos: products.length,
  });
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
    const unitsToday   = db.prepare(
      "SELECT COALESCE(SUM(oi.quantity),0) as n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.store_id=? AND o.status='paid' AND date(o.date_created)=date('now','localtime')"
    ).get(storeId)?.n || 0;

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
        unitsToday,
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
        SELECT pi.item_id, pi.promotion_id, pi.original_price, pi.new_price, pi.discount_pct,
               p.name, p.type, p.finish_date
        FROM promotion_items pi
        LEFT JOIN promotions p ON p.id = pi.promotion_id
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

// Todas as lojas — para inbox unificada
route('GET', '/api/questions/all', (req, res, sess) => {
  const p      = qp(req);
  const status = p.get('status') || 'UNANSWERED';
  const limit  = Math.min(parseInt(p.get('limit') || '100'), 200);
  const offset = parseInt(p.get('offset') || '0');
  try {
    const rows = db.prepare(`
      SELECT q.*, s.nickname as store_name
      FROM questions_sync q
      JOIN stores s ON s.id = q.store_id
      WHERE q.status = ?
      ORDER BY q.date_created DESC
      LIMIT ? OFFSET ?
    `).all(status, limit, offset);
    const total = db.prepare("SELECT COUNT(*) as n FROM questions_sync WHERE status=?").get(status).n;
    ok(res, {
      questions: rows.map(q => ({
        id:         q.id,
        text:       q.text,
        status:     q.status,
        date:       q.date_created,
        item_id:    q.item_id,
        item_title: q.item_title,
        store_id:   q.store_id,
        store_name: q.store_name,
        from:       { nickname: q.buyer_nickname },
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
  const recentJobs = db.prepare(`
    SELECT j.type, j.store_id, s.nickname as store_name, s.store_color, s.store_icon,
           j.status, j.attempts, j.duration_ms, j.error, j.created_at, j.completed_at
    FROM job_queue j LEFT JOIN stores s ON s.id=j.store_id
    ORDER BY j.id DESC LIMIT 20
  `).all();
  const syncLogs = db.prepare(`
    SELECT l.*, s.nickname as store_name, s.store_color, s.store_icon
    FROM sync_log l LEFT JOIN stores s ON s.id=l.store_id
  `).all();
  const pendingJobs = db.prepare(`
    SELECT j.type, j.store_id, s.nickname as store_name, s.store_color, s.store_icon,
           j.priority, j.scheduled_at, j.attempts
    FROM job_queue j LEFT JOIN stores s ON s.id=j.store_id
    WHERE j.status='pending' ORDER BY j.priority, j.scheduled_at LIMIT 10
  `).all();
  const apiStats = db.prepare("SELECT COUNT(*) as calls, AVG(duration_ms) as avg_ms, SUM(CASE WHEN status_code=429 THEN 1 ELSE 0 END) as rate_limits FROM api_log WHERE logged_at >= unixepoch()-3600").get();
  const recentApiLogs = db.prepare("SELECT endpoint, status_code, duration_ms, rate_limit_remaining, logged_at FROM api_log ORDER BY id DESC LIMIT 10").all();

  ok(res, {
    queue: { pending, running, completedToday, failedToday, retriesToday },
    currentJob: Scheduler.currentJob,
    rateLimiter: {
      currentDelay: RateLimiter.currentDelay,
      callsThisMinute: RateLimiter.callsThisMinute,
      consecutive429: RateLimiter.consecutive429,
      perStore: RateLimiter.allStats(),
    },
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
  const type    = body.type    || 'sync_orders';
  const storeId = body.storeId || sess.store_id;
  const force   = !!body.force; // bypass dedup when force=true

  if (force) {
    // Cancel any existing pending job of same type+store and enqueue fresh
    db.prepare("DELETE FROM job_queue WHERE type=? AND store_id=? AND status='pending'").run(type, storeId);
  }
  const id = Scheduler.enqueue(type, storeId, 1);
  ok(res, { ok: true, jobId: id, message: `Job ${type} adicionado à fila` });
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

route('GET', '/api/debug/orders', (req, res) => {
  const storeId = qp(req).get('storeId');
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  const total        = db.prepare("SELECT COUNT(*) as n FROM orders WHERE store_id=?").get(storeId);
  const byStatus     = db.prepare("SELECT status, COUNT(*) as n FROM orders WHERE store_id=? GROUP BY status ORDER BY n DESC").all(storeId);
  const dateRange    = db.prepare("SELECT MIN(date_created) as min_d, MAX(date_created) as max_d FROM orders WHERE store_id=?").get(storeId);
  const last30paid   = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(total_amount),0) as rev FROM orders WHERE store_id=? AND status='paid' AND date_created >= ?").get(storeId, new Date(Date.now()-30*86400000).toISOString());
  const sampleOrders = db.prepare("SELECT id, status, total_amount, date_created FROM orders WHERE store_id=? ORDER BY date_created DESC LIMIT 5").all(storeId);
  const orderItems   = db.prepare("SELECT COUNT(*) as n FROM order_items WHERE store_id=?").get(storeId);
  ok(res, { total, byStatus, dateRange, last30paid, sampleOrders, orderItems });
}, true);

route('GET', '/api/debug/item', (req, res) => {
  const p       = qp(req);
  const itemId  = p.get('itemId');
  const storeId = p.get('storeId');
  if (!itemId || !storeId) { apiErr(res, 400, 'itemId e storeId obrigatórios'); return; }
  const inDb       = db.prepare('SELECT id,title,price,original_price,deal_ids,status FROM listings WHERE id=? AND store_id=?').get(itemId, storeId);
  const promoItems = db.prepare('SELECT * FROM promotion_items WHERE item_id=? AND store_id=?').all(itemId, storeId);
  const syncLog    = db.prepare("SELECT * FROM sync_log WHERE store_id=? AND entity='listings'").get(storeId);
  ok(res, { in_db: inDb, promo_items: promoItems, listings_sync_log: syncLog });
}, true);

route('GET', '/api/debug/visits', (req, res) => {
  const storeId = qp(req).get('storeId');
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  const count   = db.prepare('SELECT COUNT(*) as n FROM item_visits WHERE store_id=?').get(storeId);
  const sample  = db.prepare('SELECT * FROM item_visits WHERE store_id=? ORDER BY date DESC LIMIT 10').all(storeId);
  const byDate  = db.prepare('SELECT date, COUNT(*) as items, SUM(visits) as total FROM item_visits WHERE store_id=? GROUP BY date ORDER BY date DESC LIMIT 10').all(storeId);
  const syncLog = db.prepare("SELECT * FROM sync_log WHERE store_id=? AND entity='visits'").get(storeId);
  const activeListings = db.prepare("SELECT COUNT(*) as n FROM listings WHERE store_id=? AND status='active'").get(storeId);
  ok(res, { count, sample, byDate, syncLog, activeListings });
}, true);

route('GET', '/api/debug/ads-live', async (req, res) => {
  const storeId = qp(req).get('storeId');
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  try {
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
    const safeGet = (path) => Promise.race([mlFetch(path, {}, storeId), timeout(8000)]).catch(e => ({ _error: e.message }));
    // ML Ads API requires product_id — it's per-item, not per-account
    const firstItem = db.prepare("SELECT id FROM listings WHERE store_id=? AND status='active' LIMIT 1").get(storeId);
    const itemId = firstItem?.id;
    const adv1 = itemId ? await safeGet(`/advertising/advertisers?product_id=${itemId}`) : { _error: 'no active listing found' };
    // Also try the clicks/impression stats endpoint directly
    const adv2 = itemId ? await safeGet(`/advertising/advertisers/${storeId}/product_ads?product_id=${itemId}`) : null;
    ok(res, { itemTested: itemId, withProductId: adv1, productAdsEndpoint: adv2 });
  } catch (e) {
    ok(res, { error: e.message });
  }
}, true);

route('GET', '/api/debug/ads', (req, res) => {
  const storeId = qp(req).get('storeId');
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  try {
    const camps     = db.prepare('SELECT COUNT(*) as n FROM ads_campaigns WHERE store_id=?').get(storeId);
    const campList  = db.prepare('SELECT id,name,status FROM ads_campaigns WHERE store_id=? LIMIT 5').all(storeId);
    const metr      = db.prepare('SELECT COUNT(*) as n FROM ads_daily_metrics WHERE store_id=?').get(storeId);
    const metrSamp  = db.prepare('SELECT * FROM ads_daily_metrics WHERE store_id=? ORDER BY date DESC LIMIT 3').all(storeId);
    const syncC     = db.prepare("SELECT * FROM sync_log WHERE store_id=? AND entity='ads_campaigns'").get(storeId);
    const syncM     = db.prepare("SELECT * FROM sync_log WHERE store_id=? AND entity='ads_metrics'").get(storeId);
    ok(res, { campaigns: camps, campaignSample: campList, metrics: metr, metricsSample: metrSamp, syncCampaigns: syncC, syncMetrics: syncM });
  } catch (e) {
    ok(res, { error: e.message });
  }
}, true);

route('GET', '/api/debug/visits-live', async (req, res) => {
  const storeId = qp(req).get('storeId');
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  try {
    const ids = db.prepare("SELECT id FROM listings WHERE store_id=? AND status='active' LIMIT 3").all(storeId).map(r => r.id);
    if (!ids.length) { ok(res, { error: 'sem listings ativos' }); return; }
    // ML API accepts only 1 item per call
    const data = await mlFetch(`/items/visits/time_window?ids=${ids[0]}&last=7&unit=day`, {}, storeId);
    ok(res, { tested_id: ids[0], raw: data, isArray: Array.isArray(data), keys: data && !Array.isArray(data) ? Object.keys(data) : null });
  } catch (e) {
    ok(res, { error: e.message });
  }
}, true);

route('GET', '/api/promotions/debug', (req, res) => {
  const storeId = qp(req).get('storeId');
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  const promos          = db.prepare('SELECT * FROM promotions WHERE store_id=? LIMIT 10').all(storeId);
  const promoItems      = db.prepare('SELECT * FROM promotion_items WHERE store_id=? LIMIT 20').all(storeId);
  const listings        = db.prepare('SELECT id, title, original_price, deal_ids FROM listings WHERE store_id=? AND original_price > 0 LIMIT 20').all(storeId);
  const totalPromoItems = db.prepare('SELECT COUNT(*) as n FROM promotion_items WHERE store_id=?').get(storeId);
  const totalPromos     = db.prepare('SELECT COUNT(*) as n FROM promotions WHERE store_id=?').get(storeId);
  ok(res, { totalPromos, totalPromoItems, promos, promoItems, listingsWithOriginalPrice: listings });
}, true);

// ── Reputation ─────────────────────────────────────────────
route('GET', '/api/reputation', (req, res, sess) => {
  const storeId = qp(req).get('storeId') || sess.store_id;
  const rep = db.prepare('SELECT * FROM reputation WHERE store_id=?').get(storeId);
  const syncLog = db.prepare("SELECT last_sync,status FROM sync_log WHERE store_id=? AND entity='reputation'").get(storeId);
  ok(res, { reputation: rep || null, syncLog: syncLog || null });
});

route('POST', '/api/reputation/sync', (req, res, sess) => {
  Scheduler.enqueue('sync_reputation', sess.store_id, 2);
  ok(res, { ok: true, message: 'Sync de reputação enfileirada' });
});

// ── Customers ──────────────────────────────────────────────
route('GET', '/api/customers', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const search  = p.get('search') || '';
  const filter  = p.get('filter') || 'all'; // all | recurrent | new
  const sort    = p.get('sort') || 'total_spent';
  const order   = p.get('order') === 'asc' ? 'ASC' : 'DESC';
  const limit   = Math.min(parseInt(p.get('limit') || '50'), 200);
  const offset  = parseInt(p.get('offset') || '0');

  const allowed = ['total_spent','total_orders','last_order_at','first_order_at','avg_ticket'];
  const sortCol = allowed.includes(sort) ? sort : 'total_spent';

  let where = 'store_id=?';
  const args = [storeId];
  if (search) { where += ' AND (nickname LIKE ? OR city LIKE ? OR state LIKE ?)'; args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (filter === 'recurrent') { where += ' AND is_recurrent=1'; }
  if (filter === 'new')       { where += ' AND total_orders=1'; }

  try {
    const total = db.prepare(`SELECT COUNT(*) as n FROM dim_customers WHERE ${where}`).get(...args).n;
    const rows  = db.prepare(`SELECT * FROM dim_customers WHERE ${where} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_customers,
        SUM(CASE WHEN is_recurrent=1 THEN 1 ELSE 0 END) as recurrent,
        SUM(CASE WHEN total_orders=1 THEN 1 ELSE 0 END) as new_customers,
        AVG(total_spent) as avg_spent,
        AVG(avg_ticket) as avg_ticket
      FROM dim_customers WHERE store_id=?
    `).get(storeId);

    const syncLog = db.prepare("SELECT last_sync,status FROM sync_log WHERE store_id=? AND entity='customers'").get(storeId);

    ok(res, { customers: rows, total, stats: stats || {}, syncLog: syncLog || null });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('GET', '/api/customers/detail', (req, res, sess) => {
  const p        = qp(req);
  const storeId  = p.get('storeId') || sess.store_id;
  const buyerId  = p.get('buyerId');
  if (!buyerId) { apiErr(res, 400, 'buyerId obrigatório'); return; }

  const customer = db.prepare('SELECT * FROM dim_customers WHERE buyer_id=? AND store_id=?').get(buyerId, storeId);
  if (!customer) { apiErr(res, 404, 'Cliente não encontrado'); return; }

  const orders = db.prepare(`
    SELECT CAST(o.id AS TEXT) as id, o.date_created, o.date_closed, o.total_amount, o.status, o.shipping_status,
           o.receiver_city, o.receiver_state, o.receiver_state_code,
           GROUP_CONCAT(oi.item_title, ' | ') as items,
           COUNT(oi.id) as item_count,
           SUM(oi.quantity) as total_qty
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.buyer_id=? AND o.store_id=? AND o.status='paid'
    GROUP BY o.id
    ORDER BY o.date_created DESC
    LIMIT 50
  `).all(buyerId, storeId);

  // City/state from orders if not in dim_customers
  const loc = orders.find(o => o.receiver_city);

  ok(res, { customer, orders, loc: loc || null });
});

route('POST', '/api/customers/sync', (req, res, sess) => {
  Scheduler.enqueue('sync_customers', sess.store_id, 2);
  ok(res, { ok: true, message: 'Sync de clientes enfileirada' });
});

// Inbox: lista conversas recentes com última mensagem
route('GET', '/api/messages/inbox', (req, res, sess) => {
  try {
    // Conversas com mensagens no cache (têm conteúdo)
    const comCache = db.prepare(`
      SELECT mc.pack_id, mc.store_id, p.order_id, p.buyer,
             s.nickname as store_name,
             MAX(mc.created_at) as last_date,
             (SELECT text FROM messages_cache m2 WHERE m2.pack_id=mc.pack_id ORDER BY m2.created_at DESC LIMIT 1) as last_text,
             COUNT(*) as msg_count
      FROM messages_cache mc
      JOIN stores s ON s.id = mc.store_id
      LEFT JOIN packs_seen p ON p.pack_id = mc.pack_id
      GROUP BY mc.pack_id
      ORDER BY last_date DESC
      LIMIT 30
    `).all();

    // Pedidos com pack_id mas sem mensagens no cache ainda
    const semCache = db.prepare(`
      SELECT o.pack_id, o.store_id, o.id as order_id, o.buyer_nickname as buyer,
             s.nickname as store_name,
             NULL as last_date, NULL as last_text, 0 as msg_count
      FROM orders o
      JOIN stores s ON s.id = o.store_id
      WHERE o.pack_id != '' AND o.pack_id IS NOT NULL
        AND o.pack_id NOT IN (SELECT DISTINCT pack_id FROM messages_cache)
      GROUP BY o.pack_id
      ORDER BY o.date_created DESC
      LIMIT 30
    `).all();

    // packs_seen que não estão no cache nem nos pedidos com pack_id
    const semCachePacks = db.prepare(`
      SELECT p.pack_id, p.store_id, p.order_id, p.buyer,
             s.nickname as store_name,
             NULL as last_date, NULL as last_text, 0 as msg_count
      FROM packs_seen p
      JOIN stores s ON s.id = p.store_id
      WHERE p.pack_id NOT LIKE 'noPack:%'
        AND p.pack_id NOT IN (SELECT DISTINCT pack_id FROM messages_cache)
        AND p.pack_id NOT IN (SELECT pack_id FROM orders WHERE pack_id != '' AND pack_id IS NOT NULL)
      ORDER BY p.synced_at DESC
      LIMIT 20
    `).all();

    const all = [...comCache, ...semCache, ...semCachePacks];
    const seen = new Set();
    const dedup = all.filter(c => {
      const k = c.pack_id + '|' + c.store_id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    ok(res, { conversations: dedup });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// Discover: busca conversas reais no ML e salva pack_ids no packs_seen
route('GET', '/api/messages/discover', async (req, res, sess) => {
  const p = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  try {
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(storeId);
    if (!store) { apiErr(res, 404, 'Loja não encontrada'); return; }
    const token = await ensureFreshToken(store);

    // Busca packs com mensagens recentes no ML
    const data = await mlFetch(`/messages/packs?seller_id=${storeId}&role=seller&tag=post_sale&offset=0&limit=30`, {}, storeId);
    const packs = data?.results || data?.packs || [];

    const insertPack = db.prepare('INSERT OR IGNORE INTO packs_seen(pack_id,store_id,order_id,buyer) VALUES(?,?,?,?)');
    const insertMsg  = db.prepare(`INSERT OR IGNORE INTO messages_cache(pack_id,store_id,msg_id,from_user,text,created_at,notified) VALUES(?,?,?,?,?,?,1)`);

    const conversations = [];
    for (const pack of packs.slice(0, 20)) {
      const packId = String(pack.id || pack.pack_id || '');
      if (!packId) continue;

      // Salva o pack
      const order = db.prepare('SELECT id, buyer_nickname FROM orders WHERE pack_id=? LIMIT 1').get(packId);
      insertPack.run(packId, storeId, order?.id || '', pack.buyer?.nickname || order?.buyer_nickname || '');

      // Busca últimas mensagens deste pack
      const msgData = await mlFetch(`/messages/packs/${packId}/sellers/${storeId}?tag=post_sale`, {}, storeId).catch(() => null);
      const msgs = msgData?.messages || [];
      for (const m of msgs) {
        insertMsg.run(packId, storeId, String(m.id || m.created_at), m.from?.nickname || String(m.from?.user_id || ''), m.text?.plain || '', m.created_at || '');
      }

      const lastMsg = msgs[msgs.length - 1];
      conversations.push({
        pack_id:    packId,
        store_id:   storeId,
        store_name: store.nickname,
        order_id:   order?.id || '',
        buyer:      pack.buyer?.nickname || order?.buyer_nickname || 'Comprador',
        last_date:  lastMsg?.created_at || '',
        last_text:  lastMsg?.text?.plain || '',
        msg_count:  msgs.length,
      });
    }

    ok(res, { conversations, discovered: conversations.length });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Messages ───────────────────────────────────────────────
route('GET', '/api/messages', async (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const packId  = p.get('packId');
  const live    = p.get('live') === '1';
  if (!packId) { apiErr(res, 400, 'packId obrigatório'); return; }

  // Serve do cache local primeiro (rápido, sem rate limit)
  const cached = db.prepare(
    'SELECT * FROM messages_cache WHERE pack_id=? AND store_id=? ORDER BY created_at ASC'
  ).all(packId, storeId);

  if (cached.length && !live) {
    return ok(res, {
      messages: cached.map(m => ({
        id:         m.msg_id,
        from:       { nickname: m.from_user, user_id: null },
        text:       { plain: m.text },
        created_at: m.created_at,
        _cached:    true,
      })),
      source: 'cache',
    });
  }

  // Fallback: busca ao vivo no ML (só quando cache vazio ou forçado)
  try {
    const data = await mlFetch(`/messages/packs/${packId}/sellers/${storeId}?tag=post_sale`, {}, storeId);
    const msgs = data.messages || [];

    // Salva no cache para próximas consultas
    const insert = db.prepare(`INSERT OR IGNORE INTO messages_cache(pack_id,store_id,msg_id,from_user,text,created_at,notified)
      VALUES(?,?,?,?,?,?,1)`);
    for (const m of msgs) {
      insert.run(packId, storeId, String(m.id || m.created_at), m.from?.nickname || String(m.from?.user_id || ''), m.text?.plain || '', m.created_at || '');
    }

    ok(res, { messages: msgs, source: 'live' });
  } catch (e) {
    // Se ML falhar mas tiver cache, retorna cache mesmo assim
    if (cached.length) {
      return ok(res, {
        messages: cached.map(m => ({
          id: m.msg_id, from: { nickname: m.from_user, user_id: null },
          text: { plain: m.text }, created_at: m.created_at, _cached: true,
        })),
        source: 'cache',
      });
    }
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
// Returns fromDate adjusted for data gap: if all orders are older than the window, shift back
function analyticsFromDate(storeId, days) {
  const maxRow = db.prepare("SELECT MAX(date_created) as max_d FROM orders WHERE store_id=? AND status='paid'").get(storeId);
  const now = Date.now();
  const windowStart = now - days * 86400000;
  if (maxRow?.max_d && new Date(maxRow.max_d).getTime() < windowStart) {
    const maxD = new Date(maxRow.max_d).getTime();
    return { fromDate: new Date(maxD - days * 86400000).toISOString(), dataGap: true, maxDate: maxRow.max_d };
  }
  return { fromDate: new Date(windowStart).toISOString(), dataGap: false, maxDate: null };
}

route('GET', '/api/analytics/hourly', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const days    = Math.min(parseInt(p.get('days') || '7'), 30);
  const cKey    = `analytics:hourly:${storeId}:${days}`;
  const cached  = cacheGet(cKey);
  if (cached) { ok(res, cached); return; }

  try {
    const { fromDate, dataGap, maxDate } = analyticsFromDate(storeId, days);
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
      dataGap,
      maxDate,
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
    const { fromDate, dataGap, maxDate } = analyticsFromDate(storeId, days);
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

    const result = { byDay, bestDay, avgOrdersPerDay, days, dataGap, maxDate };
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
    const { fromDate, dataGap, maxDate } = analyticsFromDate(storeId, days);

    if (type === 'ranking') {
      const products = db.prepare(`
        SELECT oi.item_id, oi.item_title,
               COUNT(DISTINCT oi.order_id) as orders,
               SUM(oi.quantity) as units,
               SUM(oi.quantity * oi.unit_price) as revenue,
               l.available_quantity
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN listings l ON l.id = oi.item_id AND l.store_id = oi.store_id
        WHERE oi.store_id=? AND o.date_created>=? AND o.status='paid'
        GROUP BY oi.item_id
        ORDER BY revenue DESC
        LIMIT 50
      `).all(storeId, fromDate);

      const result = {
        products: products.map(p => {
          const stock       = p.available_quantity ?? 0;
          const dailyAvg    = days > 0 ? p.units / days : 0;
          const targetStock = dailyAvg * days;
          const replenish   = Math.max(0, Math.ceil(targetStock - stock));
          const target60    = dailyAvg * 60;
          const replenish60 = Math.max(0, Math.ceil(target60 - stock));
          return {
            id: p.item_id, title: p.item_title || p.item_id,
            orders: p.orders, units: p.units, revenue: p.revenue,
            avgTicket: p.orders > 0 ? p.revenue / p.orders : 0,
            stock, dailyAvg, replenish, replenish60,
          };
        }),
        days, type, dataGap, maxDate,
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
  const daysParam = p.get('days') || '30';
  const allTime  = daysParam === 'all';
  const days     = allTime ? 365 : Math.min(parseInt(daysParam), 365);
  const cKey     = `metrics:${storeId}:${daysParam}`;
  const cached   = cacheGet(cKey);
  if (cached) { ok(res, cached); return; }

  try {
    // If no data in requested period, auto-extend to use available DB range
    const maxRow = db.prepare("SELECT MAX(date_created) as max_d, MIN(date_created) as min_d FROM orders WHERE store_id=? AND status='paid'").get(storeId);
    let fromDate;
    let actualDays = days;
    if (allTime && maxRow?.min_d) {
      fromDate = maxRow.min_d;
    } else {
      fromDate = new Date(Date.now() - days * 86400000).toISOString();
      // Auto-detect gap: if latest order is older than our from date, shift window
      if (maxRow?.max_d && new Date(maxRow.max_d) < new Date(fromDate)) {
        const maxD = new Date(maxRow.max_d);
        fromDate = new Date(maxD.getTime() - days * 86400000).toISOString();
        console.log(`[metrics] gap detected — shifting window to data range around ${maxRow.max_d}`);
      }
    }

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

    // Build daily chart from actual data range
    const fromTs  = new Date(fromDate).getTime();
    const toTs    = allOrders.length > 0
      ? Math.max(...allOrders.map(o => new Date(o.date_created).getTime()))
      : Date.now();
    const chartDays = Math.min(Math.ceil((toTs - fromTs) / 86400000) + 1, 365);
    const startTs   = new Date(fromDate).setHours(0, 0, 0, 0);
    const dailyChart = [];
    for (let i = 0; i < chartDays; i++) {
      const d = new Date(startTs + i * 86400000).toISOString().split('T')[0];
      dailyChart.push(daily[d] || { date: d, revenue: 0, orders: 0 });
    }

    const result = {
      summary: { totalRevenue, totalOrders, avgTicket, fromDate: fromDate.split('T')[0] },
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

  // Visits: always use real current dates (ML returns current data)
  const visitsDateTo   = today;
  const visitsDateFrom = new Date(now - days * 86400000).toISOString().split('T')[0];
  const visitsPrevFrom = new Date(now - days * 2 * 86400000).toISOString().split('T')[0];

  // Orders: detect data gap — if all orders are older than the requested period, shift window
  const orderRange = db.prepare("SELECT MAX(date_created) as max_d, MIN(date_created) as min_d FROM orders WHERE store_id=? AND status='paid'").get(storeId);
  const maxOrderDate = orderRange?.max_d ? new Date(orderRange.max_d) : now;
  const useNow = maxOrderDate >= new Date(now - days * 86400000) ? now : maxOrderDate;
  const dataGap = maxOrderDate < new Date(now - days * 86400000);

  const ordersDateFrom = new Date(useNow - days * 86400000).toISOString().split('T')[0];
  const ordersDateTo   = useNow.toISOString().split('T')[0];
  const ordersPrevFrom = new Date(useNow - days * 2 * 86400000).toISOString().split('T')[0];

  let dateFrom = ordersDateFrom;
  let dateTo   = ordersDateTo;
  if (period === 'yesterday') {
    const yesterday = new Date(useNow - 86400000).toISOString().split('T')[0];
    dateFrom = yesterday;
    dateTo   = yesterday;
  }

  try {
    const listings = db.prepare('SELECT * FROM listings WHERE store_id=?').all(storeId);

    // Visits use current real dates
    const visitsRows = db.prepare(`
      SELECT item_id, SUM(visits) as total_visits
      FROM item_visits
      WHERE store_id=? AND date >= ? AND date <= ?
      GROUP BY item_id
    `).all(storeId, visitsDateFrom, visitsDateTo);
    const visitsMap = {};
    visitsRows.forEach(r => { visitsMap[r.item_id] = r.total_visits; });

    const prevVisitsRows = db.prepare(`
      SELECT item_id, SUM(visits) as total_visits
      FROM item_visits
      WHERE store_id=? AND date >= ? AND date < ?
      GROUP BY item_id
    `).all(storeId, visitsPrevFrom, visitsDateFrom);
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
    `).all(storeId, ordersPrevFrom + 'T00:00:00', dateFrom + 'T00:00:00');
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
      dateFrom: visitsDateFrom,
      dateTo: visitsDateTo,
      ordersDateFrom: dateFrom,
      ordersDateTo: dateTo,
      dataGap,
    });
  } catch (e) {
    console.error('Performance error:', e.message);
    apiErr(res, 500, e.message);
  }
});

// ── Ads ────────────────────────────────────────────────────
route('GET', '/api/ads/dashboard', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || sess.store_id;
  const period  = p.get('period') || '7d';
  const dateParam = p.get('date') || '';

  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const yesterdayStr = new Date(now - 86400000).toISOString().split('T')[0];

    let dateFrom, dateTo;
    if (dateParam) {
      dateFrom = dateParam;
      dateTo   = dateParam;
    } else if (period === 'today') {
      dateFrom = todayStr;
      dateTo   = todayStr;
    } else if (period === 'yesterday') {
      dateFrom = yesterdayStr;
      dateTo   = yesterdayStr;
    } else {
      const days = period === '15d' ? 15 : period === '30d' ? 30 : 7;
      dateFrom = new Date(now - days * 86400000).toISOString().split('T')[0];
      dateTo   = todayStr;
    }

    const metricsRows = db.prepare(`
      SELECT campaign_id, ad_id,
        SUM(spend) as spend, SUM(clicks) as clicks, SUM(impressions) as impressions,
        SUM(conversions) as conversions, SUM(attributed_revenue) as attributed_revenue
      FROM ads_daily_metrics
      WHERE store_id=? AND date >= ? AND date <= ?
      GROUP BY campaign_id, ad_id
    `).all(storeId, dateFrom, dateTo);

    const totSpend = metricsRows.reduce((s, r) => s + r.spend, 0);
    const totClicks = metricsRows.reduce((s, r) => s + r.clicks, 0);
    const totImps = metricsRows.reduce((s, r) => s + r.impressions, 0);
    const totConvs = metricsRows.reduce((s, r) => s + r.conversions, 0);
    const totRev = metricsRows.reduce((s, r) => s + r.attributed_revenue, 0);

    // Total sales (organic + paid) for tacos
    const totalRevRow = db.prepare(`
      SELECT SUM(total_amount) as total FROM orders
      WHERE store_id=? AND date_created >= ? AND date_created <= ? AND status='paid'
    `).get(storeId, dateFrom + 'T00:00:00', dateTo + 'T23:59:59');
    const totalOrgRev = totalRevRow?.total || 0;

    const kpis = {
      spend:              totSpend,
      clicks:             totClicks,
      impressions:        totImps,
      conversions:        totConvs,
      attributed_revenue: totRev,
      roas:               totSpend > 0 ? totRev / totSpend : 0,
      acos:               totRev > 0 ? (totSpend / totRev) * 100 : 0,
      tacos:              totalOrgRev > 0 ? (totSpend / totalOrgRev) * 100 : 0,
      ctr:                totImps > 0 ? (totClicks / totImps) * 100 : 0,
      cpc:                totClicks > 0 ? totSpend / totClicks : 0,
      cpm:                totImps > 0 ? (totSpend / totImps) * 1000 : 0,
      cost_per_conversion: totConvs > 0 ? totSpend / totConvs : 0,
    };

    // By campaign
    const campRows = db.prepare(`
      SELECT m.campaign_id,
        SUM(m.spend) as spend, SUM(m.clicks) as clicks, SUM(m.impressions) as impressions,
        SUM(m.conversions) as conversions, SUM(m.attributed_revenue) as attributed_revenue
      FROM ads_daily_metrics m
      WHERE m.store_id=? AND m.date >= ? AND m.date <= ?
      GROUP BY m.campaign_id
      ORDER BY spend DESC
    `).all(storeId, dateFrom, dateTo);

    const campaigns = db.prepare('SELECT id, name, status FROM ads_campaigns WHERE store_id=?').all(storeId);
    const campMap = {};
    campaigns.forEach(c => { campMap[c.id] = c; });

    const by_campaign = campRows.map(r => {
      const camp = campMap[r.campaign_id] || {};
      const sp = r.spend || 0;
      const cl = r.clicks || 0;
      const im = r.impressions || 0;
      const rv = r.attributed_revenue || 0;
      const co = r.conversions || 0;

      // total rev for tacos per campaign (all orders during that period)
      return {
        campaign_id: r.campaign_id,
        name:   camp.name   || r.campaign_id,
        status: camp.status || '',
        spend:  sp,
        clicks: cl,
        impressions: im,
        conversions: co,
        attributed_revenue: rv,
        roas: sp > 0 ? rv / sp : 0,
        acos: rv > 0 ? (sp / rv) * 100 : 0,
        tacos: totalOrgRev > 0 ? (sp / totalOrgRev) * 100 : 0,
        ctr:  im > 0 ? (cl / im) * 100 : 0,
        cpc:  cl > 0 ? sp / cl : 0,
      };
    });

    // By day
    const dayRows = db.prepare(`
      SELECT date,
        SUM(spend) as spend, SUM(clicks) as clicks, SUM(impressions) as impressions,
        SUM(conversions) as conversions, SUM(attributed_revenue) as attributed_revenue
      FROM ads_daily_metrics
      WHERE store_id=? AND date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC
    `).all(storeId, dateFrom, dateTo);

    const by_day = dayRows.map(r => ({
      date: r.date,
      spend: r.spend,
      clicks: r.clicks,
      impressions: r.impressions,
      conversions: r.conversions,
      attributed_revenue: r.attributed_revenue,
      roas: r.spend > 0 ? r.attributed_revenue / r.spend : 0,
    }));

    const syncLog  = db.prepare("SELECT last_sync,status,error FROM sync_log WHERE store_id=? AND entity='ads_metrics'").get(storeId);
    const syncCamp = db.prepare("SELECT last_sync,status,error FROM sync_log WHERE store_id=? AND entity='ads_campaigns'").get(storeId);

    ok(res, { kpis, by_campaign, by_day, syncLog: syncLog || null, period, dateFrom, dateTo });
  } catch (e) {
    console.error('Ads dashboard error:', e.message);
    apiErr(res, 500, e.message);
  }
});

route('GET', '/api/ads/campaigns', (req, res, sess) => {
  const storeId = qp(req).get('storeId') || sess.store_id;
  try {
    const campaigns = db.prepare('SELECT * FROM ads_campaigns WHERE store_id=? ORDER BY name').all(storeId);
    ok(res, { campaigns });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('POST', '/api/visits/sync', (req, res, sess) => {
  const storeId = qp(req).get('storeId') || (sess && sess.store_id);
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  const force   = qp(req).get('force') === '1';
  if (force) {
    // Full reset: wipe all visit data so sync restarts from scratch
    db.prepare('DELETE FROM item_visits WHERE store_id=?').run(storeId);
    console.log(`[visits/sync] force reset item_visits store=${storeId}`);
  }
  db.prepare("DELETE FROM sync_log WHERE store_id=? AND entity='visits'").run(storeId);
  Scheduler.enqueue('sync_visits', storeId, 2);
  ok(res, { ok: true, message: force ? 'Sync completo de visitas enfileirado (dados apagados)' : 'Sync de visitas enfileirado — retomará do progresso salvo' });
}, true);

// Force orders backfill — wipes sync_log so next run fetches from MAX(date_created)
route('POST', '/api/orders/sync', (req, res, sess) => {
  const storeId = qp(req).get('storeId') || (sess && sess.store_id);
  if (!storeId) { apiErr(res, 400, 'storeId obrigatório'); return; }
  db.prepare("DELETE FROM sync_log WHERE store_id=? AND entity='orders'").run(storeId);
  Scheduler.enqueue('sync_orders', storeId, 2);
  ok(res, { ok: true, message: 'Backfill de pedidos enfileirado — buscará desde último pedido no banco até hoje' });
}, true);

route('POST', '/api/ads/sync', (req, res, sess) => {
  const storeId = qp(req).get('storeId') || sess.store_id;
  Scheduler.enqueue('sync_ads_campaigns', storeId, 2);
  Scheduler.enqueue('sync_ads_metrics', storeId, 2);
  ok(res, { ok: true, message: 'Sync de Ads enfileirado' });
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

// ── Alerta de Reposição ────────────────────────────────────
route('GET', '/api/reposicao', (req, res, sess) => {
  const p = qp(req);
  const storeFilter = p.get('storeId') || null;
  const days7  = new Date(Date.now() -  7 * 86400000).toISOString();
  const days14 = new Date(Date.now() - 14 * 86400000).toISOString();
  const days30 = new Date(Date.now() - 30 * 86400000).toISOString();

  try {
    const storeWhere = storeFilter ? `AND oi.store_id = '${storeFilter}'` : '';

    // Vendas dos últimos 7 dias por produto
    const sales7 = db.prepare(`
      SELECT oi.item_id, oi.item_title, oi.store_id, s.nickname as loja,
             SUM(oi.quantity) as unidades_7d,
             COUNT(DISTINCT o.id) as pedidos_7d,
             ROUND(SUM(oi.unit_price * oi.quantity), 2) as fat_7d
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN stores s ON s.id = oi.store_id
      WHERE o.status='paid' AND o.date_created >= ? ${storeWhere}
      GROUP BY oi.item_id, oi.store_id
    `).all(days7);

    // Vendas dos 7 dias anteriores (comparação)
    const sales14 = db.prepare(`
      SELECT oi.item_id, oi.store_id, SUM(oi.quantity) as unidades_prev
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status='paid' AND o.date_created >= ? AND o.date_created < ? ${storeWhere}
      GROUP BY oi.item_id, oi.store_id
    `).all(days14, days7);
    const prevMap = {};
    sales14.forEach(r => { prevMap[`${r.item_id}_${r.store_id}`] = r.unidades_prev; });

    // Estoque atual (listings)
    const estoques = db.prepare(`
      SELECT id, store_id, available_quantity, sold_quantity, status FROM listings
    `).all();
    const estoqueMap = {};
    estoques.forEach(l => { estoqueMap[`${l.id}_${l.store_id}`] = l; });

    const alertas = [];
    for (const item of sales7) {
      const key = `${item.item_id}_${item.store_id}`;
      const listing = estoqueMap[key] || {};
      const estoque = listing.available_quantity || 0;
      const vendas7 = item.unidades_7d || 0;
      const vendaAnterior = prevMap[key] || 0;

      // Ritmo diário de vendas (últimos 7 dias)
      const ritmoDiario = vendas7 / 7;
      // Dias de estoque restante
      const diasEstoque = ritmoDiario > 0 ? Math.floor(estoque / ritmoDiario) : 999;
      // Variação em relação à semana anterior
      const variacao = vendaAnterior > 0 ? Math.round(((vendas7 - vendaAnterior) / vendaAnterior) * 100) : null;

      // Nível de urgência
      let urgencia = 'ok';
      if (diasEstoque <= 3)       urgencia = 'critico';
      else if (diasEstoque <= 7)  urgencia = 'alto';
      else if (diasEstoque <= 14) urgencia = 'medio';
      else if (vendas7 > (vendaAnterior * 1.3)) urgencia = 'crescendo'; // acelerou 30%+

      if (urgencia === 'ok') continue; // só mostra os que precisam de atenção

      alertas.push({
        item_id:      item.item_id,
        titulo:       item.item_title,
        loja:         item.loja,
        store_id:     item.store_id,
        estoque:      estoque,
        vendas_7d:    vendas7,
        vendas_prev:  vendaAnterior,
        variacao_pct: variacao,
        ritmo_diario: Math.round(ritmoDiario * 10) / 10,
        dias_estoque: diasEstoque === 999 ? null : diasEstoque,
        fat_7d:       item.fat_7d,
        urgencia,
      });
    }

    // Ordena: crítico primeiro, depois por faturamento
    const ordem = { critico: 0, alto: 1, medio: 2, crescendo: 3 };
    alertas.sort((a, b) => (ordem[a.urgencia] - ordem[b.urgencia]) || (b.fat_7d - a.fat_7d));

    ok(res, { alertas, total: alertas.length, gerado_em: new Date().toISOString() });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Taxa de Cancelamento ───────────────────────────────────
route('GET', '/api/cancelamentos', (req, res, sess) => {
  const p = qp(req);
  const storeFilter = p.get('storeId') || null;
  const days = parseInt(p.get('days') || '30');
  const fromDate = new Date(Date.now() - days * 86400000).toISOString();
  const storeWhere = storeFilter ? `AND o.store_id = '${storeFilter}'` : '';

  try {
    // Total de pedidos (pagos + cancelados) por produto
    const rows = db.prepare(`
      SELECT
        oi.item_id,
        oi.item_title,
        oi.store_id,
        s.nickname as loja,
        COUNT(DISTINCT CASE WHEN o.status='paid'      THEN o.id END) as pedidos_pagos,
        COUNT(DISTINCT CASE WHEN o.status='cancelled' THEN o.id END) as pedidos_cancelados,
        COUNT(DISTINCT o.id) as pedidos_total,
        ROUND(SUM(CASE WHEN o.status='paid' THEN oi.unit_price * oi.quantity ELSE 0 END), 2) as faturamento,
        ROUND(100.0 * COUNT(DISTINCT CASE WHEN o.status='cancelled' THEN o.id END)
              / NULLIF(COUNT(DISTINCT o.id), 0), 1) as taxa_cancelamento
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN stores s ON s.id = oi.store_id
      WHERE o.date_created >= ? ${storeWhere}
      GROUP BY oi.item_id, oi.store_id
      HAVING pedidos_total >= 3
      ORDER BY taxa_cancelamento DESC, pedidos_cancelados DESC
    `).all(fromDate);

    // Resumo geral por loja
    const porLoja = db.prepare(`
      SELECT
        s.nickname as loja,
        o.store_id,
        COUNT(DISTINCT CASE WHEN o.status='paid'      THEN o.id END) as pagos,
        COUNT(DISTINCT CASE WHEN o.status='cancelled' THEN o.id END) as cancelados,
        COUNT(DISTINCT o.id) as total,
        ROUND(100.0 * COUNT(DISTINCT CASE WHEN o.status='cancelled' THEN o.id END)
              / NULLIF(COUNT(DISTINCT o.id), 0), 1) as taxa
      FROM orders o
      JOIN stores s ON s.id = o.store_id
      WHERE o.date_created >= ? ${storeWhere}
      GROUP BY o.store_id
    `).all(fromDate);

    // Tendência diária de cancelamentos (últimos 30 dias)
    const tendencia = db.prepare(`
      SELECT
        DATE(o.date_created) as dia,
        COUNT(DISTINCT CASE WHEN o.status='paid'      THEN o.id END) as pagos,
        COUNT(DISTINCT CASE WHEN o.status='cancelled' THEN o.id END) as cancelados
      FROM orders o
      WHERE o.date_created >= ? ${storeWhere}
      GROUP BY dia ORDER BY dia
    `).all(fromDate);

    ok(res, {
      produtos: rows,
      por_loja: porLoja,
      tendencia,
      periodo_dias: days,
      gerado_em: new Date().toISOString(),
    });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Devoluções e Reembolsos ────────────────────────────────
route('GET', '/api/devolucoes', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || null;
  const days    = parseInt(p.get('days') || '30');
  const from    = new Date(Date.now() - days * 86400000).toISOString();

  const where = storeId ? `AND o.store_id = '${storeId}'` : '';

  try {
    // Pedidos cancelados no período com itens e custo
    const rows = db.prepare(`
      SELECT
        o.id           AS order_id,
        o.store_id,
        s.nickname     AS store_name,
        o.buyer_nickname,
        o.date_closed  AS cancelled_at,
        o.total_amount,
        oi.item_id,
        oi.item_title,
        oi.quantity,
        oi.unit_price,
        COALESCE(oc.cost, 0) AS custo,
        COALESCE(oi.sale_fee, 0) AS tarifa,
        COALESCE(o.seller_shipping_cost, 0) AS frete
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN stores s ON s.id = o.store_id
      LEFT JOIN order_costs oc ON oc.order_id = o.id AND oc.item_id = oi.item_id
      WHERE o.status = 'cancelled'
        AND o.date_created >= ?
        ${where}
      ORDER BY o.date_closed DESC
      LIMIT 200
    `).all(from);

    // Resumo por loja
    const byStore = {};
    for (const r of rows) {
      if (!byStore[r.store_id]) byStore[r.store_id] = { store_name: r.store_name, qtd: 0, total: 0, custo_total: 0 };
      byStore[r.store_id].qtd++;
      byStore[r.store_id].total    += r.unit_price * r.quantity;
      byStore[r.store_id].custo_total += r.custo;
    }

    // Top produtos devolvidos
    const topProd = {};
    for (const r of rows) {
      if (!topProd[r.item_id]) topProd[r.item_id] = { item_title: r.item_title, qtd: 0, total: 0 };
      topProd[r.item_id].qtd   += r.quantity;
      topProd[r.item_id].total += r.unit_price * r.quantity;
    }
    const topProdList = Object.entries(topProd)
      .map(([id, v]) => ({ item_id: id, ...v }))
      .sort((a, b) => b.total - a.total).slice(0, 10);

    // Totais gerais
    const totalDevolvido   = rows.reduce((s, r) => s + r.unit_price * r.quantity, 0);
    const whereSimples = storeId ? `AND store_id = '${storeId}'` : '';
    const totalPedidosPago = db.prepare(`SELECT COUNT(*) as n FROM orders WHERE status='paid' AND date_created >= ? ${whereSimples}`).get(from).n;
    const pctCancelamentos = totalPedidosPago > 0 ? (rows.length / totalPedidosPago * 100).toFixed(1) : 0;

    // Relatório mensal: últimos 12 meses
    const mensalRows = db.prepare(`
      SELECT
        strftime('%Y-%m', o.date_created) AS mes,
        COUNT(DISTINCT o.id) AS qtd_cancelamentos,
        SUM(oi.unit_price * oi.quantity) AS total_perdido,
        SUM(COALESCE(oc.cost, 0)) AS custo_perdido,
        SUM(COALESCE(oi.sale_fee, 0)) AS tarifa_perdida,
        SUM(COALESCE(o.seller_shipping_cost, 0)) AS frete_perdido
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN order_costs oc ON oc.order_id = o.id AND oc.item_id = oi.item_id
      WHERE o.status = 'cancelled'
        AND o.date_created >= datetime('now', '-12 months')
        ${storeId ? `AND o.store_id = '${storeId}'` : ''}
      GROUP BY mes
      ORDER BY mes DESC
    `).all();

    const MESES_PT = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const mensal = mensalRows.map(r => {
      const [ano, m] = r.mes.split('-');
      const prejuizo = (r.total_perdido||0) + (r.custo_perdido||0) + (r.tarifa_perdida||0) + (r.frete_perdido||0);
      return {
        mes:              r.mes,
        mes_label:        `${MESES_PT[parseInt(m)]}/${ano}`,
        qtd_cancelamentos:r.qtd_cancelamentos,
        total_perdido:    r.total_perdido || 0,
        custo_perdido:    r.custo_perdido || 0,
        tarifa_perdida:   r.tarifa_perdida || 0,
        frete_perdido:    r.frete_perdido || 0,
        prejuizo_total:   prejuizo,
      };
    });

    ok(res, {
      orders:       rows,
      by_store:     Object.values(byStore),
      top_produtos: topProdList,
      mensal,
      resumo: {
        total_devolvido:    totalDevolvido,
        qtd_cancelamentos:  rows.length,
        pct_cancelamentos:  pctCancelamentos,
        pedidos_pagos:      totalPedidosPago,
      },
    });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Anúncios com Problema ─────────────────────────────────
route('GET', '/api/anuncios-problema', (req, res, sess) => {
  const p       = qp(req);
  const storeId = p.get('storeId') || null;
  const where   = storeId ? `AND l.store_id = '${storeId}'` : '';

  try {
    // Custo médio por item_id (dos últimos 90 dias)
    const custoMedio = {};
    const custos = db.prepare(`
      SELECT oi.item_id, AVG(oc.cost) as avg_cost
      FROM order_costs oc
      JOIN order_items oi ON oi.order_id = oc.order_id AND oi.item_id = oc.item_id
      JOIN orders o ON o.id = oc.order_id
      WHERE o.date_created >= date('now','-90 days') AND oc.cost > 0
      GROUP BY oi.item_id
    `).all();
    for (const c of custos) custoMedio[c.item_id] = c.avg_cost;

    const listings = db.prepare(`
      SELECT l.*, s.nickname as store_name, s.tax_rate
      FROM listings l
      JOIN stores s ON s.id = l.store_id
      WHERE 1=1 ${where}
    `).all();

    const pausados       = [];
    const semEstoque     = [];
    const margemBaixa    = [];
    const semCusto       = [];

    for (const l of listings) {
      const custo = custoMedio[l.id];
      const tarifa_est = l.price * 0.12; // estimativa tarifa ML ~12%
      const imposto    = l.price * ((l.tax_rate || 0) / 100);
      const margem     = custo ? ((l.price - custo - tarifa_est - imposto) / l.price * 100) : null;

      const base = { id: l.id, title: l.title, price: l.price, store_id: l.store_id, store_name: l.store_name, available_quantity: l.available_quantity, custo, margem };

      if (l.status === 'paused')                                base.problema = 'Pausado',          pausados.push(base);
      else if (l.status === 'active' && l.available_quantity === 0) base.problema = 'Sem estoque',  semEstoque.push(base);
      else if (margem !== null && margem < 10)                  base.problema = `Margem ${margem.toFixed(1)}%`, margemBaixa.push({ ...base, margem });
      else if (!custo && l.status === 'active')                 base.problema = 'Sem custo',        semCusto.push(base);
    }

    ok(res, {
      pausados:    pausados.sort((a,b)=>b.price-a.price),
      sem_estoque: semEstoque.sort((a,b)=>b.price-a.price),
      margem_baixa: margemBaixa.sort((a,b)=>a.margem-b.margem),
      sem_custo:   semCusto.sort((a,b)=>b.price-a.price),
      totais: {
        pausados: pausados.length,
        sem_estoque: semEstoque.length,
        margem_baixa: margemBaixa.length,
        sem_custo: semCusto.length,
        criticos: pausados.length + semEstoque.length + margemBaixa.length,
      },
    });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Comparação de Períodos por Loja ────────────────────────
route('GET', '/api/comparativo', (req, res, sess) => {
  try {
    const now = Date.now();
    const d = (ms) => new Date(now - ms).toISOString();

    const periodos = {
      hoje:        { from: d(0),           label: 'Hoje' },
      ontem:       { from: d(86400000),    label: 'Ontem' },
      semana:      { from: d(7*86400000),  label: 'Esta semana' },
      sem_ant:     { from: d(14*86400000), label: 'Semana anterior' },
      mes:         { from: d(30*86400000), label: 'Este mês' },
      mes_ant:     { from: d(60*86400000), label: 'Mês anterior' },
    };

    // hoje = a partir da meia-noite local
    const todayStr = (() => {
      const n = new Date();
      return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    })();
    const ontemStr = (() => {
      const n = new Date(now - 86400000);
      return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    })();

    const stores = db.prepare('SELECT id, nickname FROM stores').all();

    const queryPeriod = (fromStr, toStr) => db.prepare(`
      SELECT
        o.store_id,
        COUNT(DISTINCT o.id)                          AS pedidos,
        SUM(oi.quantity)                              AS unidades,
        ROUND(SUM(oi.unit_price * oi.quantity), 2)    AS faturamento,
        ROUND(SUM(COALESCE(oi.sale_fee, 0)), 2)       AS tarifa,
        ROUND(SUM(COALESCE(o.seller_shipping_cost,0)),2) AS frete_v,
        ROUND(SUM(COALESCE(oc.cost, 0)), 2)           AS custo,
        ROUND(SUM(oi.unit_price*oi.quantity)
          - SUM(COALESCE(oc.cost,0))
          - SUM(COALESCE(oi.sale_fee,0))
          - SUM(COALESCE(o.seller_shipping_cost,0)), 2) AS margem
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN order_costs oc ON oc.order_id = oi.order_id AND oc.item_id = oi.item_id
      WHERE o.status='paid' AND DATE(o.date_created) >= ? AND DATE(o.date_created) <= ?
      GROUP BY o.store_id
    `).all(fromStr, toStr);

    const storeMap = {};
    stores.forEach(s => { storeMap[s.id] = s.nickname; });

    const buildPeriod = (rows) => {
      const byStore = {};
      rows.forEach(r => {
        byStore[r.store_id] = {
          loja: storeMap[r.store_id] || r.store_id,
          pedidos: r.pedidos, unidades: r.unidades,
          faturamento: r.faturamento, tarifa: r.tarifa,
          frete_v: r.frete_v, custo: r.custo, margem: r.margem,
          mc_pct: r.faturamento > 0 ? Math.round(r.margem / r.faturamento * 1000) / 10 : 0,
        };
      });
      const total = rows.reduce((acc, r) => ({
        pedidos:     (acc.pedidos||0)     + r.pedidos,
        faturamento: (acc.faturamento||0) + r.faturamento,
        margem:      (acc.margem||0)      + r.margem,
      }), {});
      total.mc_pct = total.faturamento > 0 ? Math.round(total.margem / total.faturamento * 1000) / 10 : 0;
      return { por_loja: byStore, total };
    };

    const hoje    = buildPeriod(queryPeriod(todayStr, todayStr));
    const ontem   = buildPeriod(queryPeriod(ontemStr, ontemStr));

    const semIni  = (() => { const d = new Date(now - 7*86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const semAntIni = (() => { const d = new Date(now - 14*86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const mesIni  = (() => { const d = new Date(now - 30*86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const mesAntIni = (() => { const d = new Date(now - 60*86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();

    const semana   = buildPeriod(queryPeriod(semIni, todayStr));
    const sem_ant  = buildPeriod(queryPeriod(semAntIni, ontemStr));
    const mes      = buildPeriod(queryPeriod(mesIni, todayStr));
    const mes_ant  = buildPeriod(queryPeriod(mesAntIni, semIni));

    const variacao = (atual, ant) => ant > 0 ? Math.round((atual - ant) / ant * 1000) / 10 : null;

    ok(res, {
      stores: stores.map(s => ({ id: s.id, nickname: s.nickname })),
      hoje, ontem,
      semana, sem_ant,
      mes, mes_ant,
      vs_ontem: {
        faturamento: variacao(hoje.total.faturamento, ontem.total.faturamento),
        pedidos:     variacao(hoje.total.pedidos,     ontem.total.pedidos),
        margem:      variacao(hoje.total.margem,      ontem.total.margem),
      },
      vs_sem_ant: {
        faturamento: variacao(semana.total.faturamento, sem_ant.total.faturamento),
        pedidos:     variacao(semana.total.pedidos,     sem_ant.total.pedidos),
        margem:      variacao(semana.total.margem,      sem_ant.total.margem),
      },
      vs_mes_ant: {
        faturamento: variacao(mes.total.faturamento, mes_ant.total.faturamento),
        pedidos:     variacao(mes.total.pedidos,     mes_ant.total.pedidos),
        margem:      variacao(mes.total.margem,      mes_ant.total.margem),
      },
      gerado_em: new Date().toISOString(),
    });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Evolução Diária por Loja ───────────────────────────────
route('GET', '/api/evolucao', (req, res, sess) => {
  const days = Math.min(parseInt(qp(req).get('days') || '30'), 90);
  try {
    const fromDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const stores = db.prepare('SELECT id, nickname FROM stores').all();

    const rows = db.prepare(`
      SELECT
        DATE(o.date_created) as dia,
        o.store_id,
        COUNT(DISTINCT o.id)                              AS pedidos,
        ROUND(SUM(oi.unit_price * oi.quantity), 2)        AS faturamento,
        ROUND(SUM(COALESCE(oi.sale_fee,0)), 2)            AS tarifa,
        ROUND(SUM(COALESCE(o.seller_shipping_cost,0)), 2) AS frete_v,
        ROUND(SUM(COALESCE(oc.cost,0)), 2)                AS custo,
        ROUND(SUM(oi.unit_price*oi.quantity)
          - SUM(COALESCE(oc.cost,0))
          - SUM(COALESCE(oi.sale_fee,0))
          - SUM(COALESCE(o.seller_shipping_cost,0)), 2)   AS margem
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN order_costs oc ON oc.order_id = oi.order_id AND oc.item_id = oi.item_id
      WHERE o.status='paid' AND DATE(o.date_created) >= ?
      GROUP BY dia, o.store_id
      ORDER BY dia
    `).all(fromDate);

    // Gera série de datas completa
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }

    // Mapa: dia -> store_id -> dados
    const dataMap = {};
    rows.forEach(r => {
      if (!dataMap[r.dia]) dataMap[r.dia] = {};
      dataMap[r.dia][r.store_id] = r;
    });

    // Série por loja
    const series = {};
    stores.forEach(s => {
      series[s.id] = {
        nickname: s.nickname,
        dias: dates.map(dia => {
          const d = dataMap[dia]?.[s.id];
          return { dia, faturamento: d?.faturamento||0, margem: d?.margem||0, pedidos: d?.pedidos||0 };
        }),
      };
    });

    // Série total (todas lojas somadas)
    const total = dates.map(dia => {
      const dayRows = Object.values(dataMap[dia] || {});
      return {
        dia,
        faturamento: Math.round(dayRows.reduce((s, r) => s + (r.faturamento||0), 0) * 100) / 100,
        margem:      Math.round(dayRows.reduce((s, r) => s + (r.margem||0),      0) * 100) / 100,
        pedidos:     dayRows.reduce((s, r) => s + (r.pedidos||0), 0),
      };
    });

    ok(res, { dates, series, total, stores: stores.map(s => ({ id: s.id, nickname: s.nickname })), days });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ── Curva ABC por Loja ─────────────────────────────────────
route('GET', '/api/curva-abc', (req, res, sess) => {
  const days = Math.min(parseInt(qp(req).get('days') || '30'), 90);
  const storeFilter = qp(req).get('storeId') || null;
  try {
    const fromDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const storeWhere = storeFilter ? `AND o.store_id = '${storeFilter}'` : '';

    const produtos = db.prepare(`
      SELECT
        oi.item_id, oi.item_title, oi.store_id, s.nickname as loja,
        COUNT(DISTINCT o.id)                              AS pedidos,
        SUM(oi.quantity)                                  AS unidades,
        ROUND(SUM(oi.unit_price * oi.quantity), 2)        AS faturamento,
        ROUND(SUM(COALESCE(oi.sale_fee,0)), 2)            AS tarifa,
        ROUND(SUM(COALESCE(o.seller_shipping_cost,0)), 2) AS frete_v,
        ROUND(SUM(COALESCE(oc.cost,0)), 2)                AS custo,
        ROUND(SUM(oi.unit_price*oi.quantity)
          - SUM(COALESCE(oc.cost,0))
          - SUM(COALESCE(oi.sale_fee,0))
          - SUM(COALESCE(o.seller_shipping_cost,0)), 2)   AS margem
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN stores s ON s.id = oi.store_id
      LEFT JOIN order_costs oc ON oc.order_id = oi.order_id AND oc.item_id = oi.item_id
      WHERE o.status='paid' AND DATE(o.date_created) >= ? ${storeWhere}
      GROUP BY oi.item_id, oi.store_id
      ORDER BY faturamento DESC
    `).all(fromDate);

    const totalFat = produtos.reduce((s, p) => s + (p.faturamento||0), 0);

    // Classifica ABC por faturamento acumulado
    let acumulado = 0;
    const classificados = produtos.map(p => {
      acumulado += p.faturamento || 0;
      const pct_acum = totalFat > 0 ? acumulado / totalFat * 100 : 0;
      const pct_fat  = totalFat > 0 ? (p.faturamento||0) / totalFat * 100 : 0;
      const mc_pct   = p.faturamento > 0 ? Math.round(p.margem / p.faturamento * 1000) / 10 : 0;
      const curva    = pct_acum <= 80 ? 'A' : pct_acum <= 95 ? 'B' : 'C';
      return { ...p, pct_fat: Math.round(pct_fat * 10)/10, pct_acum: Math.round(pct_acum * 10)/10, mc_pct, curva };
    });

    // Resumo por classe e por loja
    const resumo = { A: { count:0, fat:0, pct:0 }, B: { count:0, fat:0, pct:0 }, C: { count:0, fat:0, pct:0 } };
    classificados.forEach(p => {
      resumo[p.curva].count++;
      resumo[p.curva].fat += p.faturamento||0;
    });
    ['A','B','C'].forEach(c => {
      resumo[c].fat = Math.round(resumo[c].fat * 100) / 100;
      resumo[c].pct = totalFat > 0 ? Math.round(resumo[c].fat / totalFat * 1000) / 10 : 0;
    });

    // Resumo por loja
    const porLoja = {};
    classificados.forEach(p => {
      if (!porLoja[p.store_id]) porLoja[p.store_id] = { loja: p.loja, A:[], B:[], C:[] };
      porLoja[p.store_id][p.curva].push(p);
    });

    ok(res, { produtos: classificados, resumo, por_loja: porLoja, total_faturamento: totalFat, days });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// ============================================================
// MONITORAMENTO & ALERTAS TELEGRAM
// ============================================================

// Helpers de config
function monitorGet(key, def) {
  const row = db.prepare('SELECT value FROM monitor_config WHERE key=?').get(key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function monitorSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO monitor_config(key,value) VALUES(?,?)').run(key, JSON.stringify(value));
}

// Padrão de configuração de alertas
const MONITOR_DEFAULTS = {
  telegram_token:   '',
  telegram_chat_id: '',
  enabled:          false,
  interval_min:     60,
  alert_vendas:     true,
  alert_estoque:    true,
  alert_scheduler:  true,
  alert_pm2:        true,
  alert_erros:      true,
  alert_perguntas:     true,
  alert_mensagens:     true,
  alert_cancelamentos: true,
  alert_anuncios:      true,
  alert_pedido_novo:   true,
  alert_servidor:      true,
  meta_diaria:         0,
  threshold_estoque_dias: 7,
  threshold_erros:  3,
  quiet_start:      0,
  quiet_end:        7,
};

// Coleta snapshot de status do sistema
function coletarStatus() {
  const todayStr = (() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
  })();

  // Vendas de hoje por loja
  const vendas = db.prepare(`
    SELECT s.nickname as loja, o.store_id,
      COUNT(DISTINCT o.id) as pedidos,
      ROUND(SUM(oi.unit_price*oi.quantity),2) as faturamento
    FROM orders o
    JOIN order_items oi ON oi.order_id=o.id
    JOIN stores s ON s.id=o.store_id
    WHERE o.status='paid' AND DATE(o.date_created)=?
    GROUP BY o.store_id
  `).all(todayStr);

  // Estoque crítico
  const dias = monitorGet('threshold_estoque_dias', 7);
  const vendasSemana = db.prepare(`
    SELECT oi.item_id, oi.store_id, s.nickname as loja, oi.item_title,
      SUM(oi.quantity)/7.0 as ritmo_diario
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    JOIN stores s ON s.id=oi.store_id
    WHERE o.status='paid' AND o.date_created >= date('now','-7 days')
    GROUP BY oi.item_id, oi.store_id
    HAVING ritmo_diario > 0
  `).all();

  const estoques = {};
  db.prepare('SELECT id, store_id, available_quantity FROM listings').all()
    .forEach(l => { estoques[`${l.id}_${l.store_id}`] = l.available_quantity || 0; });

  const estoqueCritico = vendasSemana
    .map(v => {
      const estq = estoques[`${v.item_id}_${v.store_id}`] || 0;
      const diasRestantes = v.ritmo_diario > 0 ? Math.floor(estq / v.ritmo_diario) : 999;
      return { ...v, estoque: estq, dias_restantes: diasRestantes };
    })
    .filter(v => v.dias_restantes <= dias)
    .sort((a, b) => a.dias_restantes - b.dias_restantes)
    .slice(0, 10);

  // Scheduler
  const scheduler = {
    pending:   db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='pending'").get().n,
    running:   db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='running'").get().n,
    completed: db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='completed' AND completed_at>=unixepoch('now','start of day')").get().n,
    failed:    db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='failed' AND completed_at>=unixepoch('now','start of day')").get().n,
    retries:   db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE attempts>1 AND created_at>=unixepoch('now','start of day')").get().n,
  };

  // Erros recentes (última hora)
  const errosHora = db.prepare("SELECT COUNT(*) as n FROM job_queue WHERE status='failed' AND completed_at>=unixepoch()-3600").get().n;

  return { vendas, estoqueCritico, scheduler, errosHora, gerado_em: new Date().toISOString() };
}

// Verifica status (systemctl) de um serviço, tentando uma lista de nomes candidatos
function checkService(candidatos) {
  for (const nome of candidatos) {
    try {
      execSync(`systemctl cat ${nome} >/dev/null 2>&1`);
    } catch {
      continue; // unidade não existe, tenta o próximo nome candidato
    }
    let status = 'unknown', enabled = 'unknown';
    try { status = execSync(`systemctl is-active ${nome} 2>/dev/null`, { encoding: 'utf8' }).trim(); }
    catch (e) { status = (e.stdout || '').toString().trim() || 'inactive'; }
    try { enabled = execSync(`systemctl is-enabled ${nome} 2>/dev/null`, { encoding: 'utf8' }).trim(); }
    catch (e) { enabled = (e.stdout || '').toString().trim() || 'desativado'; }
    return { nome, status, enabled };
  }
  return null;
}

// Coleta status dos principais serviços do servidor
function coletarServicos() {
  const lista = [
    { label: '🛡️ fail2ban',       candidatos: ['fail2ban'] },
    { label: '🔥 Firewall (UFW)',  candidatos: ['ufw'] },
    { label: '🐳 Docker',          candidatos: ['docker'] },
    { label: '🗄️ Banco de Dados',  candidatos: ['postgresql', 'mysql', 'mariadb'] },
    { label: '⚡ PM2',              candidatos: ['pm2-root', 'pm2-www-data'] },
    { label: '🟢 Node.js (App)',   candidatos: ['ml-dashboard'] },
    { label: '🔑 SSH',             candidatos: ['ssh', 'sshd'] },
    { label: '🌐 Nginx',           candidatos: ['nginx'] },
    { label: '⏰ Cron',            candidatos: ['cron', 'crond'] },
  ];

  const servicos = lista.map(item => {
    const r = checkService(item.candidatos);
    return {
      label: item.label,
      nome: r ? r.nome : item.candidatos[0],
      status: r ? r.status : 'não instalado',
      enabled: r ? r.enabled : '',
    };
  });

  // SQLite não é um serviço systemd: verifica se o banco responde a uma query
  let dbStatus = 'inactive';
  try { db.prepare('SELECT 1').get(); dbStatus = 'active'; } catch { dbStatus = 'failed'; }
  const dbItem = servicos.find(s => s.label === '🗄️ Banco de Dados');
  if (dbItem && dbItem.status === 'não instalado') {
    dbItem.nome = 'SQLite (arquivo local)';
    dbItem.status = dbStatus;
    dbItem.enabled = '';
  }

  return servicos;
}

// Coleta snapshot de saúde do servidor (disco, CPU, memória, rede, conexões, SSH banidos)
let _netPrev = null;
function coletarStatusServidor() {
  const result = { disco: null, cpu: null, mem: null, rede: null, conexoes: [], sshBanidos: null };

  try {
    const out = execSync("df -h / --output=size,used,avail,pcent | tail -1", { encoding: 'utf8' }).trim();
    const [size, used, avail, pcent] = out.split(/\s+/);
    result.disco = { size, used, avail, pcent };
  } catch {}

  try {
    const load = os.loadavg();
    const cores = os.cpus().length || 1;
    result.cpu = { load1: load[0].toFixed(2), cores, pct: Math.min(100, Math.round((load[0] / cores) * 100)) };
  } catch {}

  try {
    const total = os.totalmem(), free = os.freemem();
    const usado = total - free;
    result.mem = {
      usadoGB: (usado / 1024 / 1024 / 1024).toFixed(1),
      totalGB: (total / 1024 / 1024 / 1024).toFixed(1),
      pct: Math.round((usado / total) * 100),
    };
  } catch {}

  try {
    const dev = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    dev.split('\n').slice(2).forEach(line => {
      const parts = line.trim().split(/\s+/);
      const iface = (parts[0] || '').replace(':', '');
      if (!iface || iface === 'lo') return;
      rx += parseInt(parts[1] || '0', 10);
      tx += parseInt(parts[9] || '0', 10);
    });
    const now = Date.now();
    if (_netPrev) {
      const deltaSec = (now - _netPrev.ts) / 1000;
      if (deltaSec > 0) {
        result.rede = {
          downKbps: ((rx - _netPrev.rx) / 1024 / deltaSec).toFixed(1),
          upKbps: ((tx - _netPrev.tx) / 1024 / deltaSec).toFixed(1),
        };
      }
    }
    _netPrev = { rx, tx, ts: now };
  } catch {}

  try {
    const out = execSync(`ss -tn state established 2>/dev/null | tail -n +2`, { encoding: 'utf8' }).trim();
    const ips = new Set();
    out.split('\n').filter(Boolean).forEach(line => {
      const parts = line.trim().split(/\s+/);
      const peer = parts[4] || '';
      const ip = peer.replace(/:[0-9]+$/, '').replace(/^\[|\]$/g, '');
      if (ip && ip !== '127.0.0.1' && ip !== '::1') ips.add(ip);
    });
    result.conexoes = Array.from(ips);
  } catch {}

  try {
    let out;
    try {
      out = execSync("sudo -n fail2ban-client status sshd 2>/dev/null", { encoding: 'utf8' });
    } catch {
      out = execSync("fail2ban-client status sshd 2>/dev/null", { encoding: 'utf8' });
    }
    const totalMatch = out.match(/Total banned:\s*(\d+)/);
    const currentMatch = out.match(/Currently banned:\s*(\d+)/);
    const listMatch = out.match(/Banned IP list:\s*(.*)/);
    result.sshBanidos = {
      total: totalMatch ? parseInt(totalMatch[1], 10) : 0,
      atual: currentMatch ? parseInt(currentMatch[1], 10) : 0,
      ips: listMatch ? listMatch[1].trim().split(/\s+/).filter(Boolean) : [],
    };
  } catch {}

  return result;
}

// Envia mensagem Telegram
function telegramBaseUrl() {
  try {
    const u = new URL(ML_REDIRECT_URI);
    return `${u.protocol}//${u.host}`;
  } catch { return ''; }
}

async function setTelegramWebhook(token) {
  const base = telegramBaseUrl();
  if (!base || !token) return;
  let secret = monitorGet('telegram_webhook_secret', '');
  if (!secret) {
    secret = crypto.randomBytes(24).toString('hex');
    monitorSet('telegram_webhook_secret', secret);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${base}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ['message'],
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || 'Falha ao registrar webhook do Telegram');
  return json;
}

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || 'Telegram error');
  return json;
}

// Monta e envia alerta completo
async function dispararAlertas(forceAll = false) {
  const cfg = {};
  Object.keys(MONITOR_DEFAULTS).forEach(k => { cfg[k] = monitorGet(k, MONITOR_DEFAULTS[k]); });

  if (!cfg.enabled && !forceAll) {
    console.log('[monitor] Alerta periódico pulado: monitor desativado (enabled=false)');
    return;
  }
  if (!cfg.telegram_token || !cfg.telegram_chat_id) {
    console.log('[monitor] Alerta periódico pulado: telegram_token ou telegram_chat_id não configurados');
    return;
  }

  // Respeita horário de silêncio (sempre em horário de Brasília, independente do TZ do servidor)
  // quiet_start === quiet_end desativa o silêncio (nunca pula por horário)
  if (!forceAll && cfg.quiet_start !== cfg.quiet_end) {
    const hora = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
    let emSilencio;
    if (cfg.quiet_start < cfg.quiet_end) emSilencio = hora >= cfg.quiet_start && hora < cfg.quiet_end;
    else emSilencio = hora >= cfg.quiet_start || hora < cfg.quiet_end;
    if (emSilencio) {
      console.log(`[monitor] Alerta periódico pulado: horário de silêncio (hora BR=${hora}, quiet=${cfg.quiet_start}-${cfg.quiet_end})`);
      return;
    }
  }

  const s = coletarStatus();
  const linhas = [];
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  linhas.push(`<b>📊 ML Dashboard — Relatório ${agora}</b>\n`);

  // Vendas por loja
  if (cfg.alert_vendas) {
    if (s.vendas.length === 0) {
      linhas.push('🛒 <b>Vendas hoje:</b> Nenhuma venda registrada ainda');
    } else {
      linhas.push('🛒 <b>Vendas hoje por loja:</b>');
      s.vendas.forEach(v => {
        linhas.push(`  • <b>${v.loja}</b>: ${v.pedidos} pedidos — R$ ${(v.faturamento||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
      });
      const totalFat = s.vendas.reduce((a, v) => a + (v.faturamento||0), 0);
      const totalPed = s.vendas.reduce((a, v) => a + v.pedidos, 0);
      linhas.push(`  📦 Total: ${totalPed} pedidos — R$ ${totalFat.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
    }
    linhas.push('');
  }

  // Estoque crítico
  if (cfg.alert_estoque && s.estoqueCritico.length > 0) {
    linhas.push('⚠️ <b>Estoque crítico:</b>');
    s.estoqueCritico.slice(0, 5).forEach(p => {
      const icon = p.dias_restantes <= 0 ? '🔴' : p.dias_restantes <= 3 ? '🟠' : '🟡';
      linhas.push(`  ${icon} ${p.item_title.slice(0,40)}... [${p.loja}]`);
      linhas.push(`     Estoque: ${p.estoque} un • ${p.dias_restantes <= 0 ? 'ZERADO' : p.dias_restantes + ' dias restantes'}`);
    });
    linhas.push('');
  }

  // Scheduler
  if (cfg.alert_scheduler) {
    const q = s.scheduler;
    linhas.push('⚙️ <b>Job Scheduler:</b>');
    linhas.push(`  ⏳ Pendentes: ${q.pending} | ⚙️ Rodando: ${q.running}`);
    linhas.push(`  ✅ Concluídos hoje: ${q.completed} | ❌ Falhas: ${q.failed} | 🔄 Retries: ${q.retries}`);
    linhas.push('');
  }

  // Erros críticos
  if (cfg.alert_erros && s.errosHora >= (cfg.threshold_erros || 3)) {
    linhas.push(`🚨 <b>ATENÇÃO:</b> ${s.errosHora} erros na última hora!`);
    linhas.push('');
  }

  // PM2 / processo
  if (cfg.alert_pm2) {
    const uptime = Math.floor(process.uptime());
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
    linhas.push(`🖥️ <b>Processo:</b> Ativo há ${h}h${m}m | Memória: ${mem} MB`);
  }

  // Saúde do servidor (disco, CPU, rede, conexões, SSH banidos)
  if (cfg.alert_servidor) {
    const srv = coletarStatusServidor();
    linhas.push('');
    linhas.push('🖥️ <b>Servidor:</b>');
    if (srv.disco) linhas.push(`  💾 Disco: ${srv.disco.used}/${srv.disco.size} usado (${srv.disco.pcent}) — livre: ${srv.disco.avail}`);
    if (srv.cpu) linhas.push(`  🔧 CPU: ${srv.cpu.pct}% (load ${srv.cpu.load1}, ${srv.cpu.cores} núcleos)`);
    if (srv.mem) linhas.push(`  🧠 Memória: ${srv.mem.usadoGB}GB/${srv.mem.totalGB}GB (${srv.mem.pct}%)`);
    if (srv.rede) linhas.push(`  📶 Rede: ⬇️ ${srv.rede.downKbps} KB/s | ⬆️ ${srv.rede.upKbps} KB/s`);
    linhas.push(srv.conexoes.length > 0
      ? `  🔌 IPs conectados agora (${srv.conexoes.length}): ${srv.conexoes.slice(0, 10).join(', ')}`
      : '  🔌 Nenhuma conexão ativa no momento');
    if (srv.sshBanidos) {
      linhas.push(`  🚫 SSH banidos: ${srv.sshBanidos.atual} ativos / ${srv.sshBanidos.total} no total`);
    } else {
      linhas.push('  🚫 SSH banidos: fail2ban não disponível/configurado');
    }

    const servicos = coletarServicos();
    const fora = servicos.filter(sv => sv.status !== 'active' && sv.status !== 'não instalado');
    linhas.push('');
    if (fora.length > 0) {
      linhas.push('🔧 <b>Serviços com problema:</b>');
      fora.forEach(sv => linhas.push(`  🔴 ${sv.label.replace(/^[^\s]+\s/, '')}: ${sv.status}`));
    } else {
      linhas.push('✅ <b>Serviços:</b> todos ativos');
    }
  }

  const texto = linhas.join('\n');
  await sendTelegram(cfg.telegram_token, cfg.telegram_chat_id, texto);
  monitorSet('last_alert_sent', new Date().toISOString());
  console.log('[monitor] Alerta Telegram enviado');
}

// Agenda job de alertas a cada N minutos
let monitorInterval = null;
function startMonitorJob() {
  if (monitorInterval) clearInterval(monitorInterval);
  const minutos = monitorGet('interval_min', 60);
  const ms = Math.max(minutos, 5) * 60_000;
  monitorInterval = setInterval(() => {
    dispararAlertas().catch(e => console.error('[monitor] Erro ao enviar alerta:', e.message));
  }, ms);
  console.log(`[monitor] Job agendado a cada ${minutos} min`);
}

// ── Endpoints de monitoramento ─────────────────────────────

route('GET', '/api/monitor/config', (req, res, sess) => {
  const cfg = {};
  Object.keys(MONITOR_DEFAULTS).forEach(k => { cfg[k] = monitorGet(k, MONITOR_DEFAULTS[k]); });
  cfg.last_alert_sent = monitorGet('last_alert_sent', null);
  ok(res, cfg);
});

route('PUT', '/api/monitor/config', async (req, res, sess) => {
  const body = await readBody(req);
  Object.keys(MONITOR_DEFAULTS).forEach(k => {
    if (body[k] !== undefined) monitorSet(k, body[k]);
  });
  // Reagenda se intervalo mudou
  startMonitorJob();
  // Registra webhook do Telegram para permitir responder via reply
  if (body.telegram_token) {
    setTelegramWebhook(body.telegram_token).catch(e => console.error('[telegram_webhook] setup:', e.message));
  }
  ok(res, { ok: true });
});

route('GET', '/api/monitor/status', (req, res, sess) => {
  try {
    const s = coletarStatus();
    const uptime = Math.floor(process.uptime());
    s.processo = {
      uptime_s: uptime,
      uptime_fmt: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`,
      mem_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node_version: process.version,
      pid: process.pid,
    };
    s.last_alert_sent = monitorGet('last_alert_sent', null);
    s.servidor = coletarStatusServidor();
    s.servicos = coletarServicos();
    ok(res, s);
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('POST', '/api/monitor/telegram-test', async (req, res, sess) => {
  try {
    const body = await readBody(req);
    const token  = body.token  || monitorGet('telegram_token',   '');
    const chatId = body.chat_id || monitorGet('telegram_chat_id', '');
    if (!token || !chatId) { apiErr(res, 400, 'token e chat_id obrigatórios'); return; }
    await sendTelegram(token, chatId, '✅ <b>ML Dashboard</b> — Teste de alerta funcionando!');
    ok(res, { ok: true });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

route('POST', '/api/monitor/send-now', async (req, res, sess) => {
  try {
    await dispararAlertas(true);
    ok(res, { ok: true });
  } catch (e) {
    apiErr(res, 500, e.message);
  }
});

// Recebe replies do Telegram e responde a pergunta/mensagem correspondente no ML
route('POST', '/api/telegram/webhook', async (req, res) => {
  try {
    const secret = monitorGet('telegram_webhook_secret', '');
    if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
      res.writeHead(403); res.end(); return;
    }

    const body = await readBody(req);
    const msg  = body?.message;
    if (!msg?.reply_to_message?.message_id || !msg.text) {
      res.writeHead(200); res.end('ok'); return;
    }

    const map = db.prepare('SELECT * FROM telegram_reply_map WHERE tg_message_id=?')
      .get(msg.reply_to_message.message_id);
    if (!map) { res.writeHead(200); res.end('ok'); return; }

    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(map.store_id);
    const token = await ensureFreshToken(store);
    const tgToken = monitorGet('telegram_token', '');
    const tgChat  = monitorGet('telegram_chat_id', '');

    if (map.kind === 'question') {
      await mlFetch('/answers', { method: 'POST', token, body: { question_id: map.question_id, text: msg.text } });
      db.prepare("UPDATE questions_sync SET status='ANSWERED', answer_text=?, answer_date=? WHERE id=?")
        .run(msg.text, new Date().toISOString(), map.question_id);
      broadcast('question_answered', { question_id: map.question_id, store_id: map.store_id });
      if (tgToken && tgChat) await sendTelegram(tgToken, tgChat, `✅ Resposta enviada a <b>${map.buyer || 'comprador'}</b>.`).catch(() => {});
    } else if (map.kind === 'message') {
      await mlFetch(`/messages/packs/${map.pack_id}/sellers/${map.store_id}`, {
        method: 'POST', token,
        body: { from: { user_id: parseInt(map.store_id) }, to: { group_id: map.pack_id }, text: { plain: msg.text } },
      });
      broadcast('message_sent', { pack_id: map.pack_id, store_id: map.store_id });
      if (tgToken && tgChat) await sendTelegram(tgToken, tgChat, `✅ Mensagem enviada a <b>${map.buyer || 'comprador'}</b>.`).catch(() => {});
    }

    res.writeHead(200); res.end('ok');
  } catch (e) {
    console.error('[telegram_webhook]', e.message);
    try { res.writeHead(200); res.end('ok'); } catch {}
  }
}, true);

// ── Alertas automáticos: cancelamentos novos e anúncios problema ──
async function checkCancelamentosAlert() {
  const tgEnabled = monitorGet('enabled', false);
  const tgToken   = monitorGet('telegram_token', '');
  const tgChat    = monitorGet('telegram_chat_id', '');
  if (!tgEnabled || !tgToken || !tgChat) return;
  if (!monitorGet('alert_cancelamentos', true)) return;

  const novos = db.prepare(`
    SELECT o.id, o.store_id, s.nickname, o.buyer_nickname, o.total_amount,
           GROUP_CONCAT(oi.item_title, ', ') as itens
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status = 'cancelled' AND o.cancel_notified = 0
    GROUP BY o.id
    ORDER BY o.date_closed DESC LIMIT 10
  `).all();

  for (const o of novos) {
    const msg = `❌ <b>Cancelamento — ${o.nickname}</b>\n\n` +
      `👤 ${o.buyer_nickname || 'Comprador'}\n` +
      `📦 ${(o.itens || '').slice(0, 80)}\n` +
      `💰 R$ ${Number(o.total_amount).toFixed(2).replace('.', ',')}`;
    await sendTelegram(tgToken, tgChat, msg).catch(() => {});
    db.prepare('UPDATE orders SET cancel_notified=1 WHERE id=?').run(o.id);
  }
}

async function checkAnunciosProblemaAlert() {
  const tgEnabled = monitorGet('enabled', false);
  const tgToken   = monitorGet('telegram_token', '');
  const tgChat    = monitorGet('telegram_chat_id', '');
  if (!tgEnabled || !tgToken || !tgChat) return;
  if (!monitorGet('alert_anuncios', true)) return;

  // Pausados recentes (synced nas últimas 2h com status paused) não alertados ainda
  const pausados = db.prepare(`
    SELECT l.id, l.title, l.price, s.nickname
    FROM listings l JOIN stores s ON s.id = l.store_id
    WHERE l.status = 'paused'
      AND NOT EXISTS (SELECT 1 FROM listing_alerts_sent WHERE kind='paused' AND ref_id=l.id)
  `).all();
  for (const l of pausados) {
    const msg = `⏸️ <b>Anúncio Pausado — ${l.nickname}</b>\n📦 ${l.title.slice(0,80)}\n💰 R$ ${Number(l.price).toFixed(2).replace('.',',')}`;
    await sendTelegram(tgToken, tgChat, msg).catch(() => {});
    db.prepare('INSERT OR IGNORE INTO listing_alerts_sent(kind,ref_id,store_id) VALUES(?,?,?)').run('paused', l.id, '');
  }

  // Sem estoque mas ativo
  const semEstoque = db.prepare(`
    SELECT l.id, l.title, l.price, s.nickname
    FROM listings l JOIN stores s ON s.id = l.store_id
    WHERE l.status = 'active' AND l.available_quantity = 0
      AND NOT EXISTS (SELECT 1 FROM listing_alerts_sent WHERE kind='zero_stock' AND ref_id=l.id)
  `).all();
  for (const l of semEstoque) {
    const msg = `📭 <b>Sem Estoque (ativo) — ${l.nickname}</b>\n📦 ${l.title.slice(0,80)}\n💰 R$ ${Number(l.price).toFixed(2).replace('.',',')}`;
    await sendTelegram(tgToken, tgChat, msg).catch(() => {});
    db.prepare('INSERT OR IGNORE INTO listing_alerts_sent(kind,ref_id,store_id) VALUES(?,?,?)').run('zero_stock', l.id, '');
  }

  // Limpa alertas de anúncios que voltaram ao normal
  db.prepare("DELETE FROM listing_alerts_sent WHERE kind='paused' AND ref_id IN (SELECT id FROM listings WHERE status != 'paused')").run();
  db.prepare("DELETE FROM listing_alerts_sent WHERE kind='zero_stock' AND ref_id IN (SELECT id FROM listings WHERE status='active' AND available_quantity > 0)").run();
}

// Roda a cada 30 minutos (sem chamada à API do ML)
setInterval(() => {
  checkCancelamentosAlert().catch(() => {});
  checkAnunciosProblemaAlert().catch(() => {});
}, 30 * 60_000);

setTimeout(() => {
  checkCancelamentosAlert().catch(() => {});
  checkAnunciosProblemaAlert().catch(() => {});
}, 90_000);

// Inicia job ao subir o servidor
startMonitorJob();

// Garante webhook do Telegram registrado ao reiniciar o servidor
{
  const existingToken = monitorGet('telegram_token', '');
  if (existingToken) setTelegramWebhook(existingToken).catch(e => console.error('[telegram_webhook] boot:', e.message));
}

// ============================================================
// POLLING DE MENSAGENS & PERGUNTAS — WebSocket + Telegram
// ============================================================

async function pollNewQuestions() {
  const stores = db.prepare('SELECT * FROM stores').all();
  for (const store of stores) {
    try {
      const page = await mlFetch(
        `/questions/search?seller_id=${store.id}&status=UNANSWERED&limit=20&sort_fields=date_created&sort_types=DESC`,
        {}, store.id
      );
      if (!page?.questions?.length) continue;

      const insert = db.prepare(`
        INSERT OR IGNORE INTO questions_sync
          (id,store_id,item_id,item_title,buyer_nickname,text,status,date_created,answer_text,answer_date)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `);

      for (const q of page.questions) {
        const exists = db.prepare('SELECT id FROM questions_sync WHERE id=?').get(String(q.id));
        if (!exists) {
          // Nova pergunta — salva, broadcast e alerta Telegram
          insert.run(String(q.id), store.id, q.item_id||'', q.item?.title||'', q.from?.nickname||'', q.text||'', q.status||'UNANSWERED', q.date_created||'', '', '');

          const payload = {
            type:    'new_question',
            id:      String(q.id),
            store:   store.nickname,
            buyer:   q.from?.nickname || 'Comprador',
            text:    q.text || '',
            item:    q.item?.title || q.item_id || '',
            date:    q.date_created,
          };
          broadcast('new_question', payload);

          // Telegram
          const tgEnabled = monitorGet('enabled', false);
          const tgToken   = monitorGet('telegram_token', '');
          const tgChat    = monitorGet('telegram_chat_id', '');
          if (tgEnabled && tgToken && tgChat && monitorGet('alert_perguntas', true)) {
            const msg = `❓ <b>Nova Pergunta — ${store.nickname}</b>\n\n` +
              `👤 ${payload.buyer}\n` +
              `📦 ${payload.item.slice(0, 60)}\n\n` +
              `<i>${payload.text.slice(0, 300)}</i>\n\n` +
              `↩️ <i>Responda esta mensagem para enviar a resposta diretamente ao comprador.</i>`;
            sendTelegram(tgToken, tgChat, msg).then(r => {
              const tgMsgId = r?.result?.message_id;
              if (tgMsgId) {
                db.prepare(`INSERT OR IGNORE INTO telegram_reply_map
                  (tg_message_id, kind, question_id, store_id, item_title, buyer)
                  VALUES (?,?,?,?,?,?)`
                ).run(tgMsgId, 'question', String(q.id), store.id, payload.item, payload.buyer);
              }
            }).catch(() => {});
          }
        } else {
          // Garante que perguntas existentes estão atualizadas
          insert.run(String(q.id), store.id, q.item_id||'', q.item?.title||'', q.from?.nickname||'', q.text||'', q.status||'UNANSWERED', q.date_created||'', '', '');
        }
      }

      // Atualiza badge count via broadcast
      const unanswered = db.prepare("SELECT COUNT(*) as n FROM questions_sync WHERE store_id=? AND status='UNANSWERED'").get(store.id).n;
      broadcast('questions_count', { store_id: store.id, store: store.nickname, count: unanswered });

    } catch (e) {
      console.error(`[poll_questions] ${store.nickname}:`, e.message);
    }
  }
}

async function pollNewMessages() {
  const stores = db.prepare('SELECT * FROM stores').all();
  for (const store of stores) {
    try {
      // Usa pack_id salvo diretamente no orders (sem chamar /packs/by_order_id/)
      // Popula packs_seen a partir dos pedidos que já têm pack_id no banco
      const ordensComPack = db.prepare(`
        SELECT id as order_id, buyer_nickname, pack_id FROM orders
        WHERE store_id=? AND status='paid' AND pack_id != '' AND pack_id IS NOT NULL
          AND pack_id NOT IN (SELECT pack_id FROM packs_seen WHERE store_id=?)
        ORDER BY date_created DESC LIMIT 20
      `).all(store.id, store.id);

      for (const o of ordensComPack) {
        db.prepare('INSERT OR IGNORE INTO packs_seen(pack_id,store_id,order_id,buyer) VALUES(?,?,?,?)')
          .run(o.pack_id, store.id, o.order_id, o.buyer_nickname || '');
      }

      // Checar mensagens novas em packs conhecidos (últimos 20 com pack_id válido)
      const packsConhecidos = db.prepare(`
        SELECT pack_id, order_id, buyer FROM packs_seen
        WHERE store_id=? AND pack_id NOT LIKE 'noPack:%'
        ORDER BY synced_at DESC LIMIT 20
      `).all(store.id);

      for (const pack of packsConhecidos) {
        const packId = pack.pack_id;
        const msgData = await mlFetch(`/messages/packs/${packId}/sellers/${store.id}?tag=post_sale`, {}, store.id).catch(() => null);
        if (!msgData?.messages?.length) continue;

        for (const msg of msgData.messages) {
          if (msg.from?.user_id === parseInt(store.id)) continue;
          const msgId = String(msg.id || msg.created_at);
          const exists = db.prepare('SELECT msg_id FROM messages_cache WHERE pack_id=? AND msg_id=?').get(packId, msgId);
          if (exists) continue;

          db.prepare(`INSERT OR IGNORE INTO messages_cache(pack_id,store_id,msg_id,from_user,text,created_at,notified)
            VALUES(?,?,?,?,?,?,0)`)
            .run(packId, store.id, msgId, msg.from?.nickname||String(msg.from?.user_id||''), msg.text?.plain||'', msg.created_at||'');

          const payload = {
            type:     'new_message',
            pack_id:  packId,
            store:    store.nickname,
            store_id: store.id,
            buyer:    msg.from?.nickname || pack.buyer || 'Comprador',
            text:     msg.text?.plain || '',
            order_id: pack.order_id,
            date:     msg.created_at,
          };
          broadcast('new_message', payload);

          const tgEnabled = monitorGet('enabled', false);
          const tgToken   = monitorGet('telegram_token', '');
          const tgChat    = monitorGet('telegram_chat_id', '');
          if (tgEnabled && tgToken && tgChat && monitorGet('alert_mensagens', true)) {
            const tgText = `💬 <b>Nova Mensagem — ${store.nickname}</b>\n\n` +
              `👤 ${payload.buyer} (Pedido #${pack.order_id})\n\n` +
              `<i>${payload.text.slice(0, 300)}</i>\n\n` +
              `↩️ <i>Responda esta mensagem para enviar a resposta diretamente ao comprador.</i>`;
            sendTelegram(tgToken, tgChat, tgText).then(r => {
              const tgMsgId = r?.result?.message_id;
              if (tgMsgId) {
                db.prepare(`INSERT OR IGNORE INTO telegram_reply_map
                  (tg_message_id, kind, pack_id, order_id, store_id, buyer)
                  VALUES (?,?,?,?,?,?)`)
                  .run(tgMsgId, 'message', packId, pack.order_id, store.id, payload.buyer);
              }
            }).catch(() => {});
          }

          db.prepare('UPDATE messages_cache SET notified=1 WHERE pack_id=? AND msg_id=?').run(packId, msgId);
        }
      }
    } catch (e) {
      console.error(`[poll_messages] ${store.nickname}:`, e.message);
    }
  }
}

// Conta não lidas no broadcast inicial ao conectar
wss.on('connection', ws => {
  // Envia counts ao conectar
  try {
    const stores = db.prepare('SELECT id, nickname FROM stores').all();
    let totalQ = 0;
    stores.forEach(s => {
      const n = db.prepare("SELECT COUNT(*) as n FROM questions_sync WHERE store_id=? AND status='UNANSWERED'").get(s.id)?.n || 0;
      totalQ += n;
    });
    if (totalQ > 0) ws.send(JSON.stringify({ type: 'init_counts', data: { questions: totalQ }, ts: Date.now() }));
  } catch {}
});

// Polling a cada 3 minutos
setInterval(() => {
  pollNewQuestions().catch(e => console.error('[poll] questions:', e.message));
}, 3 * 60_000);

// Polling de mensagens a cada 5 minutos
setInterval(() => {
  pollNewMessages().catch(e => console.error('[poll] messages:', e.message));
}, 5 * 60_000);

// Roda imediatamente após 30s do boot (aguarda tokens carregados)
setTimeout(() => {
  pollNewQuestions().catch(() => {});
}, 30_000);

// Poll de mensagens 60s após o boot (depois das perguntas)
setTimeout(() => {
  pollNewMessages().catch(() => {});
}, 60_000);

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
