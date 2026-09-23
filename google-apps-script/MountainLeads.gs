/**
 * Mountain — "Leads" varag'idan Bitrix24 ga lead yuborish.
 * Bitta o'zi-yetarli fayl: Google Sheets → Extensions → Apps Script → Code.gs
 * ichiga to'liq nusxa ko'chiring. Boshqa fayl kerak emas.
 *
 * SOZLASH (bir marta):
 *   1. Apps Script → Project Settings → Script Properties → Add script property
 *        BITRIX_WEBHOOK = https://mountain.bitrix24.kz/rest/<user>/<token>/
 *   2. Saqlang, varaqni yangilang → yuqorida "Bitrix" menyusi chiqadi.
 *
 * ISHLATISH:
 *   Bitrix → Yangi leadlarni yuborish
 *   "Bitrix ID" ustuni bo'sh qatorlar yuboriladi. ID yozilgan qator qayta
 *   yuborilmaydi — tugmani necha marta bossangiz ham dublikat bo'lmaydi.
 */

// ═════════════════════════════════════════════════════════════════════════════
// SOZLAMALAR
// ═════════════════════════════════════════════════════════════════════════════

var SHEET_NAME = 'Leads';

/** Natija yoziladigan ustunlar — varaqda bo'lmasa avtomatik qo'shiladi. */
var COL_BITRIX_ID = 'Bitrix ID';
var COL_HOLAT     = 'Holat';

/** Bitrix maydon kodlari (2026-09-18 da crm.lead.fields orqali tekshirilgan). */
var F_BREND_NOMI = 'UF_CRM_1775824743431'; // "Brend nomi"          string
var F_TELEFON    = 'UF_CRM_1778261403182'; // "Telefon raqamingiz"  string
var F_KLASSLAR   = 'UF_CRM_1775826267500'; // "Klasslari"           enumeration[] 1..45
var F_BYUDJET    = 'UF_CRM_BYUDJET';       // "Byudjet"             string

/**
 * "Mijoz" ustuni qayerga yozilsin:
 *   'NAME'          — mijozning ismi
 *   'COMPANY_TITLE' — kompaniya nomi
 */
var F_MIJOZ = 'NAME';

// ═════════════════════════════════════════════════════════════════════════════
// MENYU
// ═════════════════════════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bitrix')
    .addItem('Yangi leadlarni yuborish', 'sendNewLeads')
    .addSeparator()
    .addItem("Klasslar ro'yxatini ko'rish", 'showKlassMap')
    .addItem('Maydonlarni tekshirish', 'checkRequiredFields')
    .addItem("Barcha UF maydonlarni to'kish", 'dumpLeadUfFields')
    .addToUi();
}

// ═════════════════════════════════════════════════════════════════════════════
// BITRIX CHAQIRUVI
// ═════════════════════════════════════════════════════════════════════════════

function bitrixCall_(method, payload) {
  var base = PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK');
  if (!base) throw new Error("Script Properties da BITRIX_WEBHOOK yo'q");

  var res = UrlFetchApp.fetch(base.replace(/\/+$/, '') + '/' + method + '.json', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });

  var body = JSON.parse(res.getContentText());
  if (body.error) throw new Error(method + ': ' + (body.error_description || body.error));
  return body.result;
}

// ═════════════════════════════════════════════════════════════════════════════
// KLASSLAR: oddiy raqam → Bitrix enum item ID
// ═════════════════════════════════════════════════════════════════════════════

var klassMapCache_ = null;

/**
 * "Klasslari" maydoni enumeration — "35" emas, o'sha variantning ID si
 * yuborilishi kerak. Ro'yxat Bitrix dan o'qiladi, kodda qotirilmagan:
 *   { "1": "292", "2": "294", ..., "35": "360", ..., "45": "380" }
 */
function getKlassMap_() {
  if (klassMapCache_) return klassMapCache_;

  var field = bitrixCall_('crm.lead.fields')[F_KLASSLAR];
  if (!field) throw new Error('Bitrix da ' + F_KLASSLAR + ' ("Klasslari") topilmadi');

  var map = {};
  (field.items || []).forEach(function (item) {
    map[String(item.VALUE).trim()] = String(item.ID);
  });

  klassMapCache_ = map;
  return map;
}

/**
 * Katakdagi matnni enum ID lar massiviga aylantiradi.
 *   35        → ["360"]
 *   "35, 37"  → ["360", "364"]
 *   "35 37 41" ham ishlaydi (vergul, nuqta-vergul, probel, slash).
 */
function klasslarToIds_(cell) {
  if (cell === '' || cell === null || cell === undefined) return [];

  var map = getKlassMap_();
  var ids = [];
  var topilmadi = [];

  String(cell).split(/[,;/\s]+/).forEach(function (part) {
    var raw = part.trim();
    if (!raw) return;
    var n = String(parseInt(raw, 10)); // " 35 " va "35.0" ni normallaymiz
    if (map[n]) ids.push(map[n]);
    else topilmadi.push(raw);
  });

  if (topilmadi.length) {
    throw new Error('Klass topilmadi: ' + topilmadi.join(', ') + ' (ruxsat etilgani 1..45)');
  }
  return ids;
}

/** Menyu: klass → ID jadvalini ko'rsatadi. */
function showKlassMap() {
  var map = getKlassMap_();
  var lines = Object.keys(map)
    .sort(function (a, b) { return a - b; })
    .map(function (k) { return 'klass ' + k + '  →  item ID ' + map[k]; });
  SpreadsheetApp.getUi().alert('Klasslari (' + lines.length + ' ta)\n\n' + lines.join('\n'));
}

// ═════════════════════════════════════════════════════════════════════════════
// QATOR → BITRIX FIELDS
// ═════════════════════════════════════════════════════════════════════════════

/** "Sana (Toshkent)" → "sana" — sarlavhani solishtirish uchun kalitga aylantiradi. */
function headerKey_(h) {
  return String(h).toLowerCase().replace(/\(.*?\)/g, '').trim();
}

/**
 * Bitta qatordan crm.lead.add uchun fields obyektini yig'adi.
 * row — { nom: 'Forest', mijoz: '...', telefon: '...', klasslar: 35, ... }
 */
function buildLeadFields_(row) {
  var fields = {};

  // Nom → lid sarlavhasi va "Brend nomi"
  if (row.nom) {
    fields.TITLE = String(row.nom).trim();
    fields[F_BREND_NOMI] = String(row.nom).trim();
  }

  // Mijoz
  if (row.mijoz) fields[F_MIJOZ] = String(row.mijoz).trim();

  // Telefon: standart PHONE va forma maydoni — ikkalasiga ham
  if (row.telefon) {
    var phone = String(row.telefon).trim();
    fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }];
    fields[F_TELEFON] = phone;
  }

  // Klasslar: raqam → enum ID
  var klassIds = klasslarToIds_(row.klasslar);
  if (klassIds.length) fields[F_KLASSLAR] = klassIds;

  // Narx + Valyuta → "Byudjet" (string), masalan "9000 USD"
  if (row.narx !== '' && row.narx !== null && row.narx !== undefined) {
    var narx = String(row.narx).trim();
    var valyuta = row.valyuta ? String(row.valyuta).trim() : '';
    fields[F_BYUDJET] = valyuta ? narx + ' ' + valyuta : narx;
  }

  // Manba: "instagram / cpc / bahor" → UTM uchligi
  if (row.manba) {
    var p = String(row.manba).split('/').map(function (s) { return s.trim(); });
    if (p[0]) fields.UTM_SOURCE = p[0];
    if (p[1]) fields.UTM_MEDIUM = p[1];
    if (p[2]) fields.UTM_CAMPAIGN = p[2];
  }

  if (!fields.TITLE) fields.TITLE = fields[F_TELEFON] || 'Sheets lead';
  return fields;
}

// ═════════════════════════════════════════════════════════════════════════════
// ASOSIY: varaqni o'qib, yangi leadlarni yuborish
// ═════════════════════════════════════════════════════════════════════════════

function sendNewLeads() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('"' + SHEET_NAME + "\" varag'i topilmadi");

  var lastRow = sh.getLastRow();
  if (lastRow < 2) { ui.alert("Varaq bo'sh"); return; }

  // Natija ustunlari bo'lmasa — qo'shamiz
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf(COL_BITRIX_ID) + 1;
  var stCol = headers.indexOf(COL_HOLAT) + 1;

  if (!idCol) {
    idCol = headers.length + 1;
    sh.getRange(1, idCol).setValue(COL_BITRIX_ID).setFontWeight('bold');
    headers.push(COL_BITRIX_ID);
  }
  if (!stCol) {
    stCol = headers.length + 1;
    sh.getRange(1, stCol).setValue(COL_HOLAT).setFontWeight('bold');
    headers.push(COL_HOLAT);
  }

  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var yuborildi = 0, xato = 0, otkazildi = 0;

  for (var i = 0; i < data.length; i++) {
    var values = data[i];
    var rowNum = i + 2;

    // Allaqachon yuborilgan yoki butunlay bo'sh qator
    var bosh = values.every(function (v) { return v === '' || v === null; });
    if (values[idCol - 1] || bosh) { otkazildi++; continue; }

    // Sarlavhalar bo'yicha { kalit: qiymat }
    var row = {};
    headers.forEach(function (h, idx) {
      var key = headerKey_(h);
      if (key) row[key] = values[idx];
    });

    try {
      var leadId = bitrixCall_('crm.lead.add', {
        fields: buildLeadFields_(row),
        params: { REGISTER_SONET_EVENT: 'Y' },
      });
      sh.getRange(rowNum, idCol).setValue(leadId);
      sh.getRange(rowNum, stCol).setValue(
        'OK ' + Utilities.formatDate(new Date(), 'Asia/Tashkent', 'dd.MM.yyyy HH:mm')
      );
      yuborildi++;
    } catch (e) {
      sh.getRange(rowNum, stCol).setValue('XATO: ' + e.message);
      xato++;
    }

    Utilities.sleep(600); // Bitrix limiti 2 so'rov/sek
  }

  ui.alert('Tayyor\n\nYuborildi: ' + yuborildi +
           '\nXato: ' + xato +
           "\nO'tkazib yuborildi: " + otkazildi);
}

// ═════════════════════════════════════════════════════════════════════════════
// TEKSHIRUV
// ═════════════════════════════════════════════════════════════════════════════

/** Skript ishlatadigan maydonlar Bitrix da bor-yo'qligini tekshiradi. */
function checkRequiredFields() {
  var kerak = {};
  kerak[F_BREND_NOMI] = 'Brend nomi';
  kerak[F_TELEFON]    = 'Telefon raqamingiz';
  kerak[F_KLASSLAR]   = 'Klasslari';
  kerak[F_BYUDJET]    = 'Byudjet';

  var fields = bitrixCall_('crm.lead.fields');
  var lines = Object.keys(kerak).map(function (code) {
    var f = fields[code];
    return (f ? "BOR   " : "YO'Q  ") + code + ' — ' + kerak[code] +
           (f ? '  [' + f.type + (f.isMultiple ? '[]' : '') + ']' : '');
  });

  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

/** Portaldagi BARCHA lead UF_CRM maydonlarini "UF fields" varag'iga to'kadi. */
function dumpLeadUfFields() {
  var fields = bitrixCall_('crm.lead.fields');
  var rows = [['KOD', 'TURI', 'NOMI', 'MAJBURIY', "KO'P QIYMATLI", 'ENUM ITEMS (ID=VALUE)']];

  Object.keys(fields).sort().forEach(function (code) {
    if (code.indexOf('UF_CRM') !== 0) return;
    var f = fields[code];
    rows.push([
      code,
      f.type + (f.isMultiple ? '[]' : ''),
      f.formLabel || f.title || f.listLabel || '',
      f.isRequired ? 'ha' : '',
      f.isMultiple ? 'ha' : '',
      (f.items || []).map(function (i) { return i.ID + '=' + i.VALUE; }).join(' | '),
    ]);
  });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('UF fields') || ss.insertSheet('UF fields');
  sh.clear();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, rows[0].length);
  SpreadsheetApp.getUi().alert('Jami ' + (rows.length - 1) + " ta UF_CRM maydon 'UF fields' varag'iga yozildi");
}
