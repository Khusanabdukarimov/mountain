const pool = require('../db/pool');
const { bitrixCall } = require('./bitrix');
const { getStatus: getSubscriptionStatus } = require('../middleware/subscription');

/**
 * Distribute a new lead to the responsible with the largest deficit.
 *
 * Algorithm: Largest Deficit First
 *   deficit = (target_pct / 100) * (totalToday + 1) - actual_count
 *   Assign to person with highest deficit; tie-break by fewer leads total.
 *
 * Uses pg_advisory_xact_lock to prevent race conditions when multiple
 * webhooks arrive simultaneously.
 *
 * @param {number} leadId
 * @returns {Promise<number|null>} responsible_id assigned, or null
 */
async function distributeLead(leadId) {
  // Distribution is part of the subscription: once it has expired, new leads are
  // received and stored but not handed to operators (they stay on the main
  // account), and it resumes by itself when the subscription is extended — see
  // middleware/subscription.js and scripts/set_subscription.js. Every caller
  // (leadCreated, the Facebook webhook) goes through here.
  if ((await getSubscriptionStatus()).expired) {
    console.log(`[distributor] Lead ${leadId} NOT distributed: subscription expired, distribution is paused`);
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(12345)');

    const { rows: leadRows } = await client.query('SELECT 1 FROM leads WHERE id = $1', [leadId]);
    if (!leadRows.length) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: alreadyAssigned } = await client.query(
      'SELECT responsible_id FROM taqsimot_assignments WHERE lead_id = $1', [leadId]
    );
    if (alreadyAssigned.length) {
      await client.query('COMMIT');
      return Number(alreadyAssigned[0].responsible_id);
    }

    const { rows: distributors } = await client.query(`
      SELECT
        r.id,
        r.name,
        r.taqsimot_pct AS taqsimot_pct,
        COUNT(l.id)::int AS today_count
      FROM responsibles r
      LEFT JOIN leads l ON l.responsible_id = r.id
        AND l.date_create >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
        AND (l.source_id IS NULL OR l.source_id != 'UC_1WUFJB')
      WHERE r.taqsimot_pct > 0
        AND r.id IN (SELECT responsible_id FROM taqsimot_members)
        AND r.active = TRUE
      GROUP BY r.id, r.name, r.taqsimot_pct
      ORDER BY r.id
    `);

    if (distributors.length === 0) {
      await client.query('ROLLBACK');
      console.log('[distributor] No active distributors found');
      return null;
    }

    const totalToday = distributors.reduce((s, d) => s + d.today_count, 0);

    let bestId   = null;
    let bestName = '';
    let maxDeficit = -Infinity;
    let minCount   = Infinity;
    const pctTotal = distributors.reduce((sum, row) => sum + parseFloat(row.taqsimot_pct), 0);

    for (const d of distributors) {
      const pct      = parseFloat(d.taqsimot_pct);
      const actual   = d.today_count;
      const deficit  = (pct / pctTotal) * (totalToday + 1) - actual;

      if (deficit > maxDeficit || (deficit === maxDeficit && actual < minCount)) {
        maxDeficit = deficit;
        bestId     = d.id;
        bestName   = d.name;
        minCount   = actual;
      }
    }

    await client.query(
      'UPDATE leads SET responsible_id = $1 WHERE id = $2',
      [bestId, leadId]
    );
    await client.query(
      `INSERT INTO taqsimot_assignments (lead_id, responsible_id)
       VALUES ($1, $2)
       ON CONFLICT (lead_id) DO UPDATE SET responsible_id = EXCLUDED.responsible_id,
                                      campaign_name = NULL, assigned_at = NOW()`,
      [leadId, bestId]
    );

    await client.query('COMMIT');

    // Async Bitrix24 update — don't block the webhook response
    bitrixCall('crm.lead.update', {
      id: leadId,
      fields: { ASSIGNED_BY_ID: bestId },
    }, 'distributor').catch(err => {
      console.error(`[distributor] Bitrix update failed for lead ${leadId}:`, err.message);
    });

    console.log(`[distributor] Lead ${leadId} → ${bestName} (id=${bestId}), deficit=${maxDeficit.toFixed(2)}`);
    return bestId;

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[distributor] Error:', err.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { distributeLead };
