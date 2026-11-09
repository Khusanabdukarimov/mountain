'use strict';

// Customer name + phone of a deal, taken from its Bitrix CONTACT.
//
// deal_phones has not been filled since 2026-06-26 (every newer deal has a contact but no
// phone row), so the deal tables showed "—" for the customer. Contacts are not mirrored as a
// whole; they are cached here as they are looked at: the first view of a deal fetches its
// contact from Bitrix (50 per request), later views read crm_contacts, and an entry older than
// CACHE_TTL_MS is re-read so an edited name / phone shows up within the hour. If Bitrix does
// not answer, the cached value (even a stale one) is served — a listing never fails because of it.

const pool = require('../db/pool');
const { bitrixPost } = require('./bitrix');

const CACHE_TTL_MS = 60 * 60 * 1000;
const PAGE = 50; // crm.contact.list returns at most 50 rows per call
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id         BIGINT PRIMARY KEY,
      name       TEXT,
      phone      TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  tableReady = true;
}

/** "Samariddin aka rukkola"; placeholder names such as "." or "-" count as no name. */
function fullName(c) {
  const name = [c.NAME, c.LAST_NAME].map(v => String(v || '').trim()).filter(Boolean).join(' ');
  return /[\p{L}\p{N}]/u.test(name) ? name : '';
}

/** The contact's first phone number as written in Bitrix. */
function firstPhone(c) {
  const p = (c.PHONE || []).map(x => String(x.VALUE || '').trim()).find(Boolean);
  return p || '';
}

/** Rows to store for the contacts Bitrix returned; ids it did not return are stored empty (deleted contact). */
function toRows(asked, returned) {
  const byId = new Map(returned.map(c => [Number(c.ID), c]));
  return asked.map(id => {
    const c = byId.get(id);
    return { id, name: c ? fullName(c) : '', phone: c ? firstPhone(c) : '' };
  });
}

async function fetchFromBitrix(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += PAGE) {
    const chunk = ids.slice(i, i + PAGE);
    if (i) await sleep(600); // Bitrix: 2 requests/sec
    const res = await bitrixPost('crm.contact.list',
      { filter: { ID: chunk }, select: ['ID', 'NAME', 'LAST_NAME', 'PHONE'] }, 'deal-contacts');
    if (!res || !Array.isArray(res.result)) throw new Error((res && (res.error_description || res.error)) || 'no result');
    rows.push(...toRows(chunk, res.result));
  }
  return rows;
}

/**
 * Map of contact id -> { name, phone } for the given ids (null / duplicates ignored).
 * Never throws: on any failure it returns whatever the cache holds.
 */
async function getContacts(contactIds) {
  const ids = [...new Set((contactIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT id, name, phone, (fetched_at > NOW() - make_interval(secs => $2)) AS fresh
         FROM crm_contacts WHERE id = ANY($1::bigint[])`, [ids, CACHE_TTL_MS / 1000]);
    const fresh = new Set();
    for (const r of rows) {
      out.set(Number(r.id), { name: r.name || '', phone: r.phone || '' });
      if (r.fresh) fresh.add(Number(r.id));
    }
    const todo = ids.filter(id => !fresh.has(id));
    if (!todo.length) return out;
    try {
      const got = await fetchFromBitrix(todo);
      for (const g of got) {
        await pool.query(
          `INSERT INTO crm_contacts (id, name, phone, fetched_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, fetched_at = NOW()`,
          [g.id, g.name, g.phone]);
        out.set(g.id, { name: g.name, phone: g.phone });
      }
    } catch (e) {
      console.error(`[deal-contacts] Bitrix read failed for ${todo.length} contact(s), serving the cache:`, e.message);
    }
  } catch (e) {
    console.error('[deal-contacts]', e.message);
  }
  return out;
}

module.exports = { getContacts, ensureTable, fullName, firstPhone, toRows };
