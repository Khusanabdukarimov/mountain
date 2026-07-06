const pool = require('../db/pool');
const { fetchOne } = require('../services/bitrix');
const { upsertLead } = require('../services/upsertLead');
const { distributeLead } = require('../services/distributor');

async function fetchOneWithRetry(method, id, maxRetries = 3) {
  const delays = [5000, 15000, 45000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchOne(method, id);
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = delays[attempt] ?? 45000;
        console.warn(`[leadCreated] fetchOne attempt ${attempt + 1} failed (${err.message}), retry in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

const LEAD_SELECT = [
  'ID', 'ASSIGNED_BY_ID', 'STATUS_ID', 'OPPORTUNITY', 'SOURCE_ID',
  'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
  'DATE_CREATE', 'DATE_MODIFY', 'NAME', 'LAST_NAME', 'TITLE', 'COMMENTS', 'PHONE',
  'UF_CRM_1778261403182',
  'UF_CRM_1775825731211', 'UF_CRM_1778260858916',
  'UF_CRM_1775824803703', 'UF_CRM_1775825155935', 'UF_CRM_1770281264686',
  'UF_CRM_1770976355232', 'UF_CRM_1770282341169',
  'UF_CRM_1770693781846', 'UF_CRM_1778310745831',
];

/**
 * Handle ONCRMLEAD_ADD webhook.
 * Express handler — responds 200 immediately, processes async.
 */
async function leadCreated(req, res) {
  res.sendStatus(200);

  const entityId = parseInt(req.body?.data?.FIELDS?.ID || req.body?.['data[FIELDS][ID]']);
  if (!entityId) return;

  try {
    await pool.query(
      `INSERT INTO webhook_logs (event, entity_id, payload)
       VALUES ('ONCRMLEAD_ADD', $1, $2)`,
      [entityId, JSON.stringify(req.body)]
    );

    const raw = await fetchOneWithRetry('crm.lead.get', entityId);
    if (!raw) {
      console.error(`[leadCreated] crm.lead.get returned null for lead ${entityId} — BITRIX_WEBHOOK_URL may be invalid`);
      return;
    }

    await upsertLead(raw);

    // Distribute to responsible — only when:
    //   1. Not an amoCRM lead
    //   2. Not a Qo'ng'iroq (Calls) stage
    //   3. ASSIGNED_BY_ID equals the main responsible (env MAIN_RESPONSIBLE_ID)
    // Note: no stage check — by the time we fetch the lead from Bitrix24,
    // it may have already auto-transitioned out of NEW.
    const mainResponsibleId = parseInt(process.env.MAIN_RESPONSIBLE_ID || '1', 10);
    const isAmoCRM          = raw.SOURCE_ID === 'UC_1WUFJB';
    const isCallsStage      = raw.STATUS_ID === 'CALLS' || raw.STATUS_ID === 'UC_K0PWSA';
    // Accept both main webhook user (#1) and Data365 Support (#40) as "unassigned" slots
    const assignedId        = parseInt(raw.ASSIGNED_BY_ID, 10);
    const isMainResponsible = assignedId === mainResponsibleId || assignedId === 40;

    // Website forma (REPEAT_SALE) leads assigned to Shaxzod Turanov (#28)
    // are routed through him but must still be distributed via taqsimot logic
    const isWebsiteFormaRouter =
      raw.SOURCE_ID === 'REPEAT_SALE' && assignedId === 28;

    // Distribute if responsible is Main — regardless of source
    if (!isAmoCRM && !isCallsStage && (isMainResponsible || isWebsiteFormaRouter)) {
      const assignedTo = await distributeLead(entityId);
      if (assignedTo) {
        console.log(`[leadCreated] Lead ${entityId} distributed to responsible ${assignedTo}`);
      }
    }

    // Facebook/Instagram lid bo'lsa va telefon yo'q bo'lsa — facebook_leads dan topib qo'shamiz
    const FB_SOURCES = ['UC_O9BLGT', 'UC_3O8GTF', 'UC_89FPH6'];
    if (FB_SOURCES.includes(raw.SOURCE_ID)) {
      await backfillPhoneFromFacebook(entityId, raw);
    }

    // Record initial stage in history
    const lead = await pool.query('SELECT id, stage_id FROM leads WHERE id = $1', [entityId]);
    if (lead.rows.length && lead.rows[0].stage_id) {
      await pool.query(
        'INSERT INTO lead_stage_history (lead_id, stage_id) VALUES ($1, $2)',
        [entityId, lead.rows[0].stage_id]
      );
    }

    await pool.query(
      'UPDATE webhook_logs SET processed = TRUE WHERE event = $1 AND entity_id = $2 AND processed = FALSE',
      ['ONCRMLEAD_ADD', entityId]
    );

    console.log(`[webhook] lead created: ${entityId}`);
  } catch (err) {
    console.error(`[webhook] leadCreated error for ${entityId}:`, err.message);
    await pool.query(
      `UPDATE webhook_logs SET error = $1
       WHERE event = 'ONCRMLEAD_ADD' AND entity_id = $2 AND processed = FALSE`,
      [err.message, entityId]
    ).catch(() => {});
  }
}

/**
 * Facebook/Instagram lid uchun telefon yo'q bo'lsa, facebook_leads jadvalidan
 * vaqt va ism bo'yicha moslashtirish orqali telefon qo'shadi.
 */
async function backfillPhoneFromFacebook(leadId, raw) {
  try {
    // Bitrix24 lead da telefon bormi?
    const { rows: existing } = await pool.query(
      'SELECT phone FROM lead_phones WHERE lead_id = $1 LIMIT 1',
      [leadId]
    );
    if (existing.length > 0) return; // Telefon bor, kerak emas

    const leadName = `${raw.NAME || ''} ${raw.LAST_NAME || ''}`.trim().toLowerCase();
    const leadDate = raw.DATE_CREATE ? new Date(raw.DATE_CREATE) : null;
    if (!leadDate) return;

    // facebook_leads dan vaqt ±30 daqiqa va ism bo'yicha izlaymiz
    const { rows: fbLeads } = await pool.query(`
      SELECT id, phone, full_name
      FROM facebook_leads
      WHERE phone IS NOT NULL AND phone != ''
        AND ABS(EXTRACT(EPOCH FROM (created_time - $1::timestamptz))) < 1800
      ORDER BY ABS(EXTRACT(EPOCH FROM (created_time - $1::timestamptz))) ASC
      LIMIT 5
    `, [leadDate.toISOString()]);

    if (fbLeads.length === 0) return;

    // Eng yaqin vaqtdagi yoki ismi mos keladiganini topamiz
    let best = fbLeads[0]; // Vaqt bo'yicha eng yaqini
    for (const fl of fbLeads) {
      const flName = (fl.full_name || '').toLowerCase();
      if (leadName && flName && (leadName.includes(flName.split(' ')[0]) || flName.includes(leadName.split(' ')[0]))) {
        best = fl;
        break;
      }
    }

    if (!best?.phone) return;

    // lead_phones ga qo'shamiz
    await pool.query(
      `INSERT INTO lead_phones (lead_id, phone) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [leadId, best.phone]
    );

    // Bitrix24 da ham PHONE yangilaymiz
    const { bitrixCall } = require('../services/bitrix');
    await bitrixCall('crm.lead.update', {
      id: leadId,
      fields: { PHONE: [{ VALUE: best.phone, VALUE_TYPE: 'WORK' }] },
    });

    console.log(`[leadCreated] Telefon qo'shildi: lead #${leadId} ← ${best.phone} (FB lead: ${best.id})`);
  } catch (err) {
    console.error(`[leadCreated] Telefon backfill xatosi (lead #${leadId}):`, err.message);
  }
}

module.exports = leadCreated;
