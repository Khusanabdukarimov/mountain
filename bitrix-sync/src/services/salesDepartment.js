'use strict';

// "SOTUV BO'LIMI" scope for the Lidlar and Sdelkalar pages.
//
// Those two pages show only the leads / deals whose responsible belongs to the sales
// department, and their "Mas'ul" filter lists only its members. The members are stored
// in `sales_department_members` (a plain list of responsible ids, edited by hand): the
// Bitrix webhook has no `department` permission, so the org chart cannot be read from
// Bitrix. Seed: the three Bitrix departments of the sales team — 2 (Samandar, Shahzod M.,
// Temurmalik), 36 (Muhriddin, Muhammadsodiq, Davlatyor, Azizjon N., Rahmatillo) and 52
// (Shahzod Yormamatov).
//
// The pages opt in with `?dept=sotuv` (the frontend adds it on those two routes), so the
// same endpoints keep serving every other page unrestricted. The middleware below turns
// the scope into the `responsible_id` filter these endpoints already understand (a list,
// intersected with whatever the user picked in the filter) and exposes the member list as
// `req.deptIds` for the endpoints that have no responsible filter of their own.

const pool = require('../db/pool');

const SCOPE = 'sotuv';
const DEFAULT_MEMBERS = [12, 14, 16, 18, 20, 22, 32, 74, 106];
const CACHE_TTL_MS = 10_000;

// Endpoints whose `responsible_id` query parameter is a comma list matched against the
// lead's / deal's responsible. (responsible-leads is NOT here: its responsible_id is the
// row key of a drill-down, not a filter.)
const RESPONSIBLE_FILTER_ROUTES = new Set([
  '/lead-stats', '/lead-responsibles', '/lead-conversion', '/cancel-reasons', '/junk-reasons',
  '/deal-cancel-reasons', '/deals-stats', '/deals-list', '/deals-conversion', '/deals-responsibles',
  '/deals-source-stats', '/source-stats', '/form-stats',
]);

let cache = { at: -Infinity, ids: DEFAULT_MEMBERS };

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS sales_department_members (responsible_id BIGINT PRIMARY KEY)`);
  // seeded once, on an empty table: after that the list is whatever was saved
  await pool.query(
    `INSERT INTO sales_department_members (responsible_id)
     SELECT x FROM unnest($1::bigint[]) AS x
      WHERE NOT EXISTS (SELECT 1 FROM sales_department_members)
     ON CONFLICT DO NOTHING`, [DEFAULT_MEMBERS]);
}

async function getMemberIds() {
  if (Date.now() - cache.at > CACHE_TTL_MS) {
    try {
      const { rows } = await pool.query('SELECT responsible_id FROM sales_department_members ORDER BY responsible_id');
      if (rows.length) cache.ids = rows.map(r => Number(r.responsible_id));
    } catch (_) { /* table not created yet or a DB blip: keep the last known list */ }
    cache.at = Date.now();
  }
  return cache.ids;
}

/** The responsible ids a request may see once `?responsible_id=` (if any) is applied. */
function restrictResponsibleIds(requested, memberIds) {
  const asked = String(requested || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!asked.length) return memberIds.join(',');
  const allowed = new Set(memberIds.map(String));
  const kept = asked.filter(id => allowed.has(id));
  return kept.length ? kept.join(',') : '0'; // nobody asked for is in the department: match nothing
}

/** Express middleware: applies the scope to the requests that carry ?dept=sotuv. */
async function departmentScope(req, res, next) {
  if (req.query.dept !== SCOPE) return next();
  const ids = await getMemberIds();
  req.deptIds = ids;
  if (RESPONSIBLE_FILTER_ROUTES.has(req.path)) {
    req.query.responsible_id = restrictResponsibleIds(req.query.responsible_id, ids);
  }
  next();
}

/** For `$n::text IS NULL OR … = ANY(string_to_array($n, ','))`: the member list, or null when unscoped. */
const deptCsv = req => (req.deptIds ? req.deptIds.join(',') : null);

module.exports = { departmentScope, deptCsv, ensureTable, getMemberIds, restrictResponsibleIds, DEFAULT_MEMBERS, SCOPE };
