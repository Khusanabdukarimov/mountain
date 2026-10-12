#!/usr/bin/env node
'use strict';

/**
 * One-off backfill for deals.utm_campaign (the deal card's own UTM_CAMPAIGN).
 *
 * The column is new: webhooks and the daily reconcile fill it going forward,
 * but deals created before it existed sit at NULL. Kunlik attributes a deal
 * that has no lead (e.g. a returning customer's new deal) to a targetolog
 * through this column, so those older deals need it filled in once.
 *
 * Only deals that cannot inherit a campaign from a lead are touched: no lead,
 * or a lead without utm_campaign.
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
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'deals' AND column_name = 'utm_campaign'`,
  );
  if (!col.rowCount) {
    console.error('deals.utm_campaign does not exist yet — start the service once so the '
      + 'startup migration adds it, then re-run this script.');
    process.exit(1);
  }

  const { rows: candidates } = await pool.query(`
    SELECT d.id FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
    WHERE d.utm_campaign IS NULL AND COALESCE(l.utm_campaign, '') = ''
      AND d.date_create >= $1::timestamp`, [SINCE]);
  const wanted = new Set(candidates.map(r => r.id));
  console.log(`[backfill] ${wanted.size} deals without a campaign${DRY ? ' (DRY RUN)' : ''}; fetching UTM_CAMPAIGN from Bitrix…`);

  const deals = await fetchAll('crm.deal.list', { '>=DATE_CREATE': SINCE }, ['ID', 'UTM_CAMPAIGN'], 'backfill-deal-utm');
  console.log(`[backfill] ${deals.length} deals returned`);

  let withValue = 0, updated = 0;
  for (const d of deals) {
    const id = parseInt(d.ID, 10);
    if (!d.UTM_CAMPAIGN || !wanted.has(id)) continue;
    withValue++;
    console.log(`  deal ${id} → ${d.UTM_CAMPAIGN}`);
    if (DRY) continue;
    const r = await pool.query(
      'UPDATE deals SET utm_campaign = $2 WHERE id = $1 AND utm_campaign IS NULL',
      [id, d.UTM_CAMPAIGN],
    );
    updated += r.rowCount;
  }

  console.log(`[backfill] ${withValue} deals carry a campaign; ${DRY ? 0 : updated} rows updated`);
})()
  .catch(err => { console.error('[backfill] failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
