const { Router } = require('express');
const pool = require('../db/pool');
const { syncDealStagesFromBitrix } = require('../services/stageResolver');

const router = Router();

// POST /api/reja/sync-stages  — one-time manual fix for is_won flags
router.post('/sync-stages', async (_req, res) => {
  try {
    await syncDealStagesFromBitrix();
    res.json({ ok: true, message: 'stages synced from Bitrix' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reja/debug-stages  — show current stages table state
router.get('/debug-stages', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.bitrix_id, s.name, s.is_won, s.is_final,
             COUNT(d.id)::int AS deal_count
      FROM stages s
      LEFT JOIN deals d ON d.stage_id = s.id
      WHERE s.entity = 'deal'
      GROUP BY s.id, s.bitrix_id, s.name, s.is_won, s.is_final
      ORDER BY deal_count DESC
    `);
    const won = rows.filter(r => r.is_won);
    const notWon = rows.filter(r => !r.is_won);
    res.json({
      total_stages: rows.length,
      won_stages: won,
      not_won_stages: notWon,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Schema (runs once at module load via index.js startup hook) ────
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reja_plans (
      id           SERIAL PRIMARY KEY,
      name         TEXT,
      period_type  TEXT NOT NULL CHECK (period_type IN ('monthly', 'quarterly')),
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      total_target NUMERIC(15,2) NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reja_targets (
      id             SERIAL PRIMARY KEY,
      plan_id        INTEGER NOT NULL REFERENCES reja_plans(id) ON DELETE CASCADE,
      responsible_id INTEGER NOT NULL REFERENCES responsibles(id),
      target         NUMERIC(15,2) NOT NULL DEFAULT 0,
      UNIQUE(plan_id, responsible_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS reja_targets_plan_idx ON reja_targets(plan_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reja_week_actuals (
      id               SERIAL PRIMARY KEY,
      plan_id          INTEGER NOT NULL REFERENCES reja_plans(id) ON DELETE CASCADE,
      responsible_id   INTEGER NOT NULL REFERENCES responsibles(id),
      week_index       INTEGER NOT NULL CHECK (week_index >= 1),
      actual           NUMERIC(15,2) NOT NULL DEFAULT 0,
      planned_snapshot NUMERIC(15,2),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(plan_id, responsible_id, week_index)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS reja_week_actuals_idx ON reja_week_actuals(plan_id, responsible_id)`);
}

// ── Helper: fetch a plan enriched with aggregate columns ──────────
// Used after INSERT/UPDATE so the returned object matches RejaPlan fully.
async function fetchEnrichedPlan(id) {
  const { rows } = await pool.query(`
    SELECT
      p.*,
      COUNT(DISTINCT t.responsible_id)::int  AS employee_count,
      COALESCE(SUM(t.target), 0)::numeric    AS distributed_total
    FROM reja_plans p
    LEFT JOIN reja_targets t ON t.plan_id = p.id
    WHERE p.id = $1
    GROUP BY p.id
  `, [id]);
  return rows[0] || null;
}

// ── Sub-period generation ─────────────────────────────────────────
const MONTH_NAMES_UZ = [
  'Yanvar','Fevral','Mart','Aprel','May','Iyun',
  'Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr',
];

function pad(n) { return String(n).padStart(2, '0'); }

function localISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getSubperiods(plan) {
  // Use period_start as string directly to avoid timezone shifts
  const startStr = plan.period_start.slice(0, 10); // "YYYY-MM-DD"
  const endStr   = plan.period_end.slice(0, 10);

  if (plan.period_type === 'monthly') {
    // Build 4 weekly chunks of 7 days each, anchored to period_start
    const [sy, sm, sd] = startStr.split('-').map(Number);
    const result = [];
    let cursor = new Date(sy, sm - 1, sd);
    for (let i = 0; i < 4; i++) {
      const wStart = localISO(cursor);
      // Each week = 7 days; last week ends exactly on period_end
      const wEndRaw = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 6);
      const wEnd = i === 3 ? endStr : localISO(wEndRaw);
      result.push({ index: i + 1, start: wStart, end: wEnd, label: `${i + 1}-hafta` });
      cursor = new Date(wEndRaw.getFullYear(), wEndRaw.getMonth(), wEndRaw.getDate() + 1);
    }
    return result;
  }

  // quarterly → 3 calendar months
  const result = [];
  for (let i = 0; i < 3; i++) {
    const mStart = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const mEnd   = new Date(start.getFullYear(), start.getMonth() + i + 1, 0);
    result.push({
      index: i + 1,
      start: localISO(mStart),
      end:   localISO(mEnd),
      label: MONTH_NAMES_UZ[mStart.getMonth()],
    });
  }
  return result;
}

// ── Redistribution (flex mode) ────────────────────────────────────
//
// Three zone model — each zone targets separately:
//   PAST   (end < today):  show original M/N snapshot
//   CURRENT (today in week): target = (total - past_actual) / remaining_week_count
//   FUTURE (start > today): target = (total - past_actual - current_actual) / future_count
//                           → flexes in real-time with every new payment in current week
//
// Over-performance: clamped to 0.  Last future week absorbs rounding remainder.
function redistribute(totalTarget, subperiods, actualsMap, todayStr) {
  const n = subperiods.length;
  if (n === 0) return [];

  const pastSet    = new Set(subperiods.filter(sp => sp.end   <  todayStr).map(sp => sp.index));
  const currentSp  = subperiods.find(sp => sp.start <= todayStr && todayStr <= sp.end);
  const futureList = subperiods.filter(sp => sp.start > todayStr);

  const pastActual    = [...pastSet].reduce((s, idx) => s + (actualsMap[idx] || 0), 0);
  const currentActual = currentSp ? (actualsMap[currentSp.index] || 0) : 0;

  // Current week target: share remaining equally across current + future weeks
  const remainingAfterPast  = Math.max(0, totalTarget - pastActual);
  const currentAndFutureLen = (currentSp ? 1 : 0) + futureList.length;
  const currentTarget = currentAndFutureLen > 0
    ? Math.round((remainingAfterPast / currentAndFutureLen) * 100) / 100
    : 0;

  // Future weeks: flex based on current week's committed amount.
  // Use max(currentTarget, currentActual) so that:
  //   - before any sales in current week: future uses (total - currentTarget) → all weeks equal
  //   - if current week overperforms: future weeks compress correctly
  const remainingAfterCurrent = Math.max(0, remainingAfterPast - Math.max(currentTarget, currentActual));
  const futureCount           = futureList.length;
  const futureBase            = futureCount > 0
    ? Math.round((remainingAfterCurrent / futureCount) * 100) / 100
    : 0;
  const lastFutureIdx = futureCount > 0 ? futureList[futureList.length - 1].index : -1;
  const lastFuturePlanned = futureCount > 0
    ? Math.round((remainingAfterCurrent - (futureCount - 1) * futureBase) * 100) / 100
    : 0;

  // For past weeks: compute what the target was at the START of each past week
  // (total - sum of actuals from prior completed weeks) / remaining weeks at that point
  const pastList = subperiods.filter(sp => pastSet.has(sp.index));
  const pastTargets = {};
  let runningActual = 0;
  for (let i = 0; i < pastList.length; i++) {
    const sp = pastList[i];
    const weeksLeft = n - i;
    pastTargets[sp.index] = weeksLeft > 0
      ? Math.round((Math.max(0, totalTarget - runningActual) / weeksLeft) * 100) / 100
      : 0;
    runningActual += actualsMap[sp.index] || 0;
  }

  return subperiods.map(sp => {
    const actual = actualsMap[sp.index] || 0;
    let target;
    if (pastSet.has(sp.index)) {
      target = pastTargets[sp.index];
    } else if (currentSp && sp.index === currentSp.index) {
      target = currentTarget;
    } else {
      target = sp.index === lastFutureIdx ? lastFuturePlanned : futureBase;
    }
    return { spIndex: sp.index, target, actual: Math.round(actual * 100) / 100 };
  });
}

// Wraps redistribute() with date-aware isPast / isCurrent / pct fields.
function computeSubperiodProgress(totalTarget, subperiods, actualsMap, today) {
  const todayStr = localISO(today);
  const results  = redistribute(totalTarget, subperiods, actualsMap, todayStr);
  const byIdx    = Object.fromEntries(results.map(r => [r.spIndex, r]));

  return subperiods.map(sp => {
    const isPast    = sp.end   <  todayStr;
    const isCurrent = sp.start <= todayStr && todayStr <= sp.end;
    const { target, actual } = byIdx[sp.index];
    const pct = target > 0 ? Math.min(Math.round(actual / target * 100), 999) : 0;
    return { ...sp, target, actual, isPast, isCurrent, pct };
  });
}

// ══════════════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════════════

// GET /api/reja/plans
// Returns all plans, enriched with employee_count + distributed_total.
router.get('/plans', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.*,
        COUNT(DISTINCT t.responsible_id)::int  AS employee_count,
        COALESCE(SUM(t.target), 0)::numeric    AS distributed_total
      FROM reja_plans p
      LEFT JOIN reja_targets t ON t.plan_id = p.id
      GROUP BY p.id
      ORDER BY p.period_start DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[reja/plans GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reja/plans
// Body: { name?, period_type, period_start, period_end, total_target }
// Returns the enriched plan (matches RejaPlan type fully).
router.post('/plans', async (req, res) => {
  const { name, period_type, period_start, period_end, total_target } = req.body;
  if (!period_type || !period_start || !period_end)
    return res.status(400).json({ error: 'period_type, period_start, period_end required' });

  try {
    const insertRes = await pool.query(
      `INSERT INTO reja_plans (name, period_type, period_start, period_end, total_target)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name || null, period_type, period_start, period_end, total_target || 0]
    );
    const plan = await fetchEnrichedPlan(insertRes.rows[0].id);
    res.status(201).json(plan);
  } catch (err) {
    console.error('[reja/plans POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/reja/plans/:id
// Body: { name?, total_target?, period_start?, period_end? }
// Returns the enriched plan.
router.put('/plans/:id', async (req, res) => {
  const id   = parseInt(req.params.id);
  const body = req.body;
  const sets = [];
  const vals = [];
  let   i    = 1;

  if (body.name         !== undefined) { sets.push(`name = $${i++}`);         vals.push(body.name); }
  if (body.total_target !== undefined) { sets.push(`total_target = $${i++}`); vals.push(body.total_target); }
  if (body.period_start !== undefined) { sets.push(`period_start = $${i++}`); vals.push(body.period_start); }
  if (body.period_end   !== undefined) { sets.push(`period_end = $${i++}`);   vals.push(body.period_end); }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  sets.push('updated_at = NOW()');
  vals.push(id);

  try {
    const { rowCount } = await pool.query(
      `UPDATE reja_plans SET ${sets.join(', ')} WHERE id = $${i}`,
      vals
    );
    if (!rowCount) return res.status(404).json({ error: 'Plan not found' });
    const plan = await fetchEnrichedPlan(id);
    res.json(plan);
  } catch (err) {
    console.error('[reja/plans PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reja/plans/:id
router.delete('/plans/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reja_plans WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[reja/plans DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reja/plans/:id/distribution
// Returns all responsibles with their target AND actual won-deal sales for the plan period.
// active = false → ON LEAVE badge.
router.get('/plans/:id/distribution', async (req, res) => {
  const planId = parseInt(req.params.id);
  try {
    const planRes = await pool.query(`
      SELECT
        p.*,
        COUNT(DISTINCT t.responsible_id)::int  AS employee_count,
        COALESCE(SUM(t.target), 0)::numeric    AS distributed_total
      FROM reja_plans p
      LEFT JOIN reja_targets t ON t.plan_id = p.id
      WHERE p.id = $1
      GROUP BY p.id
    `, [planId]);

    if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planRes.rows[0];

    // Only return responsibles explicitly added to this plan (have a reja_targets record).
    // "Xodim qo'shish" button uses listAllResponsibles to add new ones.
    const empRes = await pool.query(`
      SELECT
        r.id                                                          AS responsible_id,
        TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
        r.work_position,
        r.active,
        r.photo_url,
        t.target::numeric                                             AS target
      FROM reja_targets t
      JOIN responsibles r ON r.id = t.responsible_id
      WHERE t.plan_id = $1
      ORDER BY t.target DESC, r.name, r.last_name
    `, [planId]);

    // Actual won-deal sales per responsible for the plan period.
    // closedate = Bitrix24 CLOSEDATE (set when deal is won); fallback to date_modify, then date_create.
    const allIds = empRes.rows.map(r => r.responsible_id);
    const actualsRes = allIds.length ? await pool.query(`
      SELECT responsible_id,
             COALESCE(SUM(amount), 0)::numeric AS actual_sales,
             COUNT(DISTINCT deal_id)::int       AS deal_count
      FROM (
        SELECT d.responsible_id, p.deal_id, SUM(p.amount_usd) AS amount
        FROM deals d
        JOIN stages s ON s.id = d.stage_id
        JOIN deal_payments p ON p.deal_id = d.id
        WHERE d.responsible_id = ANY($1)
          AND NOT (s.is_final = true AND s.is_won = false)
          AND p.paid_at BETWEEN $2 AND $3
        GROUP BY d.responsible_id, p.deal_id

        UNION ALL

        SELECT d.responsible_id, d.id AS deal_id, d.uf_paid_sum AS amount
        FROM deals d
        JOIN stages s ON s.id = d.stage_id
        WHERE d.responsible_id = ANY($1)
          AND d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
          AND NOT (s.is_final = true AND s.is_won = false)
          AND COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN $2 AND $3
          AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
      ) sub
      GROUP BY responsible_id
    `, [allIds, plan.period_start, plan.period_end]) : { rows: [] };

    const actualsMap = {};
    for (const row of actualsRes.rows) {
      actualsMap[row.responsible_id] = {
        actual_sales: Math.round(parseFloat(row.actual_sales) * 100) / 100,
        deal_count:   row.deal_count,
      };
    }

    const employees = empRes.rows.map(r => ({
      ...r,
      actual_sales: actualsMap[r.responsible_id]?.actual_sales ?? 0,
      deal_count:   actualsMap[r.responsible_id]?.deal_count   ?? 0,
    }));

    res.json({ plan, employees });
  } catch (err) {
    console.error('[reja/distribution GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reja/plans/:id/distribution
// Body: { targets: [{ responsible_id, target }] }
// Full replace: deletes old targets and inserts new ones in one transaction.
router.post('/plans/:id/distribution', async (req, res) => {
  const planId = parseInt(req.params.id);
  const { targets } = req.body;
  if (!Array.isArray(targets)) return res.status(400).json({ error: 'targets[] required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Remove all existing targets for this plan
    await client.query('DELETE FROM reja_targets WHERE plan_id = $1', [planId]);

    // Insert rows with target >= 0
    for (const t of targets) {
      const amt = parseFloat(t.target) || 0;
      if (amt >= 0) {
        await client.query(
          `INSERT INTO reja_targets (plan_id, responsible_id, target)
           VALUES ($1, $2, $3)
           ON CONFLICT (plan_id, responsible_id) DO UPDATE SET target = EXCLUDED.target`,
          [planId, t.responsible_id, amt]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[reja/distribution POST]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/reja/plans/:id/progress
// Returns per-sub-period targets (with dynamic recalculation) and actuals
// sourced from CRM won deals closed within the plan period.
router.get('/plans/:id/progress', async (req, res) => {
  const planId = parseInt(req.params.id);
  try {
    const planRes = await pool.query(`
      SELECT
        p.*,
        COUNT(DISTINCT t.responsible_id)::int  AS employee_count,
        COALESCE(SUM(t.target), 0)::numeric    AS distributed_total
      FROM reja_plans p
      LEFT JOIN reja_targets t ON t.plan_id = p.id
      WHERE p.id = $1
      GROUP BY p.id
    `, [planId]);

    if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planRes.rows[0];

    const subperiods = getSubperiods(plan);
    const today      = new Date();

    // Employees who have a target in this plan, ordered by target desc
    const targetsRes = await pool.query(`
      SELECT
        t.responsible_id,
        t.target::numeric                                              AS target,
        TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
        r.work_position,
        r.photo_url,
        r.active
      FROM reja_targets t
      JOIN responsibles r ON r.id = t.responsible_id
      WHERE t.plan_id = $1
      ORDER BY t.target DESC, r.name
    `, [planId]);

    if (!targetsRes.rows.length) {
      return res.json({
        plan,
        subperiods: subperiods.map(({ index, label, start, end }) => ({ index, label, start, end })),
        employees: [],
        summary: { total_target: 0, total_actual: 0, pct: 0 },
      });
    }

    const respIds = targetsRes.rows.map(r => r.responsible_id);

    // Actuals: sum of won-deal opportunities, grouped by responsible + close date.
    // closedate = Bitrix24 CLOSEDATE (the actual win date); fallback to date_modify, then date_create.
    // ::text cast ensures node-postgres returns a plain string (not a Date object)
    // so JS string comparison against sp.start/sp.end works correctly.
    // deal_payments bo'lsa — har to'lov alohida sana bilan,
    // bo'lmasa — uf_paid_sum ni bitta sana bilan hisoblash.
    const actualsRes = await pool.query(`
      SELECT d.responsible_id, p.paid_at::text AS close_date, SUM(p.amount_usd)::numeric AS amount
      FROM deals d
      JOIN stages s ON s.id = d.stage_id
      JOIN deal_payments p ON p.deal_id = d.id
      WHERE d.responsible_id = ANY($1)
        AND NOT (s.is_final = true AND s.is_won = false)
        AND p.paid_at BETWEEN $2 AND $3
      GROUP BY d.responsible_id, p.paid_at

      UNION ALL

      SELECT d.responsible_id,
             COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date::text AS close_date,
             SUM(d.uf_paid_sum)::numeric AS amount
      FROM deals d
      JOIN stages s ON s.id = d.stage_id
      WHERE d.responsible_id = ANY($1)
        AND d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
        AND NOT (s.is_final = true AND s.is_won = false)
        AND COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN $2 AND $3
        AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
      GROUP BY d.responsible_id, COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date
    `, [respIds, plan.period_start, plan.period_end]);

    // Build CRM actuals map: { responsible_id: { subperiod_index: amount } }
    const actualsByResp = {};
    for (const row of actualsRes.rows) {
      if (!actualsByResp[row.responsible_id]) actualsByResp[row.responsible_id] = {};
      for (const sp of subperiods) {
        if (row.close_date >= sp.start && row.close_date <= sp.end) {
          actualsByResp[row.responsible_id][sp.index] =
            (actualsByResp[row.responsible_id][sp.index] || 0) + parseFloat(row.amount);
          break;
        }
      }
    }

    // Stored actuals override CRM actuals when present
    const storedRes = await pool.query(`
      SELECT responsible_id, week_index, actual::numeric AS actual
      FROM reja_week_actuals
      WHERE plan_id = $1 AND responsible_id = ANY($2)
    `, [planId, respIds]);
    const storedByResp = {};
    for (const row of storedRes.rows) {
      if (!storedByResp[row.responsible_id]) storedByResp[row.responsible_id] = {};
      storedByResp[row.responsible_id][row.week_index] = parseFloat(row.actual);
    }

    const employees = targetsRes.rows.map(emp => {
      const crmActuals = actualsByResp[emp.responsible_id] || {};
      const stored     = storedByResp[emp.responsible_id]  || {};
      // Per week: stored takes priority over CRM
      const mergedActuals = {};
      for (const sp of subperiods) {
        const s = stored[sp.index];
        mergedActuals[sp.index] = s !== undefined ? s : (crmActuals[sp.index] || 0);
      }
      const totalActual = Object.values(mergedActuals).reduce((s, v) => s + v, 0);
      const target      = parseFloat(emp.target);
      return {
        responsible_id: emp.responsible_id,
        full_name:      emp.full_name,
        work_position:  emp.work_position,
        photo_url:      emp.photo_url,
        active:         emp.active,
        target,
        total_actual:   Math.round(totalActual * 100) / 100,
        pct:            target > 0 ? Math.min(Math.round(totalActual / target * 100), 999) : 0,
        subperiods:     computeSubperiodProgress(target, subperiods, mergedActuals, today),
      };
    });

    const totalTarget = employees.reduce((s, e) => s + e.target,       0);
    const totalActual = employees.reduce((s, e) => s + e.total_actual,  0);

    // Previous period comparison
    const prevPlanRes = await pool.query(`
      SELECT id, period_start, period_end
      FROM reja_plans
      WHERE period_start < $1 AND period_type = $2
      ORDER BY period_start DESC LIMIT 1
    `, [plan.period_start, plan.period_type]);

    let prevActual = 0;
    if (prevPlanRes.rows.length) {
      const pp = prevPlanRes.rows[0];
      const prevActualRes = await pool.query(`
        SELECT COALESCE(SUM(sub.amount), 0)::numeric AS total
        FROM (
          SELECT p.amount_usd AS amount
          FROM deal_payments p
          JOIN deals d ON d.id = p.deal_id
          JOIN stages s ON s.id = d.stage_id
          WHERE NOT (s.is_final = true AND s.is_won = false)
            AND p.paid_at BETWEEN $1 AND $2
          UNION ALL
          SELECT d.uf_paid_sum AS amount
          FROM deals d
          JOIN stages s ON s.id = d.stage_id
          WHERE d.uf_paid_sum IS NOT NULL AND d.uf_paid_sum > 0
            AND NOT (s.is_final = true AND s.is_won = false)
            AND COALESCE(d.uf_bp_sale_date, d.uf_payment_date, d.date_create)::date BETWEEN $1 AND $2
            AND d.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
        ) sub
      `, [pp.period_start, pp.period_end]);
      prevActual = Math.round(parseFloat(prevActualRes.rows[0].total) * 100) / 100;
    }

    const growthPct = prevActual > 0
      ? Math.round((totalActual - prevActual) / prevActual * 100)
      : null;

    res.json({
      plan,
      subperiods: subperiods.map(({ index, label, start, end }) => ({ index, label, start, end })),
      employees,
      summary: {
        total_target: Math.round(totalTarget * 100) / 100,
        total_actual: Math.round(totalActual * 100) / 100,
        pct: totalTarget > 0 ? Math.min(Math.round(totalActual / totalTarget * 100), 999) : 0,
        prev_actual:  prevActual,
        growth_pct:   growthPct,
      },
    });
  } catch (err) {
    console.error('[reja/progress GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reja/plans/:planId/responsibles/:responsibleId/weeks/:weekIndex/actual
// Body: { actual: number }
// Records/updates a week's actual; returns recomputed weeks for that responsible.
router.post('/plans/:planId/responsibles/:responsibleId/weeks/:weekIndex/actual', async (req, res) => {
  const planId        = parseInt(req.params.planId);
  const responsibleId = parseInt(req.params.responsibleId);
  const weekIndex     = parseInt(req.params.weekIndex);
  const actual        = parseFloat(req.body.actual);

  if (isNaN(actual) || actual < 0)
    return res.status(400).json({ error: 'actual (non-negative number) required' });
  if (isNaN(weekIndex) || weekIndex < 1)
    return res.status(400).json({ error: 'weekIndex must be >= 1' });

  try {
    const planRes = await pool.query(`SELECT * FROM reja_plans WHERE id = $1`, [planId]);
    if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planRes.rows[0];

    const targetRes = await pool.query(
      `SELECT target FROM reja_targets WHERE plan_id = $1 AND responsible_id = $2`,
      [planId, responsibleId]
    );
    if (!targetRes.rows.length) return res.status(404).json({ error: 'Responsible not in plan' });
    const monthlyTarget = parseFloat(targetRes.rows[0].target);

    // Load existing stored actuals for this responsible
    const existingRes = await pool.query(
      `SELECT week_index, actual::numeric AS actual FROM reja_week_actuals
       WHERE plan_id = $1 AND responsible_id = $2`,
      [planId, responsibleId]
    );
    const storedActuals = {};
    for (const row of existingRes.rows) storedActuals[row.week_index] = parseFloat(row.actual);

    // Snapshot = what the planned was for this week BEFORE recording this actual
    const subperiods      = getSubperiods(plan);
    const todayStr        = localISO(new Date());
    const beforeResults   = redistribute(monthlyTarget, subperiods, storedActuals, todayStr);
    const beforeByIdx     = Object.fromEntries(beforeResults.map(r => [r.spIndex, r]));
    const plannedSnapshot = beforeByIdx[weekIndex]?.target ?? null;

    // Upsert actual
    await pool.query(`
      INSERT INTO reja_week_actuals
        (plan_id, responsible_id, week_index, actual, planned_snapshot, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (plan_id, responsible_id, week_index)
      DO UPDATE SET actual = EXCLUDED.actual,
                    planned_snapshot = EXCLUDED.planned_snapshot,
                    updated_at = NOW()
    `, [planId, responsibleId, weekIndex, actual, plannedSnapshot]);

    // Recompute with updated actuals
    storedActuals[weekIndex] = actual;
    const today      = new Date();
    const recomputed = computeSubperiodProgress(monthlyTarget, subperiods, storedActuals, today);
    const totalActual = Object.values(storedActuals).reduce((s, a) => s + a, 0);

    res.json({
      responsible_id: responsibleId,
      target:         monthlyTarget,
      total_actual:   Math.round(totalActual * 100) / 100,
      pct:            monthlyTarget > 0 ? Math.min(Math.round(totalActual / monthlyTarget * 100), 999) : 0,
      subperiods:     recomputed,
    });
  } catch (err) {
    console.error('[reja/weeks POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reja/plans/:planId/responsibles/:responsibleId/weeks
// Returns current week state with planned, actual, status for a single responsible.
router.get('/plans/:planId/responsibles/:responsibleId/weeks', async (req, res) => {
  const planId        = parseInt(req.params.planId);
  const responsibleId = parseInt(req.params.responsibleId);

  try {
    const planRes = await pool.query(`SELECT * FROM reja_plans WHERE id = $1`, [planId]);
    if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planRes.rows[0];

    const targetRes = await pool.query(
      `SELECT target FROM reja_targets WHERE plan_id = $1 AND responsible_id = $2`,
      [planId, responsibleId]
    );
    if (!targetRes.rows.length) return res.status(404).json({ error: 'Responsible not in plan' });
    const monthlyTarget = parseFloat(targetRes.rows[0].target);

    const storedRes = await pool.query(
      `SELECT week_index, actual::numeric AS actual, planned_snapshot::numeric AS planned_snapshot
       FROM reja_week_actuals WHERE plan_id = $1 AND responsible_id = $2`,
      [planId, responsibleId]
    );
    const storedActuals = {};
    const snapshots     = {};
    for (const row of storedRes.rows) {
      storedActuals[row.week_index] = parseFloat(row.actual);
      if (row.planned_snapshot != null) snapshots[row.week_index] = parseFloat(row.planned_snapshot);
    }

    const subperiods = getSubperiods(plan);
    const today      = new Date();
    const recomputed = computeSubperiodProgress(monthlyTarget, subperiods, storedActuals, today);
    const totalActual = Object.values(storedActuals).reduce((s, a) => s + a, 0);
    const remaining   = Math.max(0, monthlyTarget - totalActual);

    res.json({
      responsible_id:    responsibleId,
      target:            monthlyTarget,
      total_actual:      Math.round(totalActual * 100) / 100,
      remaining_target:  Math.round(remaining   * 100) / 100,
      pct:               monthlyTarget > 0 ? Math.min(Math.round(totalActual / monthlyTarget * 100), 999) : 0,
      weeks: recomputed.map(sp => ({
        week_index:       sp.index,
        label:            sp.label,
        start:            sp.start,
        end:              sp.end,
        planned:          sp.target,
        planned_snapshot: snapshots[sp.index] ?? null,
        actual:           sp.actual,
        status:           sp.actual > 0 ? 'completed' : (sp.isPast ? 'pending' : (sp.isCurrent ? 'current' : 'future')),
        isPast:           sp.isPast,
        isCurrent:        sp.isCurrent,
        pct:              sp.pct,
      })),
    });
  } catch (err) {
    console.error('[reja/weeks GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, ensureSchema };
