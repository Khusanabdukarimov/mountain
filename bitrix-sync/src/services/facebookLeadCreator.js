'use strict';

// Turns a Meta lead-form submission (a facebook_leads row) into a Bitrix lead the
// way Bitrix's own lead-form connector does — title = form name, source Target,
// stage "Yangi lid", every answer in the field the portal uses for that question —
// plus the UTM tags the connector never writes. Used by sync/facebookLeads.js (the
// automatic creator) and scripts/create_leads_from_facebook.js (manual catch-up).
//
// Ownership of a submission is decided in Bitrix, not here: before creating, the
// phone is looked up among live Bitrix leads, and a lead of the same form made at /
// after the submission means the connector (or someone) already did it — that lead
// is linked and nothing is created. That is what makes the creator safe to leave
// running while the connector works, and a safety net while it does not.

const pool = require('../db/pool');
const { bitrixPost, fetchOne } = require('./bitrix');
const { upsertLead } = require('./upsertLead');

const MAIN_RESPONSIBLE_ID = parseInt(process.env.MAIN_RESPONSIBLE_ID || '1', 10);
const SOURCE_TARGET = 'UC_89FPH6';
const STATUS_NEW_LEAD = 'IN_PROCESS'; // "Yangi lid" (NEW is "Qo'ng'iroqlar")
const DUP_SLACK_MS = 10 * 60 * 1000;  // a lead made this long before the submission is not its lead
const SRC = 'facebook-lead-creator';

// Where the connector puts each answer of the "Xa Mountain / AE Logic" forms
const ANSWERS_XA = {
  'ismingiz?': 'NAME',
  "biznesdagi_ro'lingiz?": 'UF_CRM_1778491100516',                                             // Biznesingiz yo'nalishi
  'qaysi_xizmatimizdan_foydalanmoqchisiz?': 'UF_CRM_1775826286306',                           // Xizmat turi
  "siz_bilan_bog'lanishimiz_uchun_telefon_raqamingiz?": 'UF_CRM_1778261403182',               // Telefon raqamingiz
  "korxonangiz_faoliyat_turini_yozing_(_qurilish,_ta'lim__..._)": 'UF_CRM_1775824743431',     // Brend nomi
};

// Meta form id → lead title (the form name as the team calls it) + answer → field map.
// A field of null means "hidden form value, not a question". A form missing here is
// still turned into a lead (see buildFields) with its answers written to COMMENTS.
const FORMS = {
  '1757388405517976': { title: 'Xa Mountain 14.10 QL', answers: ANSWERS_XA },
  '2542155936289286': { title: 'Xa Mountain 14.10 HL', answers: ANSWERS_XA },
  '1077294011524934': { title: 'AE | New form | Logic | 19.07', answers: ANSWERS_XA },
  '1626642831644108': {
    title: 'DU - Proten - 16.10.25',
    answers: {
      'ismingiz:': 'NAME',
      'city': 'UF_CRM_1778491392559',                                 // Shahar
      'lavozimingiz:': 'UF_CRM_1791012628',                           // Lavozim
      'brendingiz_nomi:': 'UF_CRM_1775824743431',                     // Brend nomi
      'telefon_raqamingiz:': 'UF_CRM_1777533090',                     // Telefon raqamingiz
      'qaysi_xizmatimizdan_foydalanmoqchisiz?': 'UF_CRM_1778491100516',
      'utm_source': null,
    },
  },
  '1601875095315664': {
    title: 'Forma 2',
    answers: {
      'ismingiz?': 'NAME',
      'brendingiz_nomi?': 'UF_CRM_1775824743431',
      'telefon_raqamingiz?': 'UF_CRM_1778261403182',
    },
  },
};

// Meta's own contact fields: they are NAME / PHONE already, not form questions
const META_CONTACT_KEYS = new Set(['phone_number', 'full_name', 'email']);

const digits = v => String(v || '').replace(/[^0-9]/g, '');
const clean = v => (v == null ? '' : String(v).trim());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tash = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });

// Meta gives some people's numbers without the country code; Bitrix calls and phone matching need it
const e164 = v => { const d = digits(v); return d.length === 9 ? `+998${d}` : clean(v); };

// ── form names for forms that are not in FORMS ───────────────────────────────
const formNameCache = new Map();
async function fetchFormName(formId) {
  if (formNameCache.has(formId)) return formNameCache.get(formId);
  let name = null;
  const token = process.env.FB_PAGE_TOKEN || process.env.FB_ACCESS_TOKEN;
  if (token) {
    try {
      const r = await fetch(`https://graph.facebook.com/${process.env.FB_API_VERSION || 'v21.0'}/${formId}?fields=name&access_token=${encodeURIComponent(token)}`);
      name = clean((await r.json()).name) || null;
    } catch (_) { /* fall back to the id below */ }
  }
  if (name) formNameCache.set(formId, name); // a failed lookup is retried next time
  return name;
}

async function titleFor(fl) {
  if (FORMS[fl.form_id]) return FORMS[fl.form_id].title;
  return (await fetchFormName(fl.form_id)) || `Meta form ${fl.form_id}`;
}

// ── fields ───────────────────────────────────────────────────────────────────
function buildFields(fl, title) {
  const form = FORMS[fl.form_id];
  const a = fl.field_data || {};
  const fields = {
    TITLE: title,
    NAME: clean(fl.full_name) || 'Facebook Lead',
    PHONE: [{ VALUE: e164(fl.phone), VALUE_TYPE: 'OTHER' }],
    SOURCE_ID: SOURCE_TARGET,
    STATUS_ID: STATUS_NEW_LEAD,
    ASSIGNED_BY_ID: MAIN_RESPONSIBLE_ID, // the ONCRMLEAD_ADD webhook then runs the normal distribution
    UTM_SOURCE: String(fl.platform || '').toLowerCase() === 'instagram' || fl.platform === 'ig' ? 'Instagram' : 'Facebook',
    UTM_MEDIUM: fl.is_organic ? 'organic' : 'paid',
    UTM_CAMPAIGN: clean(fl.campaign_name),
    UTM_CONTENT: clean(fl.adset_name),
    UTM_TERM: clean(fl.ad_name),
  };
  const unmapped = [];
  for (const [question, answer] of Object.entries(a)) {
    if (META_CONTACT_KEYS.has(question) || !clean(answer)) continue;
    if (form && question in form.answers) {
      if (form.answers[question]) fields[form.answers[question]] = clean(answer);
    } else {
      unmapped.push(`${question}: ${clean(answer)}`);
    }
  }
  // Answers with no configured field are never dropped: they go to the comment, where the manager reads them
  if (unmapped.length) fields.COMMENTS = unmapped.join('\n');
  for (const k of Object.keys(fields)) if (fields[k] === '') delete fields[k];
  return { fields, unmapped };
}

// ── duplicates ───────────────────────────────────────────────────────────────
/** Bitrix leads (ID, DATE_CREATE, TITLE) already holding this phone. */
async function leadsWithPhone(phone) {
  const d = digits(phone);
  const variants = [...new Set([clean(phone), e164(phone), d.length >= 11 ? `+${d}` : d].filter(Boolean))];
  const dup = await bitrixPost('crm.duplicate.findbycomm', { entity_type: 'LEAD', type: 'PHONE', values: variants }, SRC);
  const ids = (dup && dup.result && dup.result.LEAD) || [];
  if (!ids.length) return [];
  await sleep(600);
  const list = await bitrixPost('crm.lead.list', { filter: { ID: ids }, select: ['ID', 'DATE_CREATE', 'TITLE'] }, SRC);
  return (list && list.result) || [];
}

/**
 * Leads on this phone created at/after the submission, split into the form's own lead
 * (`existing` — the connector got there first, however late) and anything else (`other`
 * — e.g. a lead opened by an outgoing call, which has none of the form's answers).
 * A lead already linked to a different submission is left out of both: two submissions
 * by one person each need their own lead.
 */
async function findLeadsForSubmission(fl, title) {
  const since = new Date(fl.created_time).getTime() - DUP_SLACK_MS;
  const recent = (await leadsWithPhone(fl.phone))
    .filter(l => new Date(l.DATE_CREATE).getTime() >= since)
    .sort((a, b) => new Date(a.DATE_CREATE) - new Date(b.DATE_CREATE));
  if (!recent.length) return { existing: [], other: [] };
  const { rows } = await pool.query(
    'SELECT bitrix_lead_id FROM facebook_leads WHERE bitrix_lead_id = ANY($1::int[]) AND id <> $2',
    [recent.map(l => parseInt(l.ID, 10)), fl.id]);
  const claimed = new Set(rows.map(r => String(r.bitrix_lead_id)));
  const free = recent.filter(l => !claimed.has(String(l.ID)));
  const needle = title.toLowerCase();
  const existing = free.filter(l => String(l.TITLE || '').toLowerCase().includes(needle));
  return { existing, other: free.filter(l => !existing.includes(l)) };
}

// ── create ───────────────────────────────────────────────────────────────────
/**
 * Make sure one submission has a Bitrix lead. Writes facebook_leads.bitrix_lead_id.
 * Returns { status: 'skipped' | 'linked' | 'created' | 'dry' | 'failed', leadId?, reason?, fields? }.
 */
async function ensureLeadForSubmission(fl, { dry = false } = {}) {
  if (fl.bitrix_lead_id) return { status: 'skipped', reason: `already linked to #${fl.bitrix_lead_id}` };
  if (digits(fl.phone).length < 9) return { status: 'skipped', reason: 'no usable phone number' };

  const title = await titleFor(fl);
  const { existing, other } = await findLeadsForSubmission(fl, title);
  await sleep(600);
  if (existing.length) {
    const lead = existing[0];
    if (!dry) await pool.query('UPDATE facebook_leads SET bitrix_lead_id = $1 WHERE id = $2', [lead.ID, fl.id]);
    return { status: 'linked', leadId: lead.ID, reason: `the form's lead #${lead.ID} "${lead.TITLE}" (${tash(lead.DATE_CREATE)}) already exists` };
  }

  const { fields, unmapped } = buildFields(fl, title);
  const note = other.length ? `phone also has other lead(s) ${other.map(l => `#${l.ID} "${l.TITLE}"`).join(', ')}` : '';
  if (dry) return { status: 'dry', fields, unmapped, reason: note };

  const res = await bitrixPost('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, SRC);
  if (!res || !res.result) return { status: 'failed', reason: (res && (res.error_description || res.error)) || 'no result' };
  const leadId = res.result;
  await pool.query('UPDATE facebook_leads SET bitrix_lead_id = $1 WHERE id = $2', [leadId, fl.id]);

  // Bitrix stamps DATE_CREATE itself and ignores writes to it, so the dashboard mirror
  // takes the submission time instead (reports count a lead on the day it was submitted).
  // The upsert never overwrites date_create, so this survives every later sync.
  try {
    await sleep(600);
    const raw = await fetchOne('crm.lead.get', leadId, SRC);
    if (raw) await upsertLead(raw);
    await pool.query('UPDATE leads SET date_create = $2 WHERE id = $1', [leadId, fl.created_time]);
  } catch (e) {
    console.error(`[facebook-leads] lead #${leadId}: mirror date not set:`, e.message);
  }
  return { status: 'created', leadId, fields, unmapped, reason: note };
}

module.exports = { FORMS, buildFields, titleFor, ensureLeadForSubmission, tash, sleep, clean, digits };
