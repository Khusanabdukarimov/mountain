'use strict';

// Import active ads from one Meta account so creatives with no leads yet still
// appear in Mountain's Creative tab.
// Usage: node scripts/sync_account_active_creatives.js <account-id> [since]
require('dotenv').config();
const axios = require('axios');
const pool = require('../src/db/pool');

const account = process.argv[2];
const since = process.argv[3] || '2026-09-01T00:00:00+0000';
const token = process.env.META_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
const version = process.env.FB_API_VERSION || 'v21.0';
if (!account || !token) throw new Error('account-id and Meta token are required');

async function fetchAll(url, params) {
  const out = [];
  let next = url;
  let query = params;
  while (next) {
    const { data } = await axios.get(next, { params: query, timeout: 30000 });
    if (data.error) throw new Error(data.error.message);
    out.push(...(data.data || []));
    next = data.paging?.next || null;
    query = undefined;
  }
  return out;
}

async function main() {
  const acct = account.startsWith('act_') ? account : `act_${account}`;
  const ads = await fetchAll(`https://graph.facebook.com/${version}/${acct}/ads`, {
    access_token: token,
    fields: 'id,name,status,effective_status,created_time,updated_time,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url}',
    limit: 200,
  });
  const active = ads.filter(ad =>
    ad.created_time >= since &&
    ad.status === 'ACTIVE' &&
    ad.effective_status === 'ACTIVE'
  );

  for (const ad of active) {
    const campaignName = ad.campaign?.name || 'N/A';
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
      ad.id, acct, ad.campaign?.id || null, campaignName,
      ad.adset?.id || null, ad.adset?.name || null, ad.name || null,
      ad.creative?.id || null, ad.creative?.name || null,
    ]);

    await pool.query(`
      INSERT INTO meta_creative_cache
        (ad_id, creative_id, creative_name, thumbnail_url, ads_manager_url, synced_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (ad_id) DO UPDATE SET
        creative_id=EXCLUDED.creative_id, creative_name=EXCLUDED.creative_name,
        thumbnail_url=EXCLUDED.thumbnail_url,
        ads_manager_url=EXCLUDED.ads_manager_url, synced_at=NOW()
    `, [
      ad.id, ad.creative?.id || null, ad.creative?.name || null,
      ad.creative?.thumbnail_url || null,
      `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${acct.replace(/^act_/, '')}&selected_ad_ids=${ad.id}`,
    ]);
  }

  console.log(`imported ${active.length} active creatives from ${acct}`);
  for (const ad of active) console.log(`- ${ad.name} | ${ad.campaign?.name || 'N/A'}`);
}

main().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
