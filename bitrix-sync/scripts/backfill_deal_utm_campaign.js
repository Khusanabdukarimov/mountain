#!/usr/bin/env node
'use strict';

/**
 * One-off backfill for deals.utm_campaign / deals.utm_content (the deal card's
 * own UTM_CAMPAIGN and UTM_CONTENT — the campaign and the adset name).
 *
 * The columns are new: webhooks and the daily reconcile fill them going
 * forward, but deals created before they existed sit at NULL. Kunlik,
 * Kampaniyalar and Creative attribute a deal that has no lead (e.g. a
 * returning customer's new deal) through these columns, so those older deals
 * need them filled in once.
 *
 * Only deals that cannot inherit a campaign from a lead are touched: no lead,
 * or a lead without utm_campaign. Existing values are never overwritten.
 *
 * Usage (on the server, from bitrix-sync/):
 *   node scripts/backfill_deal_utm_campaign.js          # apply
 *   node scripts/backfill_deal_utm_campaign.js --dry    # report only, no writes
 */

require('dotenv').config();
const pool = require('../src/db/pool');
const { fetchAll } = require('../src/services/bitrix');

const DRY = process.argv.includes('--dry');
// First lead-less Target deal in the mirror is from June; nothing older matters.
const SINCE = '2026-06-01T00:00:00';

(async () => {
  const col = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'deals' AND column_name IN ('utm_campaign', 'utm_content')`,
  );
  if (col.rows[0].n !== 2) {
    console.error('deals.utm_campaign / utm_content do not exist yet — start the service once so the '
      + 'startup migration adds them, then re-run this script.');
    process.exit(1);
  }

  const { rows: candidates } = await pool.query(`
    SELECT d.id FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
    WHERE (d.utm_campaign IS NULL OR d.utm_content IS NULL) AND COALESCE(l.utm_campaign, '') = ''
      AND d.date_create >= $1::timestamp`, [SINCE]);
  const wanted = new Set(candidates.map(r => r.id));
  console.log(`[backfill] ${wanted.size} deals missing campaign or adset${DRY ? ' (DRY RUN)' : ''}; fetching UTM from Bitrix…`);

  const deals = await fetchAll('crm.deal.list', { '>=DATE_CREATE': SINCE }, ['ID', 'UTM_CAMPAIGN', 'UTM_CONTENT'], 'backfill-deal-utm');
  console.log(`[backfill] ${deals.length} deals returned`);

  let withValue = 0, updated = 0;
  for (const d of deals) {
    const id = parseInt(d.ID, 10);
    if (!d.UTM_CAMPAIGN || !wanted.has(id)) continue;
    withValue++;
    console.log(`  deal ${id} → ${d.UTM_CAMPAIGN} | ${d.UTM_CONTENT || '(no adset)'}`);
    if (DRY) continue;
    const r = await pool.query(
      `UPDATE deals SET utm_campaign = COALESCE(utm_campaign, $2), utm_content = COALESCE(utm_content, $3)
        WHERE id = $1 AND (utm_campaign IS NULL OR utm_content IS NULL)`,
      [id, d.UTM_CAMPAIGN, d.UTM_CONTENT || null],
    );
    updated += r.rowCount;
  }

  console.log(`[backfill] ${withValue} deals carry a campaign; ${DRY ? 0 : updated} rows updated`);
})()
  .catch(err => { console.error('[backfill] failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
