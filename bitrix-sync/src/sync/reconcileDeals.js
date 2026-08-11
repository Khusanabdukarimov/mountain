'use strict';

// Re-sync recently modified Bitrix deals so ones whose ONCRMDEALADD/UPDATE
// webhook failed (e.g. Bitrix REST timeout) don't silently vanish from our
// mirror forever. Mirrors reconcileLeads.js — leads already had this safety
// net, deals didn't, which let deal_payments FK errors happen (a payment
// webhook for a deal we never synced 500s with "not present in table deals").
// A daily reconcile at 01:15 Tashkent (offset from the 01:00 lead reconcile
// so they don't hit Bitrix's REST API at the exact same second).

const { fetchAll } = require('../services/bitrix');
const { upsertDeal } = require('../services/upsertDeal');

const DEAL_SELECT = [
  'ID', 'ASSIGNED_BY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
  'SOURCE_ID', 'UTM_SOURCE', 'DATE_CREATE', 'DATE_MODIFY', 'CLOSEDATE', 'BEGINDATE',
  'UF_CRM_69EBC105EAA93', 'UF_CRM_1779450406', 'UF_CRM_1779450159', 'CONTACT_ID',
  'UF_CRM_69FEFD2D71544', 'UF_CRM_10_1780604989', 'UF_CRM_1780643524', 'UF_CRM_1780643502',
  'UF_CRM_69D8F7169A174', 'LEAD_ID', 'CATEGORY_ID',
];

let running = false;

async function reconcileRecentDeals(daysBack = 3) {
  if (running) { console.log('[reconcile-deals] already running, skip'); return 0; }
  running = true;
  try {
    const sinceMs = Date.now() - daysBack * 86400 * 1000;
    // Tashkent (UTC+5) local ISO without tz — Bitrix interprets in portal tz
    const t = new Date(sinceMs + 5 * 3600 * 1000);
    const since = `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}T00:00:00`;
    const deals = await fetchAll('crm.deal.list', { '>=DATE_MODIFY': since }, DEAL_SELECT, 'reconcile-deals');
    let n = 0;
    for (const r of deals) { await upsertDeal(r); n++; }
    console.log(`[reconcile-deals] re-synced ${n} deals modified since ${since} (Tashkent)`);
    return n;
  } catch (e) {
    console.error('[reconcile-deals] error:', e.message);
    return 0;
  } finally {
    running = false;
  }
}

// ms until next 01:15 Asia/Tashkent (UTC+5, no DST)
function msUntilNext115AM() {
  const nowShifted = new Date(Date.now() + 5 * 3600 * 1000);
  const next = new Date(nowShifted);
  next.setUTCHours(1, 15, 0, 0);
  if (next <= nowShifted) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - nowShifted.getTime();
}

function scheduleDailyReconcile() {
  // Immediate run 90s after startup
  setTimeout(() => { reconcileRecentDeals(3).catch(() => {}); }, 90_000);

  const arm = () => {
    setTimeout(() => {
      reconcileRecentDeals(3).catch(() => {});
      setInterval(() => reconcileRecentDeals(3).catch(() => {}), 24 * 3600 * 1000);
    }, msUntilNext115AM());
  };
  arm();
  console.log(`[reconcile-deals] daily reconcile scheduled at 01:15 Tashkent (next in ${Math.round(msUntilNext115AM()/60000)} min)`);
}

module.exports = { reconcileRecentDeals, scheduleDailyReconcile };
