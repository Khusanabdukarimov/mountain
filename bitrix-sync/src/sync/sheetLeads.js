'use strict';

/**
 * Google Sheets → Bitrix24 lead yaratish (har daqiqada).
 *
 * "Leads" varag'iga qo'lda yoki boshqa avtomatizatsiya orqali qator qo'shiladi;
 * bu modul har daqiqada varaqni o'qib, hali Bitrix'ga tushmagan qatorlarni
 * lead qilib yaratadi va natijani varaqqa qaytarib yozadi.
 *
 * DUBLIKATGA QARSHI UCH QATLAM — poller har daqiqada ishlagani uchun muhim:
 *   1. Postgres `sheet_lead_sync` jadvali. Qator yuborishdan OLDIN "band
 *      qilinadi" (INSERT ... ON CONFLICT DO NOTHING). Ikkinchi urinish yoki
 *      parallel process o'sha qatorni ololmaydi.
 *   2. Varaqdagi "Bitrix ID" ustuni — inson uchun ko'rinadigan belgi; bazasi
 *      tozalansa ham qayta yuborilmaydi.
 *   3. crm.duplicate.findbycomm (telefon bo'yicha) — agar band qilingandan
 *      keyin process qulab tushsa va qayta urinish bo'lsa, avval Bitrix'da
 *      shu raqamli lead bor-yo'qligi tekshiriladi va bor bo'lsa o'shaning ID si
 *      ishlatiladi, yangisi yaratilmaydi.
 *
 * Qator kaliti: varaqdagi "ID" ustuni (barqaror), u bo'lmasa qator raqami.
 * "ID" ustuni bo'lgani uchun oraga qator qo'shilsa ham kalit siljimaydi.
 */

const pool = require('../db/pool');
const sheets = require('../services/googleSheets');
const { bitrixCall, bitrixPost } = require('../services/bitrix');

// ─── Sozlamalar ──────────────────────────────────────────────────────────────

const SPREADSHEET_ID = process.env.SHEETS_LEADS_ID || '';
const TAB            = process.env.SHEETS_LEADS_TAB || 'Leads';
const INTERVAL_SEC   = parseInt(process.env.SHEETS_LEADS_INTERVAL_SEC || '60', 10);
const DEDUPE_PHONE   = process.env.SHEETS_LEADS_DEDUPE_PHONE !== 'false';

// Bitrix maydon kodlari (crm.lead.fields orqali tekshirilgan)
const F_BREND_NOMI = 'UF_CRM_1775824743431'; // "Brend nomi"          string
const F_KLASSLAR   = 'UF_CRM_1775826267500'; // "Klasslari"           enumeration[] 1..45
const F_BYUDJET    = 'UF_CRM_BYUDJET';       // "Byudjet"             string

// Varaqdan kelgan lead qaysi stadiyaga tushadi. IN_PROCESS = "Yangi lid"
// (crm.status.list bilan tekshirilgan). NEW = "Qo'ng'iroqlar" — bu yerda emas.
const LEAD_STATUS_ID = process.env.SHEETS_LEADS_STATUS_ID || 'IN_PROCESS';

// TAQSIMOT: bu modul o'zi taqsimlamaydi — ataylab.
// Lead Bitrix'da yaratilishi bilan ONCRMLEAD_ADD webhook'i ishga tushadi va
// src/webhooks/leadCreated.js ichida distributeLead() chaqiriladi. Agar bu yerda
// ham chaqirsak, ikkalasi bir vaqtda ishlab, taqsimot hisobini buzardi.
//
// leadCreated taqsimlashi uchun uchta shart bajarilishi kerak:
//   1. SOURCE_ID !== 'UC_1WUFJB'  (amoCRM emas)    → biz SOURCE_ID qo'ymaymiz  ✓
//   2. STATUS_ID Qo'ng'iroqlar stadiyasi emas       → IN_PROCESS qo'yamiz       ✓
//   3. ASSIGNED_BY_ID = MAIN_RESPONSIBLE_ID yoki 40 ("egasiz" slot)
//
// Uchinchisi uchun mas'ulni ANIQ qo'yamiz: aks holda lead qaysi webhook
// foydalanuvchisi nomidan yaratilsa, o'sha odamga biriktirilib qoladi va
// taqsimotga umuman tushmaydi.
const MAIN_RESPONSIBLE_ID = parseInt(process.env.MAIN_RESPONSIBLE_ID || '1', 10);

// Manba: "Ready.uz" (crm.status.add bilan yaratilgan, ID 462).
// upsertLead va leadCreated dagi maxsus SOURCE_ID shartlariga tushmaydi:
// amoCRM (UC_1WUFJB) emas, reklama manbasi (FB/IG/Target) ham emas — demak
// UTM avto-to'ldirish ham, amoCRM mapping ham bu leadlarga tegmaydi.
const LEAD_SOURCE_ID = process.env.SHEETS_LEADS_SOURCE_ID || 'READY_UZ';

// Varaqdagi natija ustunlari — bo'lmasa sarlavha qatoriga qo'shiladi
const COL_BITRIX_ID = 'Bitrix ID';
const COL_HOLAT     = 'Holat';

// Band qilingan, lekin yakunlanmagan qator shu vaqtdan keyin qayta urinadi
const STALE_CLAIM_MIN = 5;

// ─── Sxema ───────────────────────────────────────────────────────────────────

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sheet_lead_sync (
      id             SERIAL PRIMARY KEY,
      spreadsheet_id TEXT NOT NULL,
      tab            TEXT NOT NULL,
      row_key        TEXT NOT NULL,
      row_num        INTEGER,
      lead_id        INTEGER,
      status         TEXT,
      error          TEXT,
      claimed_at     TIMESTAMPTZ DEFAULT NOW(),
      done_at        TIMESTAMPTZ,
      raw            JSONB,
      UNIQUE (spreadsheet_id, tab, row_key)
    );
    CREATE INDEX IF NOT EXISTS sheet_lead_sync_pending_idx
      ON sheet_lead_sync (claimed_at) WHERE lead_id IS NULL;
  `);
}

// ─── Klasslar: raqam → Bitrix enum item ID ───────────────────────────────────

let klassMap = null;
let klassMapAt = 0;

/**
 * "Klasslari" enumeration, shuning uchun "35" emas, o'sha variantning ID si
 * yuboriladi. Ro'yxat kodda qotirilmagan — Bitrix'dan o'qiladi va soatiga bir
 * marta yangilanadi, portalda variant qo'shilsa o'zi ushlaydi.
 */
async function getKlassMap() {
  if (klassMap && Date.now() - klassMapAt < 3600_000) return klassMap;

  const fields = await bitrixCall('crm.lead.fields', {}, 'sheet-leads');
  const field = (fields.result || {})[F_KLASSLAR];
  if (!field) throw new Error(`Bitrix'da ${F_KLASSLAR} ("Klasslari") topilmadi`);

  const map = {};
  (field.items || []).forEach((item) => { map[String(item.VALUE).trim()] = String(item.ID); });

  klassMap = map;
  klassMapAt = Date.now();
  return map;
}

/** "35" → ["360"] ; "35, 37" → ["360","364"] ; bo'sh → [] */
async function klasslarToIds(cell) {
  if (cell === '' || cell === null || cell === undefined) return [];

  const map = await getKlassMap();
  const ids = [];
  const topilmadi = [];

  String(cell).split(/[,;/\s]+/).forEach((part) => {
    const raw = part.trim();
    if (!raw) return;
    const n = String(parseInt(raw, 10));
    if (map[n]) ids.push(map[n]);
    else topilmadi.push(raw);
  });

  if (topilmadi.length) {
    throw new Error(`Klass topilmadi: ${topilmadi.join(', ')} (ruxsat etilgani 1..45)`);
  }
  return ids;
}

// ─── Qator → Bitrix fields ───────────────────────────────────────────────────

/** "Sana (Toshkent)" → "sana" */
function headerKey(h) {
  return String(h || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
}

async function buildLeadFields(row) {
  const fields = {};

  if (row.nom) {
    fields.TITLE = String(row.nom).trim();
    fields[F_BREND_NOMI] = String(row.nom).trim();
  }

  if (row.mijoz) fields.NAME = String(row.mijoz).trim();

  // Faqat standart PHONE — "Telefon raqamingiz" (UF_CRM_1778261403182) ataylab
  // to'ldirilmaydi. Portalda avtomatizatsiya bor: o'sha UF maydonni PHONE ga
  // WORK turi bilan ko'chiradi (lead yaratilgandan ~2s keyin, #1 nomidan).
  // Ikkalasini ham yozsak, bitta raqam kartochkada ikki marta chiqadi —
  // #40774 va #40776 da aynan shunday bo'ldi.
  if (row.telefon) {
    fields.PHONE = [{ VALUE: String(row.telefon).trim(), VALUE_TYPE: 'MOBILE' }];
  }

  const klassIds = await klasslarToIds(row.klasslar);
  if (klassIds.length) fields[F_KLASSLAR] = klassIds;

  // Narx + Valyuta → "Byudjet" (string), masalan "9000 USD"
  if (row.narx !== '' && row.narx !== null && row.narx !== undefined) {
    const narx = String(row.narx).trim();
    const valyuta = row.valyuta ? String(row.valyuta).trim() : '';
    fields[F_BYUDJET] = valyuta ? `${narx} ${valyuta}` : narx;
  }

  // "instagram / cpc / bahor" → UTM uchligi
  if (row.manba) {
    const p = String(row.manba).split('/').map((s) => s.trim());
    if (p[0]) fields.UTM_SOURCE = p[0];
    if (p[1]) fields.UTM_MEDIUM = p[1];
    if (p[2]) fields.UTM_CAMPAIGN = p[2];
  }

  if (!fields.TITLE) fields.TITLE = (row.telefon && String(row.telefon).trim()) || 'Sheets lead';

  fields.STATUS_ID = LEAD_STATUS_ID;
  fields.SOURCE_ID = LEAD_SOURCE_ID;

  // "Egasiz" slot — ONCRMLEAD_ADD webhook'i buni ko'rib taqsimotga qo'shadi
  fields.ASSIGNED_BY_ID = MAIN_RESPONSIBLE_ID;

  return fields;
}

// ─── Bitrix ──────────────────────────────────────────────────────────────────

/** Telefon bo'yicha mavjud lidni izlaydi. Topilmasa null. */
async function findExistingLeadByPhone(phone) {
  if (!phone) return null;
  try {
    const res = await bitrixCall('crm.duplicate.findbycomm', {
      entity_type: 'LEAD',
      type: 'PHONE',
      values: [String(phone).trim()],
    }, 'sheet-leads');
    const ids = (res.result && res.result.LEAD) || [];
    return ids.length ? parseInt(ids[0]) : null;
  } catch (e) {
    console.warn('[sheet-leads] duplicate check failed:', e.message);
    return null;
  }
}

async function createLead(fields) {
  const res = await bitrixPost('crm.lead.add', {
    fields,
    params: { REGISTER_SONET_EVENT: 'Y' },
  }, 'sheet-leads');

  if (!res.result) throw new Error(res.error_description || res.error || 'crm.lead.add javob bermadi');
  return parseInt(res.result);
}

// ─── Asosiy sikl ─────────────────────────────────────────────────────────────

let running = false;

async function pollOnce() {
  if (!SPREADSHEET_ID) return 0;
  if (running) return 0; // oldingi sikl tugamagan — o'tkazib yuboramiz
  running = true;

  try {
    const values = await sheets.getValues(SPREADSHEET_ID, TAB);
    if (values.length < 2) return 0;

    const headers = values[0].map((h) => String(h || ''));

    // Natija ustunlari bo'lmasa — sarlavha qatoriga qo'shamiz
    let idCol = headers.indexOf(COL_BITRIX_ID);
    let stCol = headers.indexOf(COL_HOLAT);
    if (idCol === -1 || stCol === -1) {
      if (idCol === -1) { idCol = headers.length; headers.push(COL_BITRIX_ID); }
      if (stCol === -1) { stCol = headers.length; headers.push(COL_HOLAT); }
      await sheets.updateValues(SPREADSHEET_ID, `${TAB}!A1`, [headers]);
    }

    const keyCol = headers.findIndex((h) => headerKey(h) === 'id');
    const writes = [];
    let yaratildi = 0;

    for (let i = 1; i < values.length; i++) {
      const cells = values[i];
      const rowNum = i + 1; // varaqdagi 1-based qator raqami

      const bosh = !cells || cells.every((v) => v === '' || v === null || v === undefined);
      if (bosh) continue;
      if (cells[idCol]) continue; // allaqachon yuborilgan

      // Barqaror kalit: "ID" ustuni, bo'lmasa qator raqami
      const rowKey = (keyCol !== -1 && cells[keyCol] !== undefined && cells[keyCol] !== '')
        ? `id:${String(cells[keyCol]).trim()}`
        : `row:${rowNum}`;

      const row = {};
      headers.forEach((h, idx) => {
        const key = headerKey(h);
        if (key) row[key] = cells[idx] !== undefined ? cells[idx] : '';
      });

      // 1-qatlam: bazada band qilamiz
      const claim = await pool.query(
        `INSERT INTO sheet_lead_sync (spreadsheet_id, tab, row_key, row_num, status, raw)
         VALUES ($1, $2, $3, $4, 'claimed', $5)
         ON CONFLICT (spreadsheet_id, tab, row_key) DO UPDATE
           SET row_num = EXCLUDED.row_num, claimed_at = NOW()
           WHERE sheet_lead_sync.lead_id IS NULL
             AND sheet_lead_sync.claimed_at < NOW() - INTERVAL '${STALE_CLAIM_MIN} minutes'
         RETURNING id, lead_id`,
        [SPREADSHEET_ID, TAB, rowKey, rowNum, JSON.stringify(row)]
      );

      if (!claim.rows.length) {
        // Band qilib bo'lmadi: yo yaqinda band qilingan, yo allaqachon tugagan.
        // Tugagan bo'lsa varaqdagi ID bo'sh qolgan — qaytarib yozamiz.
        const done = await pool.query(
          `SELECT lead_id FROM sheet_lead_sync
            WHERE spreadsheet_id = $1 AND tab = $2 AND row_key = $3 AND lead_id IS NOT NULL`,
          [SPREADSHEET_ID, TAB, rowKey]
        );
        if (done.rows.length) {
          writes.push({ range: `${TAB}!${sheets.columnLetter(idCol)}${rowNum}`, values: [[done.rows[0].lead_id]] });
        }
        continue;
      }

      try {
        const fields = await buildLeadFields(row);

        // 3-qatlam: qayta urinishda Bitrix'da dublikat yaratmaslik
        let leadId = null;
        if (DEDUPE_PHONE && row.telefon) leadId = await findExistingLeadByPhone(row.telefon);

        const reused = leadId !== null;
        if (!reused) leadId = await createLead(fields);

        await pool.query(
          `UPDATE sheet_lead_sync SET lead_id = $1, status = $2, error = NULL, done_at = NOW()
            WHERE id = $3`,
          [leadId, reused ? 'reused' : 'created', claim.rows[0].id]
        );

        writes.push({ range: `${TAB}!${sheets.columnLetter(idCol)}${rowNum}`, values: [[leadId]] });
        writes.push({
          range: `${TAB}!${sheets.columnLetter(stCol)}${rowNum}`,
          values: [[`${reused ? 'DUBLIKAT' : 'OK'} ${tashkentNow()}`]],
        });
        yaratildi++;
      } catch (e) {
        await pool.query(
          `UPDATE sheet_lead_sync SET status = 'error', error = $1, claimed_at = NOW() - INTERVAL '1 hour'
            WHERE id = $2`,
          [e.message, claim.rows[0].id]
        );
        writes.push({
          range: `${TAB}!${sheets.columnLetter(stCol)}${rowNum}`,
          values: [[`XATO: ${e.message}`.slice(0, 500)]],
        });
        console.error(`[sheet-leads] ${rowKey}: ${e.message}`);
      }

      // Bitrix limiti 2 so'rov/sek
      await new Promise((r) => setTimeout(r, 600));
    }

    if (writes.length) await sheets.batchUpdateValues(SPREADSHEET_ID, writes);
    if (yaratildi) console.log(`[sheet-leads] ${yaratildi} ta yangi lead yaratildi`);
    return yaratildi;
  } catch (e) {
    console.error('[sheet-leads] poll error:', e.message);
    return 0;
  } finally {
    running = false;
  }
}

function tashkentNow() {
  return new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
}

function scheduleSheetLeadsPoll() {
  if (!SPREADSHEET_ID) {
    console.warn('[sheet-leads] SHEETS_LEADS_ID not set — Google Sheets lead sync disabled');
    return;
  }

  ensureSchema()
    .then(() => {
      setTimeout(() => { pollOnce().catch(() => {}); }, 15_000); // startupdan 15s keyin
      setInterval(() => { pollOnce().catch(() => {}); }, INTERVAL_SEC * 1000);
      console.log(`[sheet-leads] polling "${TAB}" every ${INTERVAL_SEC}s (sheet ${SPREADSHEET_ID.slice(0, 12)}…)`);
    })
    .catch((e) => console.error('[sheet-leads] schema migration failed:', e.message));
}

module.exports = { pollOnce, scheduleSheetLeadsPoll, ensureSchema, buildLeadFields, klasslarToIds };
