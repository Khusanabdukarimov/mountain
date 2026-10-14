#!/usr/bin/env node
'use strict';

/**
 * One-off: create Bitrix leads for Meta form submissions that never became a
 * Bitrix lead.
 *
 * The forms "XA - Mountain 14.10 - QL / HL" went live early on 14.10, but the
 * Bitrix lead-form connector for them was only switched on at ~09:48 (Tashkent):
 * its first leads are the two test leads #43726 / #43728. Submissions before
 * that exist only in facebook_leads (pulled from Meta), so nobody called those
 * people. This creates them the way the connector would have:
 *   - TITLE   = the form name, SOURCE_ID = Target, STATUS_ID = IN_PROCESS ("Yangi lid")
 *   - NAME / PHONE / the four form-answer fields, mapped as in the connector's
 *     own leads (checked on its test leads #43726 / #43728 and lead #43722)
 *   - UTM campaign / adset / ad from Meta (the connector writes none)
 *   - ASSIGNED_BY_ID = MAIN_RESPONSIBLE_ID, so the ONCRMLEAD_ADD webhook runs the
 *     normal distribution (same convention as sheetLeads.js)
 * Selection is by explicit Meta lead id, never "all unlinked", so re-running it
 * later cannot duplicate leads the connector now creates by itself. A submission
 * that already has facebook_leads.bitrix_lead_id is skipped.
 *
 * Usage (on the server, from bitrix-sync/):
 *   node scripts/create_leads_from_facebook.js --ids=<id>,<id>,… --dry   # show, no writes
 *   node scripts/create_leads_from_facebook.js --ids=<id>,<id>,…         # create
 */

require('dotenv').config();
const pool = require('../src/db/pool');
const { bitrixPost } = require('../src/services/bitrix');

const DRY = process.argv.includes('--dry');
const IDS = ((process.argv.find(a => a.startsWith('--ids=')) || '').slice(6)).split(',').map(s => s.trim().replace(/^l:/, '')).filter(Boolean);
if (!IDS.length) { console.error('--ids=<meta lead ids> is required'); process.exit(1); }

// Meta form id → lead title (the form name as the team calls it)
const FORM_TITLES = {
  '1757388405517976': 'Xa Mountain 14.10 QL',
  '2542155936289286': 'Xa Mountain 14.10 HL',
};

const MAIN_RESPONSIBLE_ID = parseInt(process.env.MAIN_RESPONSIBLE_ID || '1', 10);
const SOURCE_TARGET = 'UC_89FPH6';
const STATUS_NEW_LEAD = 'IN_PROCESS'; // "Yangi lid" (NEW is "Qo'ng'iroqlar")

const digits = v => String(v || '').replace(/[^0-9]/g, '');
const clean = v => (v == null ? '' : String(v).trim());

function buildFields(fl) {
  const a = fl.field_data || {};
  const fields = {
    TITLE: FORM_TITLES[fl.form_id],
    NAME: clean(a['ismingiz?']) || clean(fl.full_name) || 'Facebook Lead',
    PHONE: [{ VALUE: clean(fl.phone), VALUE_TYPE: 'OTHER' }],
    SOURCE_ID: SOURCE_TARGET,
    STATUS_ID: STATUS_NEW_LEAD,
    ASSIGNED_BY_ID: MAIN_RESPONSIBLE_ID,
    UTM_SOURCE: String(fl.platform || '').toLowerCase() === 'instagram' || fl.platform === 'ig' ? 'Instagram' : 'Facebook',
    UTM_MEDIUM: fl.is_organic ? 'organic' : 'paid',
    UTM_CAMPAIGN: clean(fl.campaign_name),
    UTM_CONTENT: clean(fl.adset_name),
    UTM_TERM: clean(fl.ad_name),
    // form answers → the fields the connector fills for these forms
    UF_CRM_1775824743431: clean(a["korxonangiz_faoliyat_turini_yozing_(_qurilish,_ta'lim__..._)"]), // Brend nomi
    UF_CRM_1775826286306: clean(a['qaysi_xizmatimizdan_foydalanmoqchisiz?']),                         // Xizmat turi
    UF_CRM_1778491100516: clean(a["biznesdagi_ro'lingiz?"]),                                          // Biznesingiz yo'nalishi
  };
  // The answered contact number goes to "Telefon raqamingiz" only when it is a
  // different number: a portal automation copies that field into PHONE, so an
  // identical one would show the same number twice on the card (see sheetLeads.js).
  const alt = clean(a["siz_bilan_bog'lanishimiz_uchun_telefon_raqamingiz?"]);
  if (alt && digits(alt).slice(-9) !== digits(fl.phone).slice(-9)) fields.UF_CRM_1778261403182 = alt;
  for (const k of Object.keys(fields)) if (fields[k] === '') delete fields[k];
  return fields;
}

(async () => {
  const { rows } = await pool.query(
    `SELECT id, form_id, full_name, phone, platform, is_organic, created_time, campaign_name, adset_name, ad_name, field_data, bitrix_lead_id
       FROM facebook_leads WHERE id = ANY($1::text[]) ORDER BY created_time`, [IDS]);
  const missing = IDS.filter(id => !rows.some(r => r.id === id));
  if (missing.length) console.log(`[create-leads] NOT FOUND in facebook_leads: ${missing.join(', ')}`);

  let created = 0;
  for (const fl of rows) {
    const when = new Date(fl.created_time).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
    if (!FORM_TITLES[fl.form_id]) { console.log(`  ${fl.id}: SKIP form ${fl.form_id} has no title configured`); continue; }
    if (fl.bitrix_lead_id) { console.log(`  ${fl.id}: SKIP already linked to Bitrix lead #${fl.bitrix_lead_id}`); continue; }
    const fields = buildFields(fl);
    console.log(`  ${fl.id} (${when}): ${JSON.stringify(fields)}`);
    if (DRY) continue;

    const res = await bitrixPost('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, 'create-leads-from-facebook');
    if (!res || !res.result) { console.log(`  ${fl.id}: FAIL ${res && (res.error_description || res.error)}`); continue; }
    await pool.query('UPDATE facebook_leads SET bitrix_lead_id = $1 WHERE id = $2', [res.result, fl.id]);
    console.log(`  ${fl.id}: created Bitrix lead #${res.result}`);
    created++;
    await new Promise(r => setTimeout(r, 600)); // Bitrix: 2 requests/sec
  }
  console.log(`[create-leads] ${DRY ? '(dry) ' : ''}${DRY ? rows.length : created} of ${IDS.length} requested`);
})()
  .catch(err => { console.error('[create-leads] failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
