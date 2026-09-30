'use strict';

// Postgres data layer for the Valora production marketplace.
//
// The query helpers accept the same `?` placeholders the codebase has always
// used; they are rewritten to Postgres `$1, $2, …` automatically. All helpers
// are async.

const { Pool, types } = require('pg');

// node-postgres returns BIGINT (int64) columns as strings; Valora only uses
// COUNT(*) and SUM() aggregates that fit in a JS number, so parse them.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('new','used')),
  price_estimate_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','traded','removed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, created_at);

CREATE TABLE IF NOT EXISTS listing_photos (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  filename TEXT NOT NULL UNIQUE,
  data BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  from_member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  item_title TEXT NOT NULL,
  item_description TEXT NOT NULL,
  item_condition TEXT NOT NULL CHECK (item_condition IN ('new','used')),
  cash_on_top_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_on_top_cents >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at TEXT NOT NULL
);
-- Exactly one owner ever, enforced at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_owner
  ON members(is_owner) WHERE is_owner = 1;

-- One active (pending) offer per member per listing, enforced at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_offers_one_pending
  ON offers(listing_id, from_member_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS offer_photos (
  id SERIAL PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  filename TEXT NOT NULL UNIQUE,
  data BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  seller_member_id INTEGER NOT NULL REFERENCES members(id),
  buyer_member_id INTEGER NOT NULL REFERENCES members(id),
  cash_on_top_cents INTEGER NOT NULL DEFAULT 0,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL,
  stripe_payment_intent_id TEXT
);

CREATE TABLE IF NOT EXISTS stripe_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret_key TEXT,
  publishable_key TEXT,
  account_id TEXT,
  connected_at TEXT
);

CREATE TABLE IF NOT EXISTS fee_ledger (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  amount_cents INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(email, ip, created_at);
`;

// Rewrite `?` placeholders to `$1, $2, …`. (No query in this codebase uses a
// literal `?` inside a quoted string, so a plain scan is safe.)
function pgify(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
}

function isLocalhostUrl(url) {
  return !url || /localhost|127\.0\.0\.1/.test(url);
}

// connectionString: Postgres URL (e.g. from DATABASE_URL).
// poolOverride: an existing pg Pool (used by tests with an in-memory server).
function createDb(connectionString, poolOverride) {
  const pool =
    poolOverride ||
    new Pool({
      connectionString,
      ssl: isLocalhostUrl(connectionString) ? false : { rejectUnauthorized: false },
    });

  async function init() {
    // Run one statement at a time: works on real Postgres and on pg-mem.
    const stmts = SCHEMA.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of stmts) {
      await pool.query(stmt);
    }
  }

  async function get(sql, ...params) {
    const r = await pool.query(pgify(sql), params);
    return r.rows[0] || null;
  }

  async function all(sql, ...params) {
    const r = await pool.query(pgify(sql), params);
    return r.rows;
  }

  async function run(sql, ...params) {
    const r = await pool.query(pgify(sql), params);
    return { changes: r.rowCount };
  }

  // INSERT … RETURNING id — resolves with the new row's id.
  async function insert(sql, ...params) {
    const r = await pool.query(pgify(sql) + ' RETURNING id', params);
    return r.rows[0].id;
  }

  // fn receives a tx object with the same helpers, bound to one client.
  async function transaction(fn) {
    const client = await pool.connect();
    const tx = {
      get: async (sql, ...p) => (await client.query(pgify(sql), p)).rows[0] || null,
      all: async (sql, ...p) => (await client.query(pgify(sql), p)).rows,
      run: async (sql, ...p) => {
        const r = await client.query(pgify(sql), p);
        return { changes: r.rowCount };
      },
      insert: async (sql, ...p) =>
        (await client.query(pgify(sql) + ' RETURNING id', p)).rows[0].id,
    };
    try {
      await client.query('BEGIN');
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors; the original error matters
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async function close() {
    await pool.end();
  }

  return { init, get, all, run, insert, transaction, close, pool };
}

module.exports = { createDb, SCHEMA };
