'use strict';

const pool = require('../db/pool');

// Only lead-gen ads feed the Creative tab (it reports lead quality per ad).
const LEAD_OBJECTIVES = new Set(['OUTCOME_LEADS', 'LEAD_GENERATION']);
// An ad that has produced no lead yet is listed only while it is still new, so
// long-running legacy ads do not clutter the tab. Ads we already list stay
// listed for as long as they are active, whatever their age.
const NEW_AD_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * Mirror one ad account's currently running lead-gen ads into
 * meta_active_creatives, so the Creative tab lists them before their first lead
 * arrives (facebook_leads only knows ads that already produced a lead).
 *
 * @param {string}        acct      'act_123…'
 * @param {object[]}      ads       /{acct}/ads rows already restricted to effective_status=ACTIVE,
 *                                  with campaign{id,name,objective}, adset{id,name}, creative{id,name}
 * @param {string[]|null} whitelist campaign ids allowed for this account, null = all
 * @returns {Promise<{upserted: number, deactivated: number}>}
 */
async function syncActiveCreatives(acct, ads, whitelist = null, now = Date.now()) {
  const { rows: known } = await pool.query('SELECT ad_id FROM meta_active_creatives');
  const knownIds = new Set(known.map(r => r.ad_id));

  const wanted = ads.filter(ad =>
    LEAD_OBJECTIVES.has(ad.campaign?.objective) &&
    (!whitelist || whitelist.includes(ad.campaign?.id)) &&
    (knownIds.has(ad.id) || now - Date.parse(ad.created_time) <= NEW_AD_WINDOW_MS)
  );

  for (const ad of wanted) {
    await pool.query(`
      INSERT INTO meta_active_creatives
        (ad_id, account_id, campaign_id, campaign_name, adset_id, adset_name,
         ad_name, creative_id, creative_name, status, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',NOW())
      ON CONFLICT (ad_id) DO UPDATE SET
        account_id=EXCLUDED.account_id, campaign_id=EXCLUDED.campaign_id,
        campaign_name=EXCLUDED.campaign_name, adset_id=EXCLUDED.adset_id,
        adset_name=EXCLUDED.adset_name, ad_name=EXCLUDED.ad_name,
        creative_id=EXCLUDED.creative_id, creative_name=EXCLUDED.creative_name,
        status='ACTIVE', synced_at=NOW()
    `, [
      ad.id, acct, ad.campaign?.id || null, ad.campaign?.name || 'N/A',
      ad.adset?.id || null, ad.adset?.name || null, ad.name || null,
      ad.creative?.id || null, ad.creative?.name || null,
    ]);
  }

  // Ads that are no longer active on Meta drop out of the tab. Compared against
  // every ACTIVE ad of the account, not just the ones we list, so an ad is never
  // deactivated for failing a filter. Rows imported by hand may carry the
  // account id with or without the "act_" prefix.
  const bare = acct.replace(/^act_/, '');
  const { rowCount } = await pool.query(`
    UPDATE meta_active_creatives SET status = 'INACTIVE', synced_at = NOW()
    WHERE status = 'ACTIVE'
      AND account_id = ANY($1::text[])
      AND NOT (ad_id = ANY($2::text[]))
  `, [[acct, bare], ads.map(ad => ad.id)]);

  return { upserted: wanted.length, deactivated: rowCount };
}

module.exports = { syncActiveCreatives };
