const pool = require('../db/pool');
const { fetchOne } = require('../services/bitrix');
const { upsertDeal } = require('../services/upsertDeal');

/**
 * Handle ONCRMDEALUPDATE webhook.
 */
async function dealUpdated(req, res) {
  res.sendStatus(200);

  const entityId = parseInt(req.body?.data?.FIELDS?.ID || req.body?.['data[FIELDS][ID]']);
  if (!entityId) return;

  try {
    await pool.query(
      `INSERT INTO webhook_logs (event, entity_id, payload)
       VALUES ('ONCRMDEALUPDATE', $1, $2)`,
      [entityId, JSON.stringify(req.body)]
    );

    const before = await pool.query('SELECT stage_id FROM deals WHERE id = $1', [entityId]);
    const prevStageId = before.rows[0]?.stage_id || null;

    const raw = await fetchOne('crm.deal.get', entityId, 'webhook:dealUpdated');
    if (!raw) return;

    await upsertDeal(raw);

    const after = await pool.query('SELECT stage_id FROM deals WHERE id = $1', [entityId]);
    const newStageId = after.rows[0]?.stage_id || null;

    if (newStageId && newStageId !== prevStageId) {
      await pool.query(
        'INSERT INTO deal_stage_history (deal_id, stage_id) VALUES ($1, $2)',
        [entityId, newStageId]
      );
    }

    await pool.query(
      'UPDATE webhook_logs SET processed = TRUE WHERE event = $1 AND entity_id = $2 AND processed = FALSE',
      ['ONCRMDEALUPDATE', entityId]
    );

    console.log(`[webhook] deal updated: ${entityId}`);
  } catch (err) {
    console.error(`[webhook] dealUpdated error for ${entityId}:`, err.message);
    await pool.query(
      `UPDATE webhook_logs SET error = $1
       WHERE event = 'ONCRMDEALUPDATE' AND entity_id = $2 AND processed = FALSE`,
      [err.message, entityId]
    ).catch(() => {});
  }
}

module.exports = dealUpdated;
