#!/usr/bin/env node
'use strict';

/**
 * "Leads" varag'idagi qatorlarni Bitrix'ga BIR MARTA yuborish (qo'lda).
 *
 * Poller'ning (src/sync/sheetLeads.js) o'sha maydon mapping'ini ishlatadi,
 * lekin baza band qilish qatlamisiz — servis hali ishga tushmagan paytda
 * yoki bir martalik to'ldirish uchun.
 *
 *   node scripts/sheet_leads_run_once.js          # yaratadi
 *   node scripts/sheet_leads_run_once.js --dry    # faqat ko'rsatadi, yaratmaydi
 *
 * Kerakli .env qiymatlari:
 *   BITRIX_WEBHOOK_URL, GOOGLE_CREDENTIALS_PATH, SHEETS_LEADS_ID, SHEETS_LEADS_TAB
 *
 * "Bitrix ID" ustuni to'lgan qator o'tkazib yuboriladi, shuning uchun ikki
 * marta yurgizsangiz ham dublikat bo'lmaydi.
 */

require('dotenv').config();

const sheets = require('../src/services/googleSheets');
const { bitrixPost } = require('../src/services/bitrix');
const { buildLeadFields } = require('../src/sync/sheetLeads');

const SPREADSHEET_ID = process.env.SHEETS_LEADS_ID;
const TAB = process.env.SHEETS_LEADS_TAB || 'Leads';
const DRY = process.argv.includes('--dry');

const headerKey = (h) => String(h || '').toLowerCase().replace(/\(.*?\)/g, '').trim();

async function main() {
  if (!SPREADSHEET_ID) throw new Error('.env da SHEETS_LEADS_ID yo\'q');

  const values = await sheets.getValues(SPREADSHEET_ID, TAB);
  if (values.length < 2) { console.log('Varaq bo\'sh'); return; }

  const headers = values[0].map(String);
  let idCol = headers.indexOf('Bitrix ID');
  let stCol = headers.indexOf('Holat');

  if (idCol === -1) { idCol = headers.length; headers.push('Bitrix ID'); }
  if (stCol === -1) { stCol = headers.length; headers.push('Holat'); }
  if (!DRY) await sheets.updateValues(SPREADSHEET_ID, `${TAB}!A1`, [headers]);

  const writes = [];
  let yaratildi = 0;

  for (let i = 1; i < values.length; i++) {
    const cells = values[i] || [];
    const rowNum = i + 1;

    if (cells.every((v) => v === '' || v === null || v === undefined)) continue;
    if (cells[idCol]) { console.log(`qator ${rowNum}: allaqachon #${cells[idCol]} — o'tkazildi`); continue; }

    const row = {};
    headers.forEach((h, idx) => { const k = headerKey(h); if (k) row[k] = cells[idx] !== undefined ? cells[idx] : ''; });

    try {
      const fields = await buildLeadFields(row);

      if (DRY) {
        console.log(`qator ${rowNum}:`, JSON.stringify(fields));
        continue;
      }

      const res = await bitrixPost('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, 'sheet-leads-manual');
      if (!res.result) throw new Error(res.error_description || res.error || JSON.stringify(res).slice(0, 200));

      const leadId = parseInt(res.result);
      const vaqt = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });

      writes.push({ range: `${TAB}!${sheets.columnLetter(idCol)}${rowNum}`, values: [[leadId]] });
      writes.push({ range: `${TAB}!${sheets.columnLetter(stCol)}${rowNum}`, values: [[`OK ${vaqt}`]] });

      console.log(`qator ${rowNum}: ${row.nom || row.telefon} → lead #${leadId}`);
      yaratildi++;
    } catch (e) {
      console.error(`qator ${rowNum}: XATO — ${e.message}`);
      writes.push({ range: `${TAB}!${sheets.columnLetter(stCol)}${rowNum}`, values: [[`XATO: ${e.message}`.slice(0, 500)]] });
    }

    await new Promise((r) => setTimeout(r, 700)); // Bitrix 2 so'rov/sek limiti
  }

  if (!DRY && writes.length) {
    const res = await sheets.batchUpdateValues(SPREADSHEET_ID, writes);
    console.log(`Varaqqa yozildi: ${res.totalUpdatedCells} ta katak`);
  }
  console.log(DRY ? '(--dry: hech narsa yaratilmadi)' : `Jami yaratildi: ${yaratildi}`);
}

main().catch((e) => { console.error('XATO:', e.message); process.exit(1); });
