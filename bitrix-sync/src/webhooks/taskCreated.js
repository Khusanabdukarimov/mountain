const pool = require('../db/pool');
const { fetchOne } = require('../services/bitrix');
const { upsertTask } = require('../services/upsertTask');

/**
 * Handle ONTASKMANAGER_TASK_ADD webhook.
 * Responds 200 immediately, fetches full task from Bitrix24, upserts to DB.
 */
async function taskCreated(req, res) {
  res.sendStatus(200);

  // Bitrix24 sends task ID in FIELDS_AFTER for create/update events
  const taskId = parseInt(
    req.body?.data?.FIELDS_AFTER?.ID   ||
    req.body?.['data[FIELDS_AFTER][ID]'] ||
    req.body?.data?.FIELDS?.ID          ||
    req.body?.['data[FIELDS][ID]']
  );
  if (!taskId || isNaN(taskId)) return;

  try {
    await pool.query(
      `INSERT INTO webhook_logs (event, entity_id, payload)
       VALUES ('ONTASKMANAGER_TASK_ADD', $1, $2)`,
      [taskId, JSON.stringify(req.body)]
    );

    const raw = await fetchOne('tasks.task.get', taskId, 'webhook:taskCreated');
    const task = raw?.task || raw;
    if (!task) return;

    await upsertTask(task);

    await pool.query(
      `UPDATE webhook_logs SET processed = TRUE
       WHERE event = 'ONTASKMANAGER_TASK_ADD' AND entity_id = $1 AND processed = FALSE`,
      [taskId]
    );

    console.log(`[webhook] task created: ${taskId}`);
  } catch (err) {
    console.error(`[webhook] taskCreated error for ${taskId}:`, err.message);
    await pool.query(
      `UPDATE webhook_logs SET error = $1
       WHERE event = 'ONTASKMANAGER_TASK_ADD' AND entity_id = $2 AND processed = FALSE`,
      [err.message, taskId]
    ).catch(() => {});
  }
}

module.exports = taskCreated;
