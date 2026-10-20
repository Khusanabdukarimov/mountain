'use strict';

// Dashboard subscription guard — the Node half of backend/app/core/subscription.py.
//
// Both services read one row of `app_subscription`, so one UPDATE (see
// scripts/set_subscription.js) changes both. No row = no limit. Once expires_at
// has passed, every /api/* request answers 402 `subscription_expired` — including
// the public Bitrix "to'lov" webhook POST /api/dashboard/payments. The decision
// uses the server's clock. /webhook/* (Bitrix, Meta) is not /api/ and keeps
// running, so leads are still received and distributed while access is suspended.

const pool = require('../db/pool');

const BRAND = 'Mountain';
const SUPPORT_DEFAULT = '@Jahongir_data365';
const CACHE_TTL_MS = 10_000;

let cache = { at: -Infinity, row: null };

/** Public status for a DB row `{ expires_at, support_contact }` (or null). */
function buildStatus(row, now = new Date()) {
  const base = { brand: BRAND, server_time: now.toISOString() };
  if (!row || !row.expires_at) return { ...base, enabled: false, expired: false };

  const expiresAt = new Date(row.expires_at);
  const support = String(row.support_contact || '').trim() || SUPPORT_DEFAULT;
  const secondsLeft = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  return {
    ...base,
    enabled: true,
    expired: secondsLeft <= 0,
    expires_at: expiresAt.toISOString(),
    seconds_left: Math.max(secondsLeft, 0),
    support,
    support_url: `https://t.me/${support.replace(/^@/, '')}`,
  };
}

function expiredPayload(status) {
  return {
    code: 'subscription_expired',
    detail: 'subscription_expired',
    message: `${BRAND} dashboard subscription has expired. Contact support: ${status.support}`,
    support: status.support,
    support_url: status.support_url,
    expired_at: status.expires_at,
  };
}

async function getStatus(now = new Date()) {
  if (Date.now() - cache.at > CACHE_TTL_MS) {
    try {
      const { rows } = await pool.query('SELECT expires_at, support_contact FROM app_subscription WHERE id = 1');
      cache.row = rows[0] || null;
    } catch (_) {
      // Table not created yet or a DB blip: keep the last known value, so a lock
      // that is already in force is not lifted by a failed read.
    }
    cache.at = Date.now();
  }
  return buildStatus(cache.row, now);
}

async function subscriptionGuard(req, res, next) {
  if (!req.path.startsWith('/api/') || req.path === '/api/subscription') return next();
  const status = await getStatus();
  if (!status.expired) return next();
  res.set('Cache-Control', 'no-store');
  return res.status(402).json(expiredPayload(status));
}

function ensureTable() {
  return pool.query(`
    CREATE TABLE IF NOT EXISTS app_subscription (
      id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      expires_at      TIMESTAMPTZ NOT NULL,
      support_contact TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

function resetCache() { cache = { at: -Infinity, row: null }; }

module.exports = { subscriptionGuard, buildStatus, expiredPayload, getStatus, ensureTable, resetCache };
