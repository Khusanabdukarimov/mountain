#!/usr/bin/env node
'use strict';

/**
 * Manual catch-up: create Bitrix leads for Meta form submissions that never became
 * one. The server does this by itself every minute (sync/facebookLeads.js, last 6 h
 * only); this is for older gaps, e.g. after a long connector outage. Same creator,
 * same rules: a submission whose phone already has the form's lead in Bitrix is
 * linked, not duplicated.
 *
 * Usage (on the server, from bitrix-sync/):
 *   node scripts/create_leads_from_facebook.js --missing-since=<ISO+offset> --dry   # show, no writes
 *   node scripts/create_leads_from_facebook.js --missing-since=<ISO+offset>         # create
 *   node scripts/create_leads_from_facebook.js --ids=<id>,<id>,… [--dry]            # explicit Meta lead ids
 */

require('dotenv').config();
const pool = require('../src/db/pool');
const { ensureLeadForSubmission, tash } = require('../src/services/facebookLeadCreator');

const DRY = process.argv.includes('--dry');
const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const IDS = arg('ids').split(',').map(s => s.trim().replace(/^l:/, '')).filter(Boolean);
const SINCE = arg('missing-since');
if (!IDS.length && !SINCE) { console.error('--ids=<meta lead ids> or --missing-since=<ISO with offset> is required'); process.exit(1); }
if (SINCE && (isNaN(new Date(SINCE).getTime()) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(SINCE))) { console.error('--missing-since needs a date with UTC offset, e.g. 2026-10-20T15:50:00+05:00'); process.exit(1); }

const COLS = `id, form_id, full_name, phone, platform, is_organic, created_time, campaign_name, adset_name, ad_name, field_data, bitrix_lead_id`;

(async () => {
  const rows = IDS.length
    ? (await pool.query(`SELECT ${COLS} FROM facebook_leads WHERE id = ANY($1::text[]) ORDER BY created_time`, [IDS])).rows
    : (await pool.query(`SELECT ${COLS} FROM facebook_leads WHERE created_time >= $1 ORDER BY created_time`, [SINCE])).rows;
  const missing = IDS.filter(id => !rows.some(r => r.id === id));
  if (missing.length) console.log(`[create-leads] NOT FOUND in facebook_leads: ${missing.join(', ')}`);

  const count = { created: 0, dry: 0, linked: 0, skipped: 0, failed: 0 };
  for (const fl of rows) {
    const label = `${fl.id} (${tash(fl.created_time)}, ${fl.phone})`;
    const r = await ensureLeadForSubmission(fl, { dry: DRY });
    count[r.status]++;
    if (r.status === 'created' || r.status === 'dry') {
      console.log(`  ${label}: ${r.status === 'created' ? `created #${r.leadId}` : 'would create'} ${JSON.stringify(r.fields)}`);
      if (r.reason) console.log(`    NOTE ${r.reason}`);
      if (r.unmapped.length) console.log(`    ! answers with no field configured (went to COMMENTS): ${r.unmapped.join(' | ')}`);
    } else {
      console.log(`  ${label}: ${r.status.toUpperCase()} ${r.reason}`);
    }
  }
  console.log(`[create-leads] ${DRY ? '(dry) ' : ''}${rows.length} submissions: ${JSON.stringify(count)}`);
})()
  .catch(err => { console.error('[create-leads] failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
