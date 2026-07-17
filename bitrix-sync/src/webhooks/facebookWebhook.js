const pool = require('../db/pool');
const { fetchLead, extractFields } = require('../services/facebook');
const { bitrixPost, fetchOne } = require('../services/bitrix');
const { upsertLead } = require('../services/upsertLead');
const { distributeLead } = require('../services/distributor');

// Facebook va Instagram Lead Ads uchun "Target" manba (UC_89FPH6)
const SOURCE_TARGET = 'UC_89FPH6';

/**
 * GET /webhook/facebook
 * Facebook verification handshake.
 */
function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_WEBHOOK_VERIFY_TOKEN) {
    console.log('[facebook] Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[facebook] Webhook verification failed — token mismatch');
  res.sendStatus(403);
}

/**
 * Bitrix24 uchun forma maydonlarini o'qilishi qulay matn sifatida yig'adi.
 * Asosiy maydonlar (name, phone, email) chiqarilmaydi — ular alohida yuboriladi.
 */
function buildComments(fields, raw) {
  const skip = new Set(['full_name', 'name', 'phone_number', 'phone', 'email',
                        'ismingiz:', 'ismingiz?', 'ismingiz',
                        'telefon_raqamingiz:', 'telefon_raqamingiz']);
  const extra = Object.entries(fields)
    .filter(([k]) => !skip.has(k) && fields[k])
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return [
    `📱 Facebook Lead Ad`,
    `Platforma: ${(raw.platform || 'facebook').toUpperCase()}`,
    `Kampaniya: ${raw.campaign_name || '—'}`,
    `Ad Set: ${raw.adset_name || '—'}`,
    `Reklama: ${raw.ad_name || '—'}`,
    `Forma ID: ${raw.form_id || '—'}`,
    extra ? `\nQo'shimcha:\n${extra}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * facebook_leads jadvaliga bitrix_lead_id ustunini qo'shadi (bir marta).
 */
async function ensureBitrixLeadIdColumn() {
  await pool.query(`
    ALTER TABLE facebook_leads
    ADD COLUMN IF NOT EXISTS bitrix_lead_id INT
  `);
}

let columnEnsured = false;

/**
 * Bitrix24 da lid yaratadi va facebook_leads ga bitrix_lead_id ni saqlaydi.
 */
async function createBitrixLead(leadgenId, raw, fields) {
  if (!columnEnsured) {
    await ensureBitrixLeadIdColumn();
    columnEnsured = true;
  }

  // Agar bu Facebook lead uchun Bitrix24 lid allaqachon yaratilgan bo'lsa, o'tkazib yuboramiz
  const { rows: existing } = await pool.query(
    'SELECT bitrix_lead_id FROM facebook_leads WHERE id = $1 AND bitrix_lead_id IS NOT NULL',
    [String(leadgenId)]
  );
  if (existing.length > 0) {
    console.log(`[facebook] Bitrix24 lead already exists (#${existing[0].bitrix_lead_id}) for FB lead ${leadgenId}`);
    return;
  }

  const platform  = (raw.platform || 'facebook').toLowerCase();
  const utmSource = platform === 'instagram' ? 'Instagram' : 'Facebook';
  const utmMedium = raw.is_organic ? 'organic' : 'paid';

  const phone = fields.phone_number || fields.phone
    || fields['telefon_raqamingizni_qoldiring!'] || fields['номер_телефона']
    || fields['telefon_raqamingiz:'] || fields['telefon_raqamingiz'] || null;
  const name  = fields.full_name || fields.name
    || fields['ismingizni_qoldiring!']
    || fields['ismingiz:'] || fields['ismingiz?'] || fields['ismingiz'] || 'Facebook Lead';
  const email = fields.email || null;

  // Bitrix24's native CRM-form connector may have already created a lead for
  // this same submission — but it writes NO UTM fields, which breaks the
  // UTM-based campaign attribution (Kampaniyalar "Jami lid"). If a recent
  // UTM-less Target lead with this phone exists in the mirror, patch its UTMs
  // instead of creating a duplicate.
  if (phone) {
    try {
      const last9 = String(phone).replace(/[^0-9]/g, '').slice(-9);
      if (last9) {
        const { rows: existingUtmless } = await pool.query(`
          SELECT l.id FROM leads l
          JOIN lead_phones lp ON lp.lead_id = l.id
          WHERE RIGHT(REGEXP_REPLACE(lp.phone, '[^0-9]', '', 'g'), 9) = $1
            AND l.source_id = $2
            AND (l.utm_campaign IS NULL OR l.utm_campaign = '')
            AND l.date_create > NOW() - INTERVAL '48 hours'
          ORDER BY l.date_create DESC LIMIT 1
        `, [last9, SOURCE_TARGET]);
        if (existingUtmless.length > 0) {
          const existingId = existingUtmless[0].id;
          const utmFields = {
            UTM_SOURCE:   utmSource,
            UTM_MEDIUM:   utmMedium,
            UTM_CAMPAIGN: raw.campaign_name || '',
            UTM_CONTENT:  raw.adset_name   || '',
            UTM_TERM:     raw.ad_name      || '',
          };
          const updRes = await bitrixPost('crm.lead.update', { id: existingId, fields: utmFields });
          if (updRes && updRes.result) {
            await pool.query(
              `UPDATE leads SET utm_source=$2, utm_medium=$3, utm_campaign=$4, utm_content=$5, utm_term=$6 WHERE id=$1`,
              [existingId, utmFields.UTM_SOURCE, utmFields.UTM_MEDIUM, utmFields.UTM_CAMPAIGN, utmFields.UTM_CONTENT, utmFields.UTM_TERM]
            );
            await pool.query(
              'UPDATE facebook_leads SET bitrix_lead_id = $1 WHERE id = $2',
              [existingId, String(leadgenId)]
            );
            console.log(`[facebook] UTM patched onto existing lead #${existingId} (native-connector created) for FB lead ${leadgenId}`);
            return;
          }
        }
      }
    } catch (utmErr) {
      console.error(`[facebook] UTM-patch check failed for ${leadgenId}:`, utmErr.message);
      // fall through to normal create
    }
  }

  const bxFields = {
    NAME:         name,
    STATUS_ID:    'NEW',           // Yangi lid bosqichi
    SOURCE_ID:    SOURCE_TARGET,   // Target (UC_89FPH6)
    UTM_SOURCE:   utmSource,
    UTM_MEDIUM:   utmMedium,
    UTM_CAMPAIGN: raw.campaign_name || '',
    UTM_CONTENT:  raw.adset_name   || '',
    UTM_TERM:     raw.ad_name      || '',
    COMMENTS:     buildComments(fields, raw),
  };

  if (phone) bxFields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'WORK' }];
  if (email) bxFields.EMAIL = [{ VALUE: email, VALUE_TYPE: 'WORK' }];

  const bxRes = await bitrixPost('crm.lead.add', { fields: bxFields });

  if (bxRes && bxRes.result) {
    const newLeadId = bxRes.result;

    await pool.query(
      'UPDATE facebook_leads SET bitrix_lead_id = $1 WHERE id = $2',
      [newLeadId, String(leadgenId)]
    );
    console.log(`[facebook] Bitrix24 lead #${newLeadId} created for FB lead ${leadgenId}`);

    // Bitrix24 dan to'liq lead ma'lumotlarini olib DBga saqlash va taqsimot qilish
    // (ONCRMLEAD_ADD webhook kelmasa ham ishlash uchun)
    try {
      const rawLead = await fetchOne('crm.lead.get', newLeadId);
      if (rawLead) {
        // Patch UTM_CAMPAIGN from FB lead data if Bitrix24 doesn't return it
        if (!rawLead.UTM_CAMPAIGN && raw.campaign_name) {
          rawLead.UTM_CAMPAIGN = raw.campaign_name;
        }
        await upsertLead(rawLead);
        const assigned = await distributeLead(newLeadId);
        if (assigned) {
          console.log(`[facebook] Lead #${newLeadId} distributed to responsible #${assigned}`);
        } else {
          console.warn(`[facebook] Lead #${newLeadId} distribution skipped (no distributors?)`);
        }
      }
    } catch (distErr) {
      console.error(`[facebook] Post-create sync/distribution error for lead #${newLeadId}:`, distErr.message);
    }
  } else {
    console.error(`[facebook] Bitrix24 lead creation failed for ${leadgenId}:`, bxRes);
  }
}

/**
 * POST /webhook/facebook
 * Facebook lead gen eventini qabul qiladi.
 */
async function receiveWebhook(req, res) {
  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;

      const value     = change.value || {};
      const leadgenId = value.leadgen_id;
      const pageId    = value.page_id;

      if (!leadgenId) continue;

      try {
        // 1. Webhook logga yozish
        await pool.query(
          `INSERT INTO webhook_logs (event, payload)
           VALUES ('FB_LEADGEN', $1)`,
          [JSON.stringify({ leadgen_id: leadgenId, page_id: pageId, ...value })]
        );

        // 2. Facebook Graph API dan to'liq lead ma'lumotlarini olish
        const raw    = await fetchLead(leadgenId);
        const fields = extractFields(raw.field_data);

        // 3. facebook_leads jadvaliga saqlash
        await pool.query(
          `INSERT INTO facebook_leads (
             id, form_id, ad_id, ad_name, adset_id, adset_name,
             campaign_id, campaign_name, page_id,
             full_name, phone, email, field_data, created_time,
             platform, is_organic
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO UPDATE SET
             full_name  = EXCLUDED.full_name,
             phone      = EXCLUDED.phone,
             field_data = EXCLUDED.field_data,
             platform   = EXCLUDED.platform,
             is_organic = EXCLUDED.is_organic`,
          [
            leadgenId,
            raw.form_id      || null,
            raw.ad_id        || null,
            raw.ad_name      || null,
            raw.adset_id     || null,
            raw.adset_name   || null,
            raw.campaign_id  || null,
            raw.campaign_name || null,
            pageId           || null,
            fields.full_name || fields.name
              || fields['ismingiz:'] || fields['ismingiz?'] || fields['ismingiz'] || null,
            fields.phone_number || fields.phone
              || fields['telefon_raqamingiz:'] || fields['telefon_raqamingiz'] || null,
            fields.email     || null,
            JSON.stringify(fields),
            raw.created_time ? new Date(raw.created_time) : new Date(),
            raw.platform || 'facebook',
            !!raw.is_organic,
          ]
        );

        // 4. Bitrix24 da avtomatik lid yaratish (agar BITRIX_WEBHOOK_URL sozlangan bo'lsa)
        if (process.env.BITRIX_WEBHOOK_URL) {
          await createBitrixLead(leadgenId, raw, fields);
        }

        // 5. Log yozuvini yangilash
        await pool.query(
          `UPDATE webhook_logs SET processed = TRUE
           WHERE event = 'FB_LEADGEN'
             AND payload->>'leadgen_id' = $1
             AND processed = FALSE`,
          [String(leadgenId)]
        );

        console.log(`[facebook] Lead processed: ${leadgenId}`);
      } catch (err) {
        console.error(`[facebook] Error processing leadgen ${leadgenId}:`, err.message);
        await pool.query(
          `UPDATE webhook_logs SET error = $1
           WHERE event = 'FB_LEADGEN'
             AND payload->>'leadgen_id' = $2
             AND processed = FALSE`,
          [err.message, String(leadgenId)]
        ).catch(() => {});
      }
    }
  }
}

module.exports = { verifyWebhook, receiveWebhook };
