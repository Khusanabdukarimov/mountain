#!/usr/bin/env node
'use strict';

/**
 * One-off backfill of the UTM tags of Target leads Bitrix created with an empty
 * UTM_CAMPAIGN.
 *
 * Bitrix's native lead-form connector creates the lead seconds after the Meta
 * form submission but writes no campaign tags; a Bitrix automation fills them
 * for most leads and misses the rest, and our own Meta webhook (which used to
 * patch them) no longer reaches the server. Those leads then fall out of every
 * UTM-based report. The submission that created a lead is in facebook_leads
 * with the same phone, so the tags are recovered from it.
 *
 * Matching rule — deliberately strict:
 *   - the lead is source Target, with an empty utm_campaign;
 *   - a Meta submission with the same phone exists within WINDOW_SEC of the
 *     lead's creation (the one that created it); the closest one wins;
 *   - if submissions of two different campaigns fall inside the window the lead
 *     is skipped as ambiguous;
 *   - Bitrix is re-read right before writing, and only fields that are empty
 *     THERE are filled — an existing value is never overwritten.
 *
 * Write order: the mirror row first, then Bitrix. Bitrix answers with an
 * ONCRMLEAD_UPDATE webhook; leadUpdated re-distributes a lead when its UTM
 * changes to an active campaign, and for an old lead that would hand work in
 * progress to another operator. With the mirror already holding the new value
 * the webhook sees no change and leaves the assignment alone. If the Bitrix
 * write fails, the mirror is restored.
 *
 * Usage (on the server, from bitrix-sync/):
 *   node scripts/backfill_lead_utm_from_facebook.js --dry      # report only, no writes
 *   node scripts/backfill_lead_utm_from_facebook.js            # apply
 *   options: --since=YYYY-MM-DD (default 2026-09-01)
 */

require('dotenv').config();
const pool = require('../src/db/pool');
const { fetchOne, bitrixPost } = require('../src/services/bitrix');

const DRY = process.argv.includes('--dry');
const SINCE = (process.argv.find(a => a.startsWith('--since=')) || '').slice(8) || '2026-09-01';
const WINDOW_SEC = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const empty = v => v == null || String(v).trim() === '';

(async () => {
  const { rows } = await pool.query(`
    SELECT l.id, l.date_create, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
           fl.campaign_name, fl.adset_name, fl.ad_name, fl.platform, fl.is_organic, fl.created_time,
           ABS(EXTRACT(EPOCH FROM (fl.created_time - l.date_create)))::int AS gap
    FROM leads l
    JOIN lead_phones lp ON lp.lead_id = l.id AND lp.phone_norm <> ''
    JOIN facebook_leads fl ON fl.phone_norm = lp.phone_norm AND fl.campaign_name IS NOT NULL
     AND ABS(EXTRACT(EPOCH FROM (fl.created_time - l.date_create))) <= $2
    WHERE l.source_id = 'UC_89FPH6' AND COALESCE(l.utm_campaign, '') = '' AND l.date_create >= $1::timestamp
    ORDER BY l.id, gap`, [SINCE, WINDOW_SEC]);

  const { rows: allEmpty } = await pool.query(
    `SELECT count(*)::int AS n FROM leads WHERE source_id = 'UC_89FPH6' AND COALESCE(utm_campaign, '') = '' AND date_create >= $1::timestamp`, [SINCE]);
  const { rows: active } = await pool.query('SELECT campaign_name FROM taqsimot_campaign_settings WHERE active = TRUE');
  const activeNames = new Set(active.map(r => r.campaign_name));

  const byLead = new Map();
  for (const r of rows) {
    if (!byLead.has(r.id)) byLead.set(r.id, []);
    byLead.get(r.id).push(r);
  }

  const stats = { emptyLeads: allEmpty[0].n, noMatch: allEmpty[0].n - byLead.size, ambiguous: 0, alreadyFilled: 0, updated: 0, failed: 0 };
  console.log(`[utm-backfill] ${DRY ? 'DRY RUN — ' : ''}${stats.emptyLeads} empty-UTM Target leads since ${SINCE}; `
    + `${byLead.size} have a same-phone Meta submission within ${WINDOW_SEC / 60} min, ${stats.noMatch} have none`);

  for (const [id, subs] of byLead) {
    const best = subs[0];
    const campaigns = new Set(subs.map(s => s.campaign_name));
    if (campaigns.size > 1) {
      stats.ambiguous++;
      console.log(`  lead ${id}: SKIP ambiguous — ${[...campaigns].join('  /  ')}`);
      continue;
    }

    // Re-read Bitrix: the mirror may be stale, and an existing tag must stay.
    let bx;
    try { bx = await fetchOne('crm.lead.get', id, 'backfill-lead-utm'); } catch (e) { bx = null; }
    await sleep(600);
    if (!bx) { stats.failed++; console.log(`  lead ${id}: FAIL could not read lead from Bitrix`); continue; }
    if (!empty(bx.UTM_CAMPAIGN)) {
      stats.alreadyFilled++;
      console.log(`  lead ${id}: SKIP already has UTM_CAMPAIGN in Bitrix (${bx.UTM_CAMPAIGN}) — mirror is stale`);
      continue;
    }

    const fields = { UTM_CAMPAIGN: best.campaign_name };
    if (empty(bx.UTM_CONTENT) && best.adset_name) fields.UTM_CONTENT = best.adset_name;
    if (empty(bx.UTM_TERM) && best.ad_name) fields.UTM_TERM = best.ad_name;
    if (empty(bx.UTM_SOURCE)) fields.UTM_SOURCE = String(best.platform || '').toLowerCase() === 'instagram' ? 'Instagram' : 'Facebook';
    if (empty(bx.UTM_MEDIUM)) fields.UTM_MEDIUM = best.is_organic ? 'organic' : 'paid';

    const note = `${activeNames.has(best.campaign_name) ? ' [active taqsimot campaign]' : ''}`;
    console.log(`  lead ${id} (${new Date(best.date_create).toISOString().slice(0, 10)}, submission ${best.gap}s apart): `
      + `${best.campaign_name} | ${best.adset_name || '-'} | ${best.ad_name || '-'}${note}`);
    if (DRY) continue;

    // Mirror first (see header), remembering what to restore.
    const prev = { source: best.utm_source, medium: best.utm_medium, campaign: best.utm_campaign, content: best.utm_content, term: best.utm_term };
    await pool.query(
      `UPDATE leads SET utm_campaign = $2,
              utm_content = CASE WHEN COALESCE(utm_content, '') = '' THEN $3 ELSE utm_content END,
              utm_term    = CASE WHEN COALESCE(utm_term, '') = ''    THEN $4 ELSE utm_term END,
              utm_source  = CASE WHEN COALESCE(utm_source, '') = ''  THEN $5 ELSE utm_source END,
              utm_medium  = CASE WHEN COALESCE(utm_medium, '') = ''  THEN $6 ELSE utm_medium END
        WHERE id = $1`,
      [id, fields.UTM_CAMPAIGN, fields.UTM_CONTENT || null, fields.UTM_TERM || null, fields.UTM_SOURCE || null, fields.UTM_MEDIUM || null]);

    let ok = false;
    try { const res = await bitrixPost('crm.lead.update', { id, fields }, 'backfill-lead-utm'); ok = !!(res && res.result); } catch (e) { ok = false; }
    await sleep(600);
    if (ok) { stats.updated++; continue; }

    stats.failed++;
    await pool.query(
      'UPDATE leads SET utm_source = $2, utm_medium = $3, utm_campaign = $4, utm_content = $5, utm_term = $6 WHERE id = $1',
      [id, prev.source, prev.medium, prev.campaign, prev.content, prev.term]);
    console.log(`  lead ${id}: FAIL Bitrix update rejected — mirror restored`);
  }

  console.log(`[utm-backfill] ${DRY ? '(dry) ' : ''}empty-UTM leads: ${stats.emptyLeads} | no Meta match: ${stats.noMatch} | ambiguous: ${stats.ambiguous} | `
    + `already filled in Bitrix: ${stats.alreadyFilled} | ${DRY ? 'would update' : 'updated'}: ${DRY ? byLead.size - stats.ambiguous - stats.alreadyFilled - stats.failed : stats.updated} | failed: ${stats.failed}`);
})()
  .catch(err => { console.error('[utm-backfill] failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
