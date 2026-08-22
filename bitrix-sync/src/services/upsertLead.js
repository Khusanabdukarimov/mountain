const pool = require('../db/pool');
const stageResolver = require('./stageResolver');

const CANCEL_REASON_MAP = {
  '1062': "Qimmatlik qildi",
  '1064': "Umuman puli yo'q",
  '1068': "Boshqalardan sotib oldi",
  '1490': "Biznes egasi emas",
  '1492': "Maqul kelmadi",
  '1494': "Nomi patentdan o'tmaydi",
  '1496': "Qadriyatimizga to'g'ri kelmadi",
  '1498': "Sheriklarga maqul kelmadi",
  '1500': "2 xafta ichida umuman javob berishmadi",
  '1502': "Hamkorlik bo'yicha ish boshlandi",
  '1504': "Faoliyat to'xtatildi",
  '1506': "Kerak emas",
};

const JUNK_REASON_MAP = {
  '1126': "Raqam mavjud emas",
  '1128': "Ariza qoldirmagan",
  '1130': "5 marotaba javob bermadi",
  '1132': "Dublikat",
  '1134': "Test",
  '1136': "Gaplashmasdan boshqa joyga bordi",
  '1138': "Umuman boshqa narsani so'radi",
  '2716': "Qimmatlik qildi",
  '2948': "Biznes egasi emas",
  '2950': "Nomi patentdan o'tmaydi",
  '2952': "Noto'g'ri kontakt",
  '2954': "Faoliyat to'xtatildi",
  '2956': "Adashib tushibdi",
  '2958': "Bizda yo'q xizmat bo'yicha murojaat qilishdi",
  '3068': "Kerak emas",
};

const AMOCRM_SEGMENT_MAP = {
  '1786': "Instagram",
  '1788': "Networking",
  '1790': "Qayta sotuv (LTV)",
  '1792': "Sovuq qo'ng'iroq",
  '1794': "Target",
  '1796': "Tavsiya orqali (NPS)",
  '1798': "Veb sayt",
};

function ufVal(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.length ? String(raw[0]) : null;
  return String(raw);
}

function ufEnum(raw, map) {
  const v = ufVal(raw);
  if (!v) return null;
  return map[v] || null;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Upsert a single lead from Bitrix24 raw data.
 * Returns the leads.id.
 */
// ISO datetime pattern: 2026-06-04T11:42:09Z (or with offset)
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function upsertLead(r, client) {
  const db = client || pool;

  const stageId = await stageResolver.resolve('lead', r.STATUS_ID);
  const responsibleId = r.ASSIGNED_BY_ID ? parseInt(r.ASSIGNED_BY_ID) : null;

  // For Website leads: use COMMENTS field as date_create if it's a valid ISO datetime
  let dateCreate = parseDate(r.DATE_CREATE);
  const isWebsite = (r.TITLE || '').trim().toLowerCase() === 'website';
  if (isWebsite) {
    const comment = (r.COMMENTS || '').trim();
    if (ISO_DATE_RE.test(comment)) {
      dateCreate = parseDate(comment);
    }
  }

  // Bitrix24 manba IDlari
  const SOURCE_FB     = 'UC_O9BLGT';
  const SOURCE_IG     = 'UC_3O8GTF';
  const SOURCE_TARGET = 'UC_89FPH6'; // Target (Facebook + Instagram Lead Ads)

  // Normalizatsiyadan oldin original qiymatlarni saqlaymiz (Bitrix24 sync uchun)
  const originalSourceId  = r.SOURCE_ID  || null;
  const originalUtmSource = r.UTM_SOURCE || null;
  const originalUtmMedium = r.UTM_MEDIUM || null;

  // UTM_SOURCE bo'lmasa yoki Bitrix24 forma nomi bo'lsa avto-to'ldirish
  const nullStr = (v) => (!v || String(v).trim().toLowerCase() === 'null' ? null : String(v).trim());
  let utmSource = nullStr(r.UTM_SOURCE);
  let utmMedium = nullStr(r.UTM_MEDIUM);

  // Bitrix24 ning o'z forma nomlarini utm_source sifatida saqlamaymiz
  if (utmSource && /leadmaster.*form|webform|instantform/i.test(utmSource)) {
    utmSource = null;
  }

  // Qisqa nomlarni to'liq nomga normalizatsiya (ig→Instagram, fb→Facebook)
  const UTM_NORMALIZE = { ig: 'Instagram', fb: 'Facebook', instagram: 'Instagram', facebook: 'Facebook' };
  if (utmSource && UTM_NORMALIZE[utmSource.trim().toLowerCase()]) {
    utmSource = UTM_NORMALIZE[utmSource.trim().toLowerCase()];
  }

  let sourceId = r.SOURCE_ID || null;

  const isAdSource = [SOURCE_FB, SOURCE_IG, SOURCE_TARGET].includes(r.SOURCE_ID);
  if (!utmSource && isAdSource) {
    // platform aniqlaymiz: IG manba yoki utm "ig" → Instagram, qolganlar → Facebook
    const isIg = r.SOURCE_ID === SOURCE_IG || (r.UTM_SOURCE || '').toLowerCase() === 'ig';
    utmSource = isIg ? 'Instagram' : 'Facebook';
    utmMedium = utmMedium || 'paid';
  }
  const { rows } = await db.query(
    `INSERT INTO leads (
       id, responsible_id, stage_id, opportunity, source_id,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       uf_segment, uf_filial, uf_service, uf_activity, uf_with_whom,
       uf_tashrif_sanasi,
       uf_amo_date,
       uf_cancel_reason, uf_junk_reason,
       uf_report_stage,
       uf_meeting_set_at,
       uf_meeting_done_at,
       name, last_name, title,
       web_form_id,
       date_create, date_modify, synced_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       responsible_id    = EXCLUDED.responsible_id,
       stage_id          = EXCLUDED.stage_id,
       opportunity       = EXCLUDED.opportunity,
       source_id         = EXCLUDED.source_id,
       utm_source        = EXCLUDED.utm_source,
       utm_medium        = EXCLUDED.utm_medium,
       utm_campaign      = EXCLUDED.utm_campaign,
       utm_content       = EXCLUDED.utm_content,
       utm_term          = EXCLUDED.utm_term,
       uf_segment        = EXCLUDED.uf_segment,
       uf_filial         = EXCLUDED.uf_filial,
       uf_service        = EXCLUDED.uf_service,
       uf_activity       = EXCLUDED.uf_activity,
       uf_with_whom      = EXCLUDED.uf_with_whom,
       uf_tashrif_sanasi = EXCLUDED.uf_tashrif_sanasi,
       uf_amo_date       = EXCLUDED.uf_amo_date,
       uf_cancel_reason  = EXCLUDED.uf_cancel_reason,
       uf_junk_reason    = EXCLUDED.uf_junk_reason,
       uf_report_stage   = EXCLUDED.uf_report_stage,
       uf_meeting_set_at  = EXCLUDED.uf_meeting_set_at,
       uf_meeting_done_at = EXCLUDED.uf_meeting_done_at,
       name             = EXCLUDED.name,
       last_name        = EXCLUDED.last_name,
       title            = EXCLUDED.title,
       web_form_id      = EXCLUDED.web_form_id,
       date_modify      = EXCLUDED.date_modify,
       synced_at        = NOW()
     RETURNING id`,
    [
      parseInt(r.ID),
      responsibleId,
      stageId,
      parseFloat(r.OPPORTUNITY || 0),
      sourceId,
      utmSource,
      utmMedium,
      r.UTM_CAMPAIGN || null,
      r.UTM_CONTENT || null,
      r.UTM_TERM || null,
      r.SOURCE_ID === 'UC_1WUFJB' ? ufVal(r.UF_CRM_1778261535982) : ufVal(r.UF_CRM_1775825731211),
      r.SOURCE_ID === 'UC_1WUFJB' ? ufEnum(r.UF_CRM_1778260858916, AMOCRM_SEGMENT_MAP) : ufVal(r.UF_CRM_1777030859057),
      ufVal(r.UF_CRM_1775824803703),
      ufVal(r.UF_CRM_1775825155935),
      ufVal(r.UF_CRM_1770281264686),
      ufVal(r.UF_CRM_1770693781846),
      r.SOURCE_ID === 'UC_1WUFJB' ? parseDate(r.UF_CRM_1778310745831) : null,
      ufEnum(r.UF_CRM_1770976355232, CANCEL_REASON_MAP),
      ufEnum(r.UF_CRM_1770282341169, JUNK_REASON_MAP),
      // "Стадия (для отчетов)" — a reporting label a manager sets by hand. It is
      // deliberately NOT derived from STATUS_ID: the two are allowed to disagree,
      // which is the whole point of the client asking for a separate field.
      ufVal(r.UF_CRM_1771440293231),
      // "Tashrif belgilandiga tushgan sana" — when the meeting was BOOKED
      // ("Uchrashuv belgilandi"). Kept as a real timestamp alongside the older
      // uf_tashrif_sanasi TEXT copy, which other endpoints still read.
      parseDate(r.UF_CRM_1770693781846),
      // "Tashrif buyurdiga tushgan sana" — when the lead entered the
      // "Konsultatsiya o'tkazildi" stage, i.e. when the meeting actually
      // happened. This is the date Uchrashuvlar soni is counted on; it is
      // NOT the lead's creation date and often falls in a later month.
      parseDate(r.UF_CRM_1770695429433),
      r.NAME || null,
      r.LAST_NAME || null,
      r.TITLE || null,
      r.WEB_FORM_ID ? String(r.WEB_FORM_ID) : null,
      dateCreate,
      parseDate(r.DATE_MODIFY),
    ]
  );

  const leadId = rows[0].id;

  // Save phone numbers to lead_phones
  const phones = Array.isArray(r.PHONE) ? r.PHONE : [];
  for (const p of phones) {
    const val = (p.VALUE || '').trim();
    if (!val) continue;
    await db.query(
      `INSERT INTO lead_phones (lead_id, phone) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [leadId, val]
    );
  }
  // Also save "Telefon raqamingiz" custom field (UF_CRM_1778261403182) to lead_phones
  const ufPhone = (r.UF_CRM_1778261403182 || '').trim();
  if (ufPhone && ufPhone.replace(/[^0-9]/g, '').length >= 7) {
    await db.query(
      `INSERT INTO lead_phones (lead_id, phone) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [leadId, ufPhone]
    );
  }

  // Agar UTM yoki source normalizatsiya qilingan bo'lsa — Bitrix24 da ham yangilaymiz
  const bxUpdateFields = {};
  if (sourceId  !== originalSourceId)  bxUpdateFields.SOURCE_ID  = sourceId;
  if (utmSource !== originalUtmSource) bxUpdateFields.UTM_SOURCE = utmSource;
  if (utmMedium !== originalUtmMedium) bxUpdateFields.UTM_MEDIUM = utmMedium;

  if (Object.keys(bxUpdateFields).length > 0 && r.ID) {
    const { bitrixCall } = require('./bitrix');
    bitrixCall('crm.lead.update', { id: parseInt(r.ID), fields: bxUpdateFields }, 'upsertLead:utm-writeback')
      .catch(e => console.warn(`[upsertLead] Bitrix24 UTM sync xatosi (#${r.ID}):`, e.message));
  }

  return leadId;
}

module.exports = { upsertLead };
