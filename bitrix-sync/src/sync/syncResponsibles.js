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

  console.log(`[sync-responsibles] ${users.length} Bitrix users upserted`
    + (added.length ? `; NEW: ${added.join(', ')}` : '; no new staff'));
  return users.length;
}

// ms until the next 01:30 Asia/Tashkent (UTC+5, no DST). Offset from the 01:00
// lead reconcile so the two jobs don't hit Bitrix at the same moment.
function msUntilNext0130() {
  const nowShifted = new Date(Date.now() + 5 * 3600 * 1000);
  const next = new Date(nowShifted);
  next.setUTCHours(1, 30, 0, 0);
  if (next <= nowShifted) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - nowShifted.getTime();
}

function scheduleDailyUserSync() {
  // Catch new staff shortly after a deploy without waiting for 01:30.
  setTimeout(() => { syncResponsibles().catch(() => {}); }, 60_000);

  setTimeout(() => {
    syncResponsibles().catch(() => {});
    setInterval(() => syncResponsibles().catch(() => {}), 24 * 3600 * 1000);
  }, msUntilNext0130());

  console.log('[sync-responsibles] daily user sync scheduled at 01:30 Tashkent'
    + ` (next in ${Math.round(msUntilNext0130() / 60000)} min)`);
}

module.exports = { syncResponsibles, scheduleDailyUserSync };
