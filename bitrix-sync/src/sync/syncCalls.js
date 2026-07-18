const pool = require('../db/pool');
const onpbx = require('../services/onlinepbx');
const calls = require('../config/calls');

/** Unix seconds. */
const nowUnix = () => Math.floor(Date.now() / 1000);

/**
 * OnlinePBX tables. Mountain applies migrations in code (not schema.sql), so
 * the DDL lives here and runs once at boot. Idempotent.
 */
async function ensurePbxTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      entity      TEXT PRIMARY KEY,
      last_sync   TIMESTAMPTZ DEFAULT NOW(),
      total_rows  INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pbx_users (
      ext            TEXT PRIMARY KEY,   -- extension number, e.g. "101"
      name           TEXT,               -- operator name as set in the PBX panel
      enabled        BOOLEAN DEFAULT TRUE,
      responsible_id INTEGER,            -- Bitrix user with the same name, when matched
      synced_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pbx_calls (
      uuid               TEXT PRIMARY KEY,
      direction          TEXT,          -- inbound | outbound | local (accountcode)
      caller_number      TEXT,
      caller_name        TEXT,
      destination_number TEXT,
      operator_ext       TEXT REFERENCES pbx_users(ext),
      customer_number    TEXT,          -- the external party, whichever side it is
      customer_norm      TEXT,          -- last 9 digits, for matching lead phones
      start_stamp        TIMESTAMPTZ,
      end_stamp          TIMESTAMPTZ,
      duration           INTEGER DEFAULT 0,   -- total call seconds
      talk_time          INTEGER DEFAULT 0,   -- user_talk_time — live conversation seconds
      answered           BOOLEAN DEFAULT FALSE,
      contacted          BOOLEAN,             -- inbound only; NULL for outbound/local
      hangup_cause       TEXT,
      gateway            TEXT,
      quality_score      INTEGER,
      events             JSONB,
      raw                JSONB,
      synced_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pbx_calls_start_idx     ON pbx_calls(start_stamp)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pbx_calls_operator_idx  ON pbx_calls(operator_ext, start_stamp)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pbx_calls_direction_idx ON pbx_calls(direction, start_stamp)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pbx_calls_customer_idx  ON pbx_calls(customer_norm)`);
  // Normalised phone lookups used by /call-list & the Bosqich filter to attach
  // the newest same-phone lead/deal to each call.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_phones_norm_idx
      ON lead_phones (RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9))
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS deal_phones_norm_idx
      ON deal_phones (RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9))
  `);
}

/** Upsert one CDR record. Idempotent on uuid. `operator` is pre-resolved. */
async function upsertCall(rec, operator, db = pool) {
  const customer = calls.customerNumber(rec);

  await db.query(
    `INSERT INTO pbx_calls (
       uuid, direction, caller_number, caller_name, destination_number,
       operator_ext, customer_number, customer_norm,
       start_stamp, end_stamp, duration, talk_time, answered, contacted,
       hangup_cause, gateway, quality_score, events, raw, synced_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       to_timestamp($9), to_timestamp($10), $11,$12,$13,$14,
       $15,$16,$17,$18,$19, NOW()
     )
     ON CONFLICT (uuid) DO UPDATE SET
       direction        = EXCLUDED.direction,
       caller_number    = EXCLUDED.caller_number,
       caller_name      = EXCLUDED.caller_name,
       destination_number = EXCLUDED.destination_number,
       operator_ext     = EXCLUDED.operator_ext,
       customer_number  = EXCLUDED.customer_number,
       customer_norm    = EXCLUDED.customer_norm,
       start_stamp      = EXCLUDED.start_stamp,
       end_stamp        = EXCLUDED.end_stamp,
       duration         = EXCLUDED.duration,
       talk_time        = EXCLUDED.talk_time,
       answered         = EXCLUDED.answered,
       contacted        = EXCLUDED.contacted,
       hangup_cause     = EXCLUDED.hangup_cause,
       gateway          = EXCLUDED.gateway,
       quality_score    = EXCLUDED.quality_score,
       events           = EXCLUDED.events,
       raw              = EXCLUDED.raw,
       synced_at        = NOW()`,
    [
      rec.uuid,
      rec.accountcode || null,
      rec.caller_id_number || null,
      rec.caller_id_name || null,
      rec.destination_number || null,
      operator,
      customer,
      calls.normalizePhone(customer),
      rec.start_stamp || null,
      rec.end_stamp || null,
      rec.duration || 0,
      rec.user_talk_time || 0,
      calls.isAnswered(rec),
      typeof rec.contacted === 'boolean' ? rec.contacted : null,
      rec.hangup_cause || null,
      rec.gateway || null,
      rec.quality_score ?? null,
      JSON.stringify(rec.events || []),
      JSON.stringify(rec),
    ],
  );
}

/** Upsert a PBX extension. `name` may be null for stubs discovered via calls. */
async function upsertUser(ext, name, enabled = true, db = pool) {
  await db.query(
    `INSERT INTO pbx_users (ext, name, enabled, synced_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (ext) DO UPDATE SET
       -- keep a real name if we have one; never overwrite it with a stub NULL
       name    = COALESCE(EXCLUDED.name, pbx_users.name),
       enabled = EXCLUDED.enabled,
       synced_at = NOW()`,
    [String(ext), name, enabled],
  );
}

/** Mirror PBX extensions from user/get.json. */
async function syncUsers() {
  const users = await onpbx.getUsers();
  for (const u of users) await upsertUser(u.num, u.name || null, u.enabled !== false);

  // Link each extension to its Bitrix user by display name ("Operator 3" in
  // the PBX ↔ "Operator 3" in Bitrix), both name orders. Optional — the call
  // dashboard keys on the extension itself, this only enriches photos etc.
  const { rowCount } = await pool.query(
    `UPDATE pbx_users pu SET responsible_id = r.id
     FROM responsibles r
     WHERE LOWER(TRIM(pu.name)) IN (
       LOWER(TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,''))),
       LOWER(TRIM(COALESCE(r.last_name,'') || ' ' || COALESCE(r.name,'')))
     )`,
  );
  console.log(`[calls] pbx users: ${users.length} (${rowCount} linked to Bitrix users)`);
  return users.length;
}

// mongo_history/search.json has TWO independent gotchas, both verified live
// against a production feed:
//
//   1. Every response is capped at ~1171 rows.
//   2. A WIDE request silently under-reports even when far below that cap — a
//      22-day window returned 55 calls where per-day summing returned 1585, and
//      a single busy day inside it had 399. The count of a wide window is simply
//      not trustworthy.
//
// So we never trust a wide window: iterate FIXED day-sized chunks (proven
// complete for this volume), and only subdivide a chunk DOWNWARD when it hits
// the cap — never infer completeness from a wide count.
const DAY_SEC = 86400;
const CAP_TRIGGER = 1000; // below the real ~1171 cap
const MIN_WINDOW_SEC = 900; // 15 min floor; a busier slice than this truncates (logged)
// Be polite to the API during multi-day backfills.
const REQUEST_DELAY_MS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Collect every distinct call in [from, to] into `out` (keyed by uuid).
 * Walks fixed `chunkSec` windows; a chunk at/over the cap is re-collected at
 * quarter granularity so a future high-volume day can't truncate.
 */
async function collectRange(fromUnix, toUnix, out, chunkSec = DAY_SEC) {
  for (let start = fromUnix; start < toUnix; start += chunkSec) {
    const end = Math.min(start + chunkSec, toUnix);
    const records = await onpbx.searchCalls(start, end);
    await sleep(REQUEST_DELAY_MS);

    if (records.length >= CAP_TRIGGER && chunkSec > MIN_WINDOW_SEC) {
      await collectRange(start, end, out, Math.max(Math.floor(chunkSec / 4), MIN_WINDOW_SEC));
      continue;
    }
    if (records.length >= CAP_TRIGGER) {
      console.warn(
        `[calls] ${new Date(start * 1000).toISOString()} +${chunkSec}s hit the cap at the ` +
          `minimum window — some calls in this slice may be truncated`,
      );
    }
    for (const rec of records) if (rec.uuid) out.set(rec.uuid, rec);
  }
}

/**
 * Sync every call in a Unix-second window.
 *
 * Any operator extension seen on a call but absent from pbx_users (e.g. a
 * since-deleted extension) gets a stub row first, so the FK resolves and no call
 * is dropped or misattributed.
 */
async function syncCallRange(fromUnix, toUnix) {
  const collected = new Map();
  await collectRange(fromUnix, toUnix, collected);

  const knownExts = new Set(
    (await pool.query(`SELECT ext FROM pbx_users`)).rows.map((r) => r.ext),
  );

  let total = 0;
  let stubbed = 0;
  for (const rec of collected.values()) {
    const operator = calls.operatorExt(rec, knownExts);
    if (operator && !knownExts.has(operator)) {
      await upsertUser(operator, null, true);
      knownExts.add(operator);
      stubbed++;
    }
    await upsertCall(rec, operator || null);
    total++;
  }

  await pool.query(
    `INSERT INTO sync_state (entity, last_sync, total_rows) VALUES ('calls', NOW(), $1)
     ON CONFLICT (entity) DO UPDATE SET last_sync = NOW(), total_rows = $1`,
    [total],
  );

  console.log(
    `[calls] synced ${total} calls (${new Date(fromUnix * 1000).toISOString().slice(0, 10)} → ` +
      `${new Date(toUnix * 1000).toISOString().slice(0, 10)})` +
      (stubbed ? `, ${stubbed} unknown extension(s) stubbed` : ''),
  );
  return { total, stubbed };
}

/** Rolling incremental sync: re-pull the last N hours (default 3). */
async function syncRecentCalls(lookbackHours = 3) {
  const to = nowUnix();
  return syncCallRange(to - lookbackHours * 3600, to);
}

/** First boot on an empty table: pull CALL_SYNC_BACKFILL_DAYS of history. */
async function initialBackfillIfEmpty() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM pbx_calls`);
  if (rows[0].n > 0) return null;
  const days = parseInt(process.env.CALL_SYNC_BACKFILL_DAYS || '45', 10);
  console.log(`[calls] pbx_calls is empty — backfilling ${days} days from OnlinePBX`);
  const to = nowUnix();
  return syncCallRange(to - days * DAY_SEC, to);
}

/**
 * OnlinePBX call sync. No webhooks here — the PBX only offers a pull API, so a
 * simple interval re-pulls a rolling window. Skips silently when
 * ONPBX_DOMAIN / ONPBX_API_KEY are not configured.
 */
function startCallSync() {
  if (!onpbx.DOMAIN) {
    console.warn('[calls] ONPBX_DOMAIN not set — call sync disabled');
    return;
  }
  const minutes = parseInt(process.env.CALL_SYNC_INTERVAL_MIN || '5', 10);
  const lookbackH = parseInt(process.env.CALL_SYNC_LOOKBACK_HOURS || '3', 10);
  let firstRun = true;

  const run = async () => {
    try {
      if (firstRun) {
        await syncUsers().catch((e) => console.warn('[calls] pbx user sync failed:', e.message));
        const backfilled = await initialBackfillIfEmpty();
        firstRun = false;
        if (backfilled) return; // backfill already covered "recent"
      }
      await syncRecentCalls(lookbackH);
    } catch (err) {
      console.error('[calls] sync failed:', err.message);
    }
  };
  run();
  setInterval(run, minutes * 60 * 1000);
  console.log(`[calls] OnlinePBX sync every ${minutes}min, ${lookbackH}h lookback`);
}

module.exports = {
  ensurePbxTables,
  syncUsers,
  syncCallRange,
  syncRecentCalls,
  initialBackfillIfEmpty,
  startCallSync,
  upsertCall,
  upsertUser,
  nowUnix,
};
