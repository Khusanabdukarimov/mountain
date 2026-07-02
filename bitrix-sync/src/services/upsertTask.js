const pool = require('../db/pool');

const STATUS_MAP = {
  '1': 'pending',       // New
  '2': 'pending',       // Pending (waiting to start)
  '3': 'in_progress',   // In Progress
  '4': 'review',        // Supposedly Completed (awaiting review)
  '5': 'completed',     // Completed
  '6': 'in_progress',   // Deferred
  '7': 'rejected',      // Declined
};

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Return the responsible id only if it exists in the table, else null. */
async function safeResponsibleId(id) {
  if (!id) return null;
  const n = parseInt(id, 10);
  if (!n) return null;
  const { rows } = await pool.query('SELECT id FROM responsibles WHERE id = $1', [n]);
  return rows.length ? n : null;
}

/**
 * Parse ufCrmTask array like ["L_2480", "D_1234"] and return
 * the first matching lead_id and deal_id that exist in our DB.
 */
async function resolveLinkedEntities(crmRefs) {
  let leadId = null, dealId = null;
  const arr = Array.isArray(crmRefs) ? crmRefs : [crmRefs].filter(Boolean);
  for (const item of arr) {
    const m = String(item).match(/^([LD])_(\d+)$/i);
    if (!m) continue;
    const id = parseInt(m[2], 10);
    if (m[1].toUpperCase() === 'L' && !leadId) {
      const { rows } = await pool.query('SELECT id FROM leads WHERE id = $1', [id]);
      if (rows.length) leadId = id;
    } else if (m[1].toUpperCase() === 'D' && !dealId) {
      const { rows } = await pool.query('SELECT id FROM deals WHERE id = $1', [id]);
      if (rows.length) dealId = id;
    }
  }
  return { leadId, dealId };
}

/**
 * Upsert a task from a Bitrix24 tasks.task.get → result.task object.
 * Returns the task id.
 */
async function upsertTask(task) {
  const id = parseInt(task.id || task.ID, 10);
  if (!id) throw new Error('task has no id');

  const title        = task.title        || task.TITLE        || '';
  const status       = STATUS_MAP[String(task.status || task.STATUS || '1')] || 'pending';
  const creatorId    = await safeResponsibleId(task.createdBy     || task.CREATED_BY);
  const executorId   = await safeResponsibleId(task.responsibleId || task.RESPONSIBLE_ID);
  const deadline     = parseDate(task.deadline    || task.DEADLINE);
  const dateCreated  = parseDate(task.createdDate || task.CREATED_DATE);
  const dateModified = parseDate(task.changedDate || task.CHANGED_DATE);
  const dateClosed   = parseDate(task.closedDate  || task.CLOSED_DATE);

  const { leadId, dealId } = await resolveLinkedEntities(
    task.ufCrmTask || task.UF_CRM_TASK || []
  );

  await pool.query(
    `INSERT INTO tasks (
       id, title, status, creator_id, executor_id, lead_id, deal_id,
       deadline, date_created, date_modified, date_closed, raw_data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       title         = EXCLUDED.title,
       status        = EXCLUDED.status,
       creator_id    = EXCLUDED.creator_id,
       executor_id   = EXCLUDED.executor_id,
       lead_id       = EXCLUDED.lead_id,
       deal_id       = EXCLUDED.deal_id,
       deadline      = EXCLUDED.deadline,
       date_created  = EXCLUDED.date_created,
       date_modified = EXCLUDED.date_modified,
       date_closed   = EXCLUDED.date_closed,
       raw_data      = EXCLUDED.raw_data`,
    [id, title, status, creatorId, executorId, leadId, dealId,
     deadline, dateCreated, dateModified, dateClosed, JSON.stringify(task)]
  );

  return id;
}

module.exports = { upsertTask };
