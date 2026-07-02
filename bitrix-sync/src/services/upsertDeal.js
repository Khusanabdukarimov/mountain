const pool = require('../db/pool');
const stageResolver = require('./stageResolver');
const { toUSD } = require('./currencyRates');

const DEAL_CANCEL_REASON_MAP = {
  '1286': "Qimmatlik qildi",
  '1292': "Boshqalardan sotib oldi",
  '1526': "Biznes egasi emas",
  '1528': "Maqul kelmadi",
  '1530': "Nomi patentdan o'tmaydi",
  '1532': "Qadriyatimizga to'g'ri kelmadi",
  '1534': "Sheriklarga maqul kelmadi",
  '1536': "2 xafta ichida umuman javob berishmadi",
  '1538': "Hamkorlik bo'yicha ish boshlandi",
  '1540': "Faoliyat to'xtatildi",
  '1288': "Puli yo'q",
  '1542': "Kerak emas"
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
 * Upsert a single deal from Bitrix24 raw data.
 * Returns the deals.id.
 */
async function upsertDeal(r, client) {
  const db = client || pool;

  const stageId = await stageResolver.resolve('deal', r.STAGE_ID, r.STAGE_SEMANTIC_ID);
  const responsibleId = r.ASSIGNED_BY_ID ? parseInt(r.ASSIGNED_BY_ID) : null;
  const contactId = r.CONTACT_ID ? parseInt(r.CONTACT_ID) : null;
  const currency = r.CURRENCY_ID || 'USD';

  const rawPaidSum     = r.UF_CRM_1780643524 ? parseFloat(r.UF_CRM_1780643524) : null;
  const rawRemaining   = r.UF_CRM_1780643502 != null ? parseFloat(r.UF_CRM_1780643502) : null;
  const paidSumUSD     = await toUSD(rawPaidSum,   currency);
  const remainingSumUSD = await toUSD(rawRemaining, currency);
  // UF_CRM_69D8F7169A174 — to'landi summa (money field: "7500|USD")
  const tolandiRaw = r.UF_CRM_69D8F7169A174;
  let tolandiSum = null;
  if (tolandiRaw) {
    const parts = String(tolandiRaw).split('|');
    const amt = parseFloat(parts[0]);
    const cur = parts[1] || currency;
    if (!isNaN(amt) && amt > 0) tolandiSum = await toUSD(amt, cur);
  }

  const leadId = r.LEAD_ID ? parseInt(r.LEAD_ID) : null;

  const categoryId = r.CATEGORY_ID ? parseInt(r.CATEGORY_ID) : 0;

  const { rows } = await db.query(
    `INSERT INTO deals (
       id, responsible_id, stage_id, opportunity, currency_id,
       source_id, utm_source, date_create, date_modify, closedate,
       uf_sale_date, uf_bp_sale_date, uf_payment_date,
       uf_paid_sum, uf_remaining_sum,
       uf_cancel_reason, contact_id, begindate, uf_amo_date, uf_service, uf_tolandi_sum, lead_id, category_id, synced_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
     ON CONFLICT (id) DO UPDATE SET
       responsible_id   = EXCLUDED.responsible_id,
       stage_id         = EXCLUDED.stage_id,
       opportunity      = EXCLUDED.opportunity,
       currency_id      = EXCLUDED.currency_id,
       source_id        = EXCLUDED.source_id,
       utm_source       = EXCLUDED.utm_source,
       date_modify      = EXCLUDED.date_modify,
       closedate        = EXCLUDED.closedate,
       uf_sale_date     = EXCLUDED.uf_sale_date,
       uf_bp_sale_date  = COALESCE(EXCLUDED.uf_bp_sale_date, deals.uf_bp_sale_date),
       uf_payment_date  = EXCLUDED.uf_payment_date,
       uf_paid_sum      = EXCLUDED.uf_paid_sum,
       uf_remaining_sum = EXCLUDED.uf_remaining_sum,
       uf_cancel_reason = EXCLUDED.uf_cancel_reason,
       contact_id       = EXCLUDED.contact_id,
       begindate        = EXCLUDED.begindate,
       uf_amo_date      = EXCLUDED.uf_amo_date,
       uf_service       = EXCLUDED.uf_service,
       uf_tolandi_sum   = EXCLUDED.uf_tolandi_sum,
       lead_id          = COALESCE(EXCLUDED.lead_id, deals.lead_id),
       category_id      = EXCLUDED.category_id,
       synced_at        = NOW()
     RETURNING id`,
    [
      parseInt(r.ID),
      responsibleId,
      stageId,
      parseFloat(r.OPPORTUNITY || 0),
      r.CURRENCY_ID || null,
      r.SOURCE_ID || null,
      r.UTM_SOURCE || null,
      parseDate(r.DATE_CREATE),
      parseDate(r.DATE_MODIFY),
      parseDate(r.CLOSEDATE),
      parseDate(r.UF_CRM_1779450406),
      parseDate(r.UF_CRM_10_1780604989),
      parseDate(r.UF_CRM_1779450159),
      paidSumUSD,
      remainingSumUSD,
      ufEnum(r.UF_CRM_69EBC105EAA93, DEAL_CANCEL_REASON_MAP),
      contactId,
      parseDate(r.BEGINDATE),
      parseDate(r.UF_CRM_69FEFD2D71544),
      ufVal(r.UF_CRM_69D8F71700936),
      tolandiSum,
      leadId,
      categoryId,
    ]
  );

  return rows[0].id;
}

module.exports = { upsertDeal };

