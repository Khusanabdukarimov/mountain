#!/usr/bin/env node
'use strict';

/**
 * One-off backfill for deals.uf_kelishuv_date (UF_CRM_1779450350 —
 * "Kelishuv bo'lidi (sotuv) tushgan vaqti").
 *
 * The daily reconcile only re-syncs deals modified in the last few days, so
 * after the column is added every older deal would sit at NULL and the
 * "Kelishuv bo'ldi" column in Sdelka va Konversiya would under-report. This
 * walks every deal once and fills the value in.
 *
 * Usage (on the server, from bitrix-sync/):
 *   node scripts/backfill_kelishuv_date.js          # apply
 *   node scripts/backfill_kelishuv_date.js --dry    # report only, no writes
 */

require('dotenv').config();
const pool = require('../src/db/pool');
const { fetchAll } = require('../src/services/bitrix');

const FIELD = 'UF_CRM_1779450350';
const DRY = process.argv.includes('--dry');

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

(async () => {
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'deals' AND column_name = 'uf_kelishuv_date'`,
  );
  if (!col.rowCount) {
    console.error('deals.uf_kelishuv_date does not exist yet — start the service once so the '
      + 'startup migration adds it, then re-run this script.');
    process.exit(1);
  }

  console.log(`[backfill] fetching deals with ${FIELD}${DRY ? ' (DRY RUN)' : ''}…`);
  const deals = await fetchAll('crm.deal.list', {}, ['ID', FIELD], 'backfill-kelishuv');
  console.log(`[backfill] ${deals.length} deals returned`);

  let withValue = 0, updated = 0;
  for (const d of deals) {
    const when = parseDate(d[FIELD]);
    if (!when) continue;
    withValue++;
    if (DRY) continue;
    const r = await pool.query(
      `UPDATE deals SET uf_kelishuv_date = $2
        WHERE id = $1 AND uf_kelishuv_date IS DISTINCT FROM $2`,
      [parseInt(d.ID, 10), when],
    );
    updated += r.rowCount;
  }

  console.log(`[backfill] ${withValue} deals carry the field; ${DRY ? 0 : updated} rows updated`);
  await pool.end();
})().catch((e) => { console.error('[backfill] failed:', e.message); process.exit(1); });
