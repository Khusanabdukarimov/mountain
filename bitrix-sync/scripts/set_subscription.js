#!/usr/bin/env node
'use strict';

/**
 * View or change the dashboard subscription expiry (table app_subscription, read
 * by both the FastAPI backend and the Node API, so no restart is needed — the
 * change is live within ~10 seconds).
 *
 * Usage (on the server, from bitrix-sync/):
 *   node scripts/set_subscription.js                                  # show current state
 *   node scripts/set_subscription.js --expires=2026-10-30T00:00:00+05:00   # set / extend / unlock
 *   node scripts/set_subscription.js --expires=... --support=@someone  # also change the support contact
 *   node scripts/set_subscription.js --off                            # remove the limit entirely
 *
 * Always give the UTC offset (+05:00 is Tashkent). A date in the past locks the
 * dashboard immediately; a date in the future unlocks it.
 */

require('dotenv').config();
const pool = require('../src/db/pool');
const { ensureTable, buildStatus } = require('../src/middleware/subscription');

const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const expires = arg('expires');
const support = arg('support');
const off = process.argv.includes('--off');

(async () => {
  await ensureTable();

  if (off) {
    await pool.query('DELETE FROM app_subscription WHERE id = 1');
    console.log('[subscription] limit removed — the dashboard is not locked and shows no countdown');
  } else if (expires) {
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(expires)) { console.error('give the UTC offset, e.g. 2026-10-30T00:00:00+05:00'); process.exit(1); }
    const when = new Date(expires);
    if (isNaN(when.getTime())) { console.error(`cannot parse date: ${expires}`); process.exit(1); }
    await pool.query(
      `INSERT INTO app_subscription (id, expires_at, support_contact) VALUES (1, $1, NULLIF($2, ''))
       ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at,
         support_contact = COALESCE(NULLIF($2, ''), app_subscription.support_contact), updated_at = NOW()`,
      [when.toISOString(), support]);
    console.log(`[subscription] expiry set to ${when.toISOString()}`);
  }

  const { rows } = await pool.query('SELECT expires_at, support_contact FROM app_subscription WHERE id = 1');
  const s = buildStatus(rows[0] || null);
  if (!s.enabled) console.log('state: no limit set');
  else {
    const tash = new Date(s.expires_at).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
    console.log(`state: ${s.expired ? 'EXPIRED (dashboard locked)' : 'active'} | expires ${s.expires_at} (${tash} Tashkent) | ${s.expired ? '' : `${Math.floor(s.seconds_left / 3600)} h left | `}support ${s.support}`);
  }
})()
  .catch(err => { console.error('[subscription] failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
