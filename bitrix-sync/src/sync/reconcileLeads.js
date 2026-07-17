'use strict';

// Re-sync recently modified Bitrix leads so UTM tags populated AFTER lead
// creation get captured in our mirror. Native CRM-form connector leads are
// created first and get their UTM_CAMPAIGN filled a moment later by a Bitrix
// business process — if our ONCRMLEAD_ADD webhook fetched before that, the
// mirror keeps utm_campaign = NULL, which undercounts Kampaniyalar "Jami lid".
// A daily reconcile at 01:00 Tashkent (after the previous day fully closes)
// refreshes those leads. See leadCreated/leadUpdated webhooks for the live path.

const { fetchAll } = require('../services/bitrix');
const { upsertLead } = require('../services/upsertLead');

const LEAD_SELECT = [
  'ID', 'ASSIGNED_BY_ID', 'STATUS_ID', 'OPPORTUNITY', 'SOURCE_ID',
  'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
  'DATE_CREATE', 'DATE_MODIFY', 'NAME', 'LAST_NAME', 'TITLE', 'COMMENTS', 'PHONE', 'WEB_FORM_ID',
  'UF_CRM_1778261403182',
  'UF_CRM_1775825731211', 'UF_CRM_1778260858916', 'UF_CRM_1777030859057', 'UF_CRM_1778261535982',
  'UF_CRM_1775824803703', 'UF_CRM_1775825155935', 'UF_CRM_1770281264686',
  'UF_CRM_1770693781846', 'UF_CRM_1778310745831',
  'UF_CRM_1770976355232', 'UF_CRM_1770282341169',
];

let running = false;

async function reconcileRecentLeads(daysBack = 3) {
  if (running) { console.log('[reconcile-leads] already running, skip'); return 0; }
  running = true;
  try {
    const sinceMs = Date.now() - daysBack * 86400 * 1000;
    // Tashkent (UTC+5) local ISO without tz — Bitrix interprets in portal tz
    const t = new Date(sinceMs + 5 * 3600 * 1000);
    const since = `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}T00:00:00`;
    const leads = await fetchAll('crm.lead.list', { '>=DATE_MODIFY': since }, LEAD_SELECT);
    let n = 0;
    for (const r of leads) { await upsertLead(r); n++; }
    console.log(`[reconcile-leads] re-synced ${n} leads modified since ${since} (Tashkent)`);
    return n;
  } catch (e) {
    console.error('[reconcile-leads] error:', e.message);
    return 0;
  } finally {
    running = false;
  }
}

// ms until next 01:00 Asia/Tashkent (UTC+5, no DST)
function msUntilNext1AM() {
  const nowShifted = new Date(Date.now() + 5 * 3600 * 1000);
  const next = new Date(nowShifted);
  next.setUTCHours(1, 0, 0, 0);
  if (next <= nowShifted) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - nowShifted.getTime();
}

function scheduleDailyReconcile() {
  // Immediate run 90s after startup (catches leads with late-populated UTM now)
  setTimeout(() => { reconcileRecentLeads(3).catch(() => {}); }, 90_000);

  const arm = () => {
    setTimeout(() => {
      reconcileRecentLeads(3).catch(() => {});
      setInterval(() => reconcileRecentLeads(3).catch(() => {}), 24 * 3600 * 1000);
    }, msUntilNext1AM());
  };
  arm();
  console.log(`[reconcile-leads] daily reconcile scheduled at 01:00 Tashkent (next in ${Math.round(msUntilNext1AM()/60000)} min)`);
}

module.exports = { reconcileRecentLeads, scheduleDailyReconcile };
