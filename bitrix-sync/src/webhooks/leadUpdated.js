const pool = require('../db/pool');
const { fetchOne } = require('../services/bitrix');
const { upsertLead } = require('../services/upsertLead');
const { sendQualifiedLead } = require('../services/metaConversions');

async function fetchOneWithRetry(method, id, maxRetries = 3) {
  const delays = [5000, 15000, 45000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchOne(method, id, 'webhook:leadUpdated');
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = delays[attempt] ?? 45000;
        console.warn(`[leadUpdated] fetchOne attempt ${attempt + 1} failed (${err.message}), retry in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// Bitrix24 da "sifatli" hisoblanadigan bosqichlar
const SIFATLI_BOSQICHLAR = new Set([
  'UC_KXC3ZW', 'THINKING',            // O'ylab ko'radi
  'UC_L28G68', 'CONSULTATION',        // Tashrif belgilandi
  'UC_5G8244', 'NOT_TRANSFERRED',     // Kelmadi
  'UC_NAZK5J', 'RECYCLED',            // Bekor bo'ldi
  'CONVERTED_CONSULT', 'CONVERTED',   // Tashrif buyurdi
]);

/**
 * Handle ONCRMLEAD_UPDATE webhook.
 * Responds 200 immediately, processes async.
 */
async function leadUpdated(req, res) {
  res.sendStatus(200);

  const entityId = parseInt(req.body?.data?.FIELDS?.ID || req.body?.['data[FIELDS][ID]']);
  if (!entityId) return;

  try {
    await pool.query(
      `INSERT INTO webhook_logs (event, entity_id, payload)
       VALUES ('ONCRMLEAD_UPDATE', $1, $2)`,
      [entityId, JSON.stringify(req.body)]
    );

    // Oldingi bosqichni saqlab qolamiz
    const before = await pool.query('SELECT stage_id FROM leads WHERE id = $1', [entityId]);
    const prevStageId = before.rows[0]?.stage_id || null;

    const raw = await fetchOneWithRetry('crm.lead.get', entityId);
    if (!raw) return;

    await upsertLead(raw);

    // Yangi bosqich
    const after = await pool.query(
      `SELECT l.stage_id, s.bitrix_id AS stage_bid
       FROM leads l JOIN stages s ON s.id = l.stage_id
       WHERE l.id = $1`,
      [entityId]
    );
    const newStageId  = after.rows[0]?.stage_id  || null;
    const newStageBid = after.rows[0]?.stage_bid || '';

    // Bosqich o'zgargan bo'lsa tarixga yozamiz
    if (newStageId && newStageId !== prevStageId) {
      await pool.query(
        'INSERT INTO lead_stage_history (lead_id, stage_id) VALUES ($1, $2)',
        [entityId, newStageId]
      );

      // Yangi bosqich sifatli bosqich bo'lsa → Meta ga signal yuboramiz
      if (SIFATLI_BOSQICHLAR.has(newStageBid) && process.env.META_PIXEL_ID) {
        sendMetaSignal(entityId, newStageBid).catch(err =>
          console.error(`[meta] Signal yuborishda xato (lead #${entityId}):`, err.message)
        );
      }
    }

    await pool.query(
      'UPDATE webhook_logs SET processed = TRUE WHERE event = $1 AND entity_id = $2 AND processed = FALSE',
      ['ONCRMLEAD_UPDATE', entityId]
    );

    console.log(`[webhook] lead updated: ${entityId}`);
  } catch (err) {
    console.error(`[webhook] leadUpdated error for ${entityId}:`, err.message);
    await pool.query(
      `UPDATE webhook_logs SET error = $1
       WHERE event = 'ONCRMLEAD_UPDATE' AND entity_id = $2 AND processed = FALSE`,
      [err.message, entityId]
    ).catch(() => {});
  }
}

/**
 * Facebookdan kelgan lid bo'lsa Meta ga sifatli signal yuboradi.
 */
async function sendMetaSignal(leadId, stageBid) {
  // Telefon orqali facebook_leads bilan moslashtirish
  const { rows } = await pool.query(`
    SELECT fl.id AS leadgen_id, fl.phone, fl.email
    FROM lead_phones lp
    JOIN facebook_leads fl ON fl.phone = lp.phone
    WHERE lp.lead_id = $1
    LIMIT 1
  `, [leadId]);

  if (rows.length === 0) return; // Facebook lidi emas

  const { leadgen_id, phone, email } = rows[0];

  const result = await sendQualifiedLead({
    leadgenId:  leadgen_id,
    phone,
    email,
    customData: { bitrix_stage: stageBid },
  });

  if (result?.events_received > 0) {
    console.log(`[meta] ✅ Lead #${leadId} sifatli signal yuborildi (FB lead: ${leadgen_id}, bosqich: ${stageBid})`);
  } else {
    console.warn(`[meta] ⚠️  Lead #${leadId} signal javobi:`, JSON.stringify(result));
  }
}

module.exports = leadUpdated;
