'use strict';

// Creates a Bitrix lead for every Meta lead-form submission that has none.
//
// Submissions reach facebook_leads through the 5-minute Meta sync (campaigns.js
// syncAllLeads; Meta's own webhook has never delivered here). Every minute this picks
// up the ones that have no Bitrix lead after a short grace period — Bitrix's lead-form
// connector makes its lead within seconds, so a submission still without one after
// FB_LEAD_GRACE_SEC was missed (connector disconnected, outage, new form not wired up).
// ensureLeadForSubmission re-checks Bitrix per phone, so a lead the connector made is
// linked, never duplicated. Created leads go through the normal distribution.
//
// Off with FB_AUTO_CREATE_LEADS=false.

const pool = require('../db/pool');
const { ensureLeadForSubmission, tash } = require('../services/facebookLeadCreator');

const INTERVAL_SEC = parseInt(process.env.FB_LEAD_POLL_SEC || '60', 10);
const GRACE_SEC = parseInt(process.env.FB_LEAD_GRACE_SEC || '120', 10);
const LOOKBACK_H = parseInt(process.env.FB_LEAD_LOOKBACK_H || '6', 10);   // older ones are the manual script's job
const PER_RUN = parseInt(process.env.FB_LEAD_PER_RUN || '20', 10);
const MAX_ATTEMPTS = 5;

let running = false;
const attempts = new Map(); // facebook lead id → failed tries since this process started

async function pollOnce() {
  if (running) return 0; // the previous run is still going
  running = true;
  let created = 0;
  try {
    const { rows } = await pool.query(
      `SELECT fl.id, fl.form_id, fl.full_name, fl.phone, fl.platform, fl.is_organic, fl.created_time,
              fl.campaign_name, fl.adset_name, fl.ad_name, fl.field_data, fl.bitrix_lead_id
         FROM facebook_leads fl
        WHERE fl.bitrix_lead_id IS NULL
          AND LENGTH(fl.phone_norm) >= 9
          AND fl.created_time >= NOW() - make_interval(hours => $1)
          AND fl.created_time <= NOW() - make_interval(secs => $2)
          AND NOT EXISTS (SELECT 1 FROM facebook_leads_excluded x WHERE x.id = fl.id)
        ORDER BY fl.created_time
        LIMIT $3`, [LOOKBACK_H, GRACE_SEC, PER_RUN]);

    for (const fl of rows) {
      if ((attempts.get(fl.id) || 0) >= MAX_ATTEMPTS) continue;
      const label = `FB lead ${fl.id} (form ${fl.form_id}, ${tash(fl.created_time)})`;
      try {
        const r = await ensureLeadForSubmission(fl);
        if (r.status === 'created') {
          created++;
          console.log(`[facebook-leads] Bitrix lead #${r.leadId} created for ${label}${r.reason ? ` — ${r.reason}` : ''}`);
          if (r.unmapped && r.unmapped.length) console.warn(`[facebook-leads] ${label}: answers with no field configured went to COMMENTS — add form ${fl.form_id} to FORMS in services/facebookLeadCreator.js`);
        } else if (r.status === 'linked') {
          console.log(`[facebook-leads] ${label}: linked to ${r.reason}`);
        } else if (r.status === 'failed') {
          attempts.set(fl.id, (attempts.get(fl.id) || 0) + 1);
          console.error(`[facebook-leads] ${label}: create failed (${attempts.get(fl.id)}/${MAX_ATTEMPTS}): ${r.reason}`);
        }
      } catch (e) {
        // Bitrix unreachable / timed out: stop this run, the same rows are retried next minute
        // (a lead that did get created before the timeout is found by the phone check then)
        attempts.set(fl.id, (attempts.get(fl.id) || 0) + 1);
        console.error(`[facebook-leads] ${label}: ${e.message} — stopping this run`);
        break;
      }
    }
  } catch (e) {
    console.error('[facebook-leads] poll error:', e.message);
  } finally {
    running = false;
  }
  return created;
}

function scheduleFacebookLeadCreation() {
  if (process.env.FB_AUTO_CREATE_LEADS === 'false') {
    console.warn('[facebook-leads] FB_AUTO_CREATE_LEADS=false — automatic lead creation from Meta forms is off');
    return;
  }
  if (!process.env.BITRIX_WEBHOOK_URL) {
    console.warn('[facebook-leads] BITRIX_WEBHOOK_URL not set — automatic lead creation from Meta forms is off');
    return;
  }
  setTimeout(() => { pollOnce().catch(() => {}); }, 45_000); // after the first Meta sync (30 s)
  setInterval(() => { pollOnce().catch(() => {}); }, INTERVAL_SEC * 1000);
  console.log(`[facebook-leads] creating Bitrix leads for Meta form submissions without one: every ${INTERVAL_SEC}s, after ${GRACE_SEC}s grace, last ${LOOKBACK_H}h`);
}

module.exports = { pollOnce, scheduleFacebookLeadCreation };
