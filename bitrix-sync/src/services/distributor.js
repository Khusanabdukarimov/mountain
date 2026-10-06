const pool = require('../db/pool');
const { bitrixCall } = require('./bitrix');
const { CAMPAIGN_NAME, OPERATOR_IDS } = require('./distributionCampaign');

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
async function distributeLead(leadId, campaignName = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(12345)');

    const { rows: leadRows } = await client.query(`
      SELECT COALESCE(NULLIF(l.utm_campaign, ''), (
        SELECT fl.campaign_name FROM facebook_leads fl
        WHERE fl.bitrix_lead_id = l.id AND fl.campaign_name IS NOT NULL
        ORDER BY fl.created_time DESC LIMIT 1
      )) AS campaign_name
      FROM leads l WHERE l.id = $1
    `, [leadId]);
    if (!leadRows.length) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: settings } = await client.query(
      'SELECT active FROM taqsimot_campaign_settings WHERE campaign_name = $1', [CAMPAIGN_NAME]
    );
    const campaignActive = settings[0]?.active === true;
    const leadCampaign = campaignName || leadRows[0].campaign_name;
    const specialStream = campaignActive && leadCampaign === CAMPAIGN_NAME;
    const { rows: alreadyAssigned } = await client.query(
      'SELECT responsible_id, campaign_name FROM taqsimot_assignments WHERE lead_id = $1', [leadId]
    );
    // The native Bitrix connector can create and distribute a lead before Meta
    // supplies its campaign. Re-route only that lead when its UTM is patched.
    if (alreadyAssigned.length && !(specialStream && alreadyAssigned[0].campaign_name !== CAMPAIGN_NAME)) {
      await client.query('COMMIT');
      return Number(alreadyAssigned[0].responsible_id);
    }
    const pctColumn = specialStream ? 'taqsimot_campaign_pct' : 'taqsimot_pct';
    const streamFilter = !campaignActive ? '' : specialStream
      ? `AND (l.utm_campaign = $1 OR (NULLIF(l.utm_campaign, '') IS NULL AND EXISTS (
           SELECT 1 FROM facebook_leads fl WHERE fl.bitrix_lead_id = l.id AND fl.campaign_name = $1)))`
      : `AND l.utm_campaign IS DISTINCT FROM $1
         AND NOT (NULLIF(l.utm_campaign, '') IS NULL AND EXISTS (
           SELECT 1 FROM facebook_leads fl WHERE fl.bitrix_lead_id = l.id AND fl.campaign_name = $1))`;

    const { rows: distributors } = await client.query(`
      SELECT
        r.id,
        r.name,
        r.${pctColumn} AS taqsimot_pct,
        COUNT(l.id)::int AS today_count
      FROM responsibles r
      LEFT JOIN leads l ON l.responsible_id = r.id
        AND l.date_create >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
        AND (l.source_id IS NULL OR l.source_id != 'UC_1WUFJB')
        ${streamFilter}
      WHERE r.${pctColumn} > 0
        AND r.taqsimot_pct > 0
        AND r.id IN (${OPERATOR_IDS.join(',')})
        AND r.active = TRUE
      GROUP BY r.id, r.name, r.${pctColumn}
      ORDER BY r.id
    `, campaignActive ? [CAMPAIGN_NAME] : []);

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
      `INSERT INTO taqsimot_assignments (lead_id, responsible_id, campaign_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (lead_id) DO UPDATE SET responsible_id = EXCLUDED.responsible_id,
                                      campaign_name = EXCLUDED.campaign_name, assigned_at = NOW()`,
      [leadId, bestId, specialStream ? CAMPAIGN_NAME : null]
    );

    await client.query('COMMIT');

    // Async Bitrix24 update — don't block the webhook response
    bitrixCall('crm.lead.update', {
      id: leadId,
      fields: { ASSIGNED_BY_ID: bestId },
    }, 'distributor').catch(err => {
      console.error(`[distributor] Bitrix update failed for lead ${leadId}:`, err.message);
    });

    console.log(`[distributor] Lead ${leadId} → ${bestName} (id=${bestId}), stream=${specialStream ? 'campaign' : 'general'}, deficit=${maxDeficit.toFixed(2)}`);
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
