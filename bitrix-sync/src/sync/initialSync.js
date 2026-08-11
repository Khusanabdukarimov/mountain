/**
 * One-time initial sync: imports all leads, deals, and users from Bitrix24.
 * Run once: node src/sync/initialSync.js
 * Safe to re-run — all upserts use ON CONFLICT DO UPDATE.
 */
require('dotenv').config();
const pool = require('../db/pool');
const { fetchAll } = require('../services/bitrix');
const { upsertLead } = require('../services/upsertLead');
const { upsertDeal } = require('../services/upsertDeal');
const { loadAll: loadStages } = require('../services/stageResolver');

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

const DEAL_SELECT = [
  'ID', 'ASSIGNED_BY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
  'SOURCE_ID', 'UTM_SOURCE', 'DATE_CREATE', 'DATE_MODIFY', 'CLOSEDATE', 'BEGINDATE',
  'UF_CRM_69EBC105EAA93', 'UF_CRM_1779450406', 'UF_CRM_1779450159', 'CONTACT_ID',
  'UF_CRM_69FEFD2D71544', 'UF_CRM_10_1780604989', 'UF_CRM_1780643524', 'UF_CRM_1780643502',
  'UF_CRM_69D8F7169A174', 'LEAD_ID',
];

async function syncUsers() {
  console.log('[sync] Fetching users...');
  const users = await fetchAll('user.get', { ACTIVE: 'Y' }, [], 'initial-sync');
  console.log(`[sync] Got ${users.length} users`);

  for (const u of users) {
    await pool.query(
      `INSERT INTO responsibles (id, name, last_name, email, work_position, active, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         last_name = EXCLUDED.last_name,
         email = EXCLUDED.email,
         work_position = EXCLUDED.work_position,
         active = EXCLUDED.active,
         synced_at = NOW()`,
      [
        parseInt(u.ID),
        u.NAME || null,
        u.LAST_NAME || null,
        u.EMAIL || null,
        u.WORK_POSITION || null,
        u.ACTIVE === 'Y' || u.ACTIVE === true,
      ]
    );
  }

  await pool.query(
    `INSERT INTO sync_state (entity, last_sync, total_rows)
     VALUES ('users', NOW(), $1)
     ON CONFLICT (entity) DO UPDATE SET last_sync = NOW(), total_rows = $1`,
    [users.length]
  );

  console.log(`[sync] Users done: ${users.length} upserted`);
}

async function syncLeads() {
  console.log('[sync] Fetching leads...');
  const leads = await fetchAll('crm.lead.list', {}, LEAD_SELECT, 'initial-sync');
  console.log(`[sync] Got ${leads.length} leads, upserting...`);

  let count = 0;
  for (const r of leads) {
    await upsertLead(r);
    count++;
    if (count % 500 === 0) {
      console.log(`[sync] Leads progress: ${count}/${leads.length}`);
    }
  }

  await pool.query(
    `INSERT INTO sync_state (entity, last_sync, total_rows)
     VALUES ('leads', NOW(), $1)
     ON CONFLICT (entity) DO UPDATE SET last_sync = NOW(), total_rows = $1`,
    [leads.length]
  );

  console.log(`[sync] Leads done: ${leads.length} upserted`);
}

async function syncDeals() {
  console.log('[sync] Fetching deals...');
  const deals = await fetchAll('crm.deal.list', {}, DEAL_SELECT, 'initial-sync');
  console.log(`[sync] Got ${deals.length} deals, upserting...`);

  let count = 0;
  for (const r of deals) {
    await upsertDeal(r);
    count++;
    if (count % 500 === 0) {
      console.log(`[sync] Deals progress: ${count}/${deals.length}`);
    }
  }

  await pool.query(
    `INSERT INTO sync_state (entity, last_sync, total_rows)
     VALUES ('deals', NOW(), $1)
     ON CONFLICT (entity) DO UPDATE SET last_sync = NOW(), total_rows = $1`,
    [deals.length]
  );

  console.log(`[sync] Deals done: ${deals.length} upserted`);
}

async function syncContacts() {
  console.log('[sync] Fetching contacts...');
  const contacts = await fetchAll('crm.contact.list', {}, ['ID', 'PHONE'], 'initial-sync');
  console.log(`[sync] Got ${contacts.length} contacts, upserting...`);

  await pool.query('DELETE FROM contact_phones');

  for (const c of contacts) {
    if (c.PHONE && Array.isArray(c.PHONE)) {
      for (const p of c.PHONE) {
        const phone = p.VALUE;
        if (phone) {
          await pool.query(
            `INSERT INTO contact_phones (contact_id, phone)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [parseInt(c.ID), phone]
          );
        }
      }
    }
  }

  await pool.query(
    `INSERT INTO sync_state (entity, last_sync, total_rows)
     VALUES ('contacts', NOW(), $1)
     ON CONFLICT (entity) DO UPDATE SET last_sync = NOW(), total_rows = $1`,
    [contacts.length]
  );

  console.log(`[sync] Contacts done: ${contacts.length} synced`);
}

async function main() {
  console.log('=== Bitrix24 Initial Sync ===');
  console.log('Loading stages...');
  await loadStages();

  await syncUsers();
  await syncLeads();
  await syncDeals();
  await syncContacts();

  console.log('[sync] Populating deal_phones from contact_phones...');
  await pool.query('DELETE FROM deal_phones');
  await pool.query(`
    INSERT INTO deal_phones (deal_id, phone)
    SELECT DISTINCT d.id, cp.phone
    FROM deals d
    JOIN contact_phones cp ON cp.contact_id = d.contact_id
    ON CONFLICT DO NOTHING
  `);
  console.log('[sync] deal_phones populated successfully');

  const { rows } = await pool.query('SELECT entity, total_rows, last_sync FROM sync_state ORDER BY entity');
  console.log('\n=== Sync complete ===');
  rows.forEach((r) => console.log(`  ${r.entity}: ${r.total_rows} rows (${r.last_sync.toISOString()})`));

  await pool.end();
}

main().catch((err) => {
  console.error('[sync] Fatal error:', err);
  process.exit(1);
});
