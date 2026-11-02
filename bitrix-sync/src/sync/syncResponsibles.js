const pool = require('../db/pool');
const { fetchAll } = require('../services/bitrix');

/**
 * Mirror the Bitrix user directory into `responsibles`.
 *
 * Every filter dropdown in the dashboard reads `FROM responsibles WHERE active
 * = TRUE` (responsibles-list, lead-filter-options, deal-filter-options,
 * taqsimot), so anyone absent from this table is invisible in EVERY section at
 * once. Until now the table was only ever written by initialSync.js — a
 * run-once script — so staff hired after the last manual sync never appeared.
 *
 * Only the identity columns are touched. taqsimot_pct and photo_url are
 * deliberately left alone: they are set from the dashboard, not from Bitrix,
 * and a re-sync must never reset a distribution percentage.
 */
async function syncResponsibles() {
  const users = await fetchAll('user.get', { ACTIVE: 'Y' }, [], 'sync-responsibles');
  if (!users.length) {
    console.warn('[sync-responsibles] Bitrix returned 0 users — skipping (refusing to touch the roster)');
    return 0;
  }

  const before = new Set(
    (await pool.query('SELECT id FROM responsibles')).rows.map((r) => String(r.id)),
  );
  const added = [];

  for (const u of users) {
    const id = parseInt(u.ID, 10);
    if (!id) continue;
    await pool.query(
      `INSERT INTO responsibles (id, name, last_name, email, work_position, active, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name          = EXCLUDED.name,
         last_name     = EXCLUDED.last_name,
         email         = EXCLUDED.email,
         work_position = EXCLUDED.work_position,
         active        = EXCLUDED.active,
         synced_at     = NOW()`,
      [id, u.NAME || null, u.LAST_NAME || null, u.EMAIL || null,
       u.WORK_POSITION || null, u.ACTIVE === 'Y' || u.ACTIVE === true],
    );
    if (!before.has(String(id))) added.push(`${id} ${`${u.NAME || ''} ${u.LAST_NAME || ''}`.trim()}`);
  }

  // Every 10 min now — only log when the roster actually grew.
  if (added.length) console.log(`[sync-responsibles] ${users.length} Bitrix users upserted; NEW: ${added.join(', ')}`);
  return users.length;
}

// The whole directory is one user.get page (~33 users), so polling is cheap.
// It used to run once a day at 01:30, which left a new hire missing from every
// dropdown until the next night.
const USER_SYNC_INTERVAL_MS = 10 * 60 * 1000;

function scheduleUserSync() {
  // Catch new staff shortly after a deploy without waiting a full interval.
  setTimeout(() => { syncResponsibles().catch(() => {}); }, 60_000);
  setInterval(() => syncResponsibles().catch(() => {}), USER_SYNC_INTERVAL_MS);

  console.log(`[sync-responsibles] user sync scheduled every ${USER_SYNC_INTERVAL_MS / 60000} min`);
}

module.exports = { syncResponsibles, scheduleUserSync };
