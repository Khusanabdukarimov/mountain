'use strict';

// One-time/import helper for active ads that have not generated a lead yet.
// Usage: node scripts/sync_active_creatives.js <ad-account-id> <campaign-id>
require('dotenv').config();
const axios = require('axios');
const pool = require('../src/db/pool');

const account = process.argv[2];
const campaignId = process.argv[3];
const token = process.env.META_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
const version = process.env.FB_API_VERSION || 'v21.0';
if (!account || !campaignId || !token) throw new Error('account, campaign-id and Meta token are required');

async function main() {
  const url = `https://graph.facebook.com/${version}/${campaignId}/ads`;
  const params = {
    access_token: token,
    fields: 'id,name,status,effective_status,adset{id,name},creative{id,name,thumbnail_url}',
    effective_status: '["ACTIVE"]',
    limit: 200,
  };
  const { data } = await axios.get(url, { params, timeout: 30000 });
  if (data.error) throw new Error(data.error.message);
  let count = 0;
  for (const ad of data.data || []) {
    if (ad.status !== 'ACTIVE' || ad.effective_status !== 'ACTIVE') continue;
    await pool.query(`
      INSERT INTO meta_active_creatives
        (ad_id, account_id, campaign_id, campaign_name, adset_id, adset_name, ad_name, creative_id, creative_name, status, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',NOW())
      ON CONFLICT (ad_id) DO UPDATE SET
        account_id=EXCLUDED.account_id, campaign_id=EXCLUDED.campaign_id,
        campaign_name=EXCLUDED.campaign_name, adset_id=EXCLUDED.adset_id,
        adset_name=EXCLUDED.adset_name, ad_name=EXCLUDED.ad_name,
        creative_id=EXCLUDED.creative_id, creative_name=EXCLUDED.creative_name,
        status='ACTIVE', synced_at=NOW()
    `, [
      ad.id, account, campaignId, 'AN-JiDDi || TOF || Broad || ABO || 30$ || UZB',
      ad.adset?.id || null, ad.adset?.name || null, ad.name || null,
      ad.creative?.id || null, ad.creative?.name || null,
    ]);
    await pool.query(`
      INSERT INTO meta_creative_cache
        (ad_id, creative_id, creative_name, thumbnail_url, ads_manager_url, synced_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (ad_id) DO UPDATE SET
        creative_id=EXCLUDED.creative_id,
        creative_name=EXCLUDED.creative_name,
        thumbnail_url=EXCLUDED.thumbnail_url,
        ads_manager_url=EXCLUDED.ads_manager_url,
        synced_at=NOW()
    `, [
      ad.id,
      ad.creative?.id || null,
      ad.creative?.name || null,
      ad.creative?.thumbnail_url || null,
      `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${account.replace(/^act_/, '')}&selected_ad_ids=${ad.id}`,
    ]);
    count++;
  }
  console.log(`synced ${count} active creatives`);
}

main().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
