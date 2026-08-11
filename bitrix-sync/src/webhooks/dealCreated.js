const pool = require('../db/pool');
const { fetchOne } = require('../services/bitrix');
const { upsertDeal } = require('../services/upsertDeal');

/**
 * Handle ONCRMDEALADD webhook.
 */
async function dealCreated(req, res) {
  res.sendStatus(200);

  const entityId = parseInt(req.body?.data?.FIELDS?.ID || req.body?.['data[FIELDS][ID]']);
  if (!entityId) return;

  try {
    await pool.query(
      `INSERT INTO webhook_logs (event, entity_id, payload)
       VALUES ('ONCRMDEALADD', $1, $2)`,
      [entityId, JSON.stringify(req.body)]
    );

    const raw = await fetchOne('crm.deal.get', entityId, 'webhook:dealCreated');
    if (!raw) return;

    await upsertDeal(raw);

    const deal = await pool.query('SELECT id, stage_id FROM deals WHERE id = $1', [entityId]);
    if (deal.rows.length && deal.rows[0].stage_id) {
      await pool.query(
        'INSERT INTO deal_stage_history (deal_id, stage_id) VALUES ($1, $2)',
        [entityId, deal.rows[0].stage_id]
      );
    }

    await pool.query(
      'UPDATE webhook_logs SET processed = TRUE WHERE event = $1 AND entity_id = $2 AND processed = FALSE',
      ['ONCRMDEALADD', entityId]
    );

    console.log(`[webhook] deal created: ${entityId}`);
  } catch (err) {
    console.error(`[webhook] dealCreated error for ${entityId}:`, err.message);
    await pool.query(
      `UPDATE webhook_logs SET error = $1
       WHERE event = 'ONCRMDEALADD' AND entity_id = $2 AND processed = FALSE`,
      [err.message, entityId]
    ).catch(() => {});
  }
}

module.exports = dealCreated;
