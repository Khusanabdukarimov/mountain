#!/usr/bin/env node
'use strict';

/**
 * Set the UTM tags of Target leads from what Meta itself says about the form submission
 * that created them — read straight from the Graph API, not from our copy of it.
 *
 * Bitrix's lead-form connector writes UTM_SOURCE "Facebook" for every lead and no campaign
 * at all, so Instagram leads are mislabelled and campaign reports lose the lead. For each
 * lead (selected by --title and --since) the submission is the same-phone one made within
 * WINDOW_SEC of the lead's creation (the closest wins), and then:
 *   UTM_SOURCE   Instagram if Meta says platform ig, Facebook if fb (unknown: left alone)
 *   UTM_MEDIUM   organic / paid (is_organic)
 *   UTM_CAMPAIGN campaign_name   UTM_CONTENT adset_name   UTM_TERM ad_name
 * A tag is written only when it differs from Bitrix's current value (re-read right before the
 * write); the mirror row is updated first, like backfill_lead_utm_from_facebook.js, so the
 * ONCRMLEAD_UPDATE echo changes nothing else. Assignment and stage are never touched.
 *
 * Usage (on the server, from bitrix-sync/):
 *   node scripts/fix_lead_utm_from_meta.js --title="Obsess form 02.11" --since=2026-11-02 --dry
 *   node scripts/fix_lead_utm_from_meta.js --title="Obsess form 02.11" --since=2026-11-02
 */

require('dotenv').config();
const pool = require('../src/db/pool');
const { fetchOne, bitrixPost } = require('../src/services/bitrix');
const { extractFields } = require('../src/services/facebook');
const { resolvePhone } = require('../src/services/resolvePhone');

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const DRY = process.argv.includes('--dry');
const TITLE = arg('title');
const SINCE = arg('since');
if (!TITLE || !SINCE) { console.error('--title=<text in the lead title> and --since=YYYY-MM-DD are required'); process.exit(1); }

const WINDOW_SEC = 600;
const BASE = `https://graph.facebook.com/${process.env.FB_API_VERSION || 'v21.0'}`;
const TOKENS = [process.env.META_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN, process.env.FB_PAGE_TOKEN].filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const last9 = v => String(v || '').replace(/[^0-9]/g, '').slice(-9);
const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();

async function graph(url, params = {}) {
  for (const t of TOKENS) {
    const u = new URL(url.startsWith('http') ? url : BASE + url);
    for (const [k, v] of Object.entries({ ...params, access_token: t })) u.searchParams.set(k, v);
    const j = await (await fetch(u)).json();
    if (!j.error) return j;
  }
  return null;
}

/** Every submission of a form since `sinceTs` (unix), straight from Meta. */
async function metaSubmissions(formId, sinceTs) {
  const out = [];
  let page = await graph(`/${formId}/leads`, {
    fields: 'id,created_time,campaign_id,campaign_name,adset_name,ad_name,platform,is_organic,field_data', limit: 100,
    filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceTs }]),
  });
  while (page) {
    out.push(...(page.data || []));
    page = page.paging && page.paging.next ? await graph(page.paging.next) : null;
  }
  return out;
}

const sourceOf = platform => {
  const p = String(platform || '').toLowerCase();
  if (p === 'ig' || p === 'instagram') return 'Instagram';
  if (p === 'fb' || p === 'facebook') return 'Facebook';
  return null;
};

(async () => {
  const { rows: leads } = await pool.query(
    `SELECT l.id, l.date_create, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
            (SELECT array_agg(DISTINCT lp.phone_norm) FROM lead_phones lp WHERE lp.lead_id = l.id AND lp.phone_norm <> '') AS phones
       FROM leads l
      WHERE l.source_id = 'UC_89FPH6' AND l.title ILIKE '%' || $1 || '%' AND l.date_create >= $2::timestamp
      ORDER BY l.id`, [TITLE, SINCE]);
  console.log(`[fix-utm] ${DRY ? 'DRY RUN — ' : ''}${leads.length} Target leads with "${TITLE}" in the title since ${SINCE}`);

  // the forms to ask Meta about: the ones these people's submissions are in
  const phones = [...new Set(leads.flatMap(l => l.phones || []))];
  const { rows: forms } = await pool.query(
    `SELECT DISTINCT form_id FROM facebook_leads WHERE phone_norm = ANY($1::text[]) AND created_time >= $2::timestamp - interval '2 days'`, [phones, SINCE]);
  const sinceTs = Math.floor(new Date(`${SINCE}T00:00:00+05:00`).getTime() / 1000) - 86400;
  const subs = [];
  for (const f of forms) {
    const got = await metaSubmissions(f.form_id, sinceTs);
    if (!got.length) console.log(`  form ${f.form_id}: nothing returned by Meta`);
    for (const s of got) subs.push({ ...s, form_id: f.form_id, phone9: last9(resolvePhone(extractFields(s.field_data))), at: new Date(s.created_time).getTime() });
  }
  const bySource = {};
  for (const s of subs) { const k = s.platform || '(none)'; bySource[k] = (bySource[k] || 0) + 1; }
  console.log(`[fix-utm] Meta returned ${subs.length} submissions from ${forms.length} form(s); platform: ${JSON.stringify(bySource)}`);

  const stats = { matched: 0, noMeta: 0, unchanged: 0, wouldChange: 0, updated: 0, failed: 0, instagram: 0, facebook: 0, sourceFixed: 0 };
  for (const l of leads) {
    const created = new Date(l.date_create).getTime();
    const cands = subs.filter(s => (l.phones || []).includes(s.phone9) && Math.abs(s.at - created) <= WINDOW_SEC * 1000)
      .sort((a, b) => Math.abs(a.at - created) - Math.abs(b.at - created));
    if (!cands.length) { stats.noMeta++; console.log(`  lead ${l.id}: no Meta submission found (same phone, +-${WINDOW_SEC / 60} min) — left alone`); continue; }
    const m = cands[0];
    if (new Set(cands.map(c => c.campaign_name)).size > 1) { console.log(`  lead ${l.id}: SKIP ambiguous campaigns`); continue; }
    stats.matched++;
    const want = {
      UTM_SOURCE: sourceOf(m.platform), UTM_MEDIUM: m.is_organic ? 'organic' : 'paid',
      UTM_CAMPAIGN: m.campaign_name || null, UTM_CONTENT: m.adset_name || null, UTM_TERM: m.ad_name || null,
    };
    if (want.UTM_SOURCE === 'Instagram') stats.instagram++; else if (want.UTM_SOURCE === 'Facebook') stats.facebook++;

    let bx;
    try { bx = await fetchOne('crm.lead.get', l.id, 'fix-lead-utm'); } catch (e) { bx = null; }
    await sleep(600);
    if (!bx) { stats.failed++; console.log(`  lead ${l.id}: FAIL could not read the lead from Bitrix`); continue; }

    const fields = {};
    for (const [k, v] of Object.entries(want)) if (v && !same(bx[k], v)) fields[k] = v;
    if (!Object.keys(fields).length) { stats.unchanged++; continue; }
    stats.wouldChange++;
    if (fields.UTM_SOURCE) stats.sourceFixed++;
    console.log(`  lead ${l.id} (meta ${m.platform || '?'} ${m.id}): ` + Object.entries(fields).map(([k, v]) => `${k.replace('UTM_', '').toLowerCase()} "${bx[k] || ''}" -> "${v}"`).join(' | '));
    if (DRY) continue;

    const prev = { source: l.utm_source, medium: l.utm_medium, campaign: l.utm_campaign, content: l.utm_content, term: l.utm_term };
    await pool.query(
      `UPDATE leads SET utm_source = COALESCE($2, utm_source), utm_medium = COALESCE($3, utm_medium), utm_campaign = COALESCE($4, utm_campaign),
                        utm_content = COALESCE($5, utm_content), utm_term = COALESCE($6, utm_term) WHERE id = $1`,
      [l.id, fields.UTM_SOURCE || null, fields.UTM_MEDIUM || null, fields.UTM_CAMPAIGN || null, fields.UTM_CONTENT || null, fields.UTM_TERM || null]);
    let ok = false;
    try { const res = await bitrixPost('crm.lead.update', { id: l.id, fields }, 'fix-lead-utm'); ok = !!(res && res.result); } catch (e) { ok = false; }
    await sleep(600);
    if (ok) { stats.updated++; continue; }
    stats.failed++;
    await pool.query('UPDATE leads SET utm_source = $2, utm_medium = $3, utm_campaign = $4, utm_content = $5, utm_term = $6 WHERE id = $1',
      [l.id, prev.source, prev.medium, prev.campaign, prev.content, prev.term]);
    console.log(`  lead ${l.id}: FAIL Bitrix update rejected — mirror restored`);
  }
  console.log(`[fix-utm] ${DRY ? '(dry) ' : ''}leads ${leads.length} | matched to a Meta submission ${stats.matched} (Instagram ${stats.instagram}, Facebook ${stats.facebook}) | `
    + `already correct ${stats.unchanged} | ${DRY ? 'would change' : 'changed'} ${DRY ? stats.wouldChange : stats.updated} (of which utm_source ${stats.sourceFixed}) | no Meta submission ${stats.noMeta} | failed ${stats.failed}`);
})()
  .catch(err => { console.error('[fix-utm] failed:', err.stack || err.message); process.exitCode = 1; })
  .finally(() => pool.end());
