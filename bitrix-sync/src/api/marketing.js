const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

const MONTH_NUMS = {
  yanvar:1, fevral:2, mart:3, aprel:4, may:5, iyun:6,
  iyul:7, avgust:8, sentabr:9, oktabr:10, noyabr:11, dekabr:12,
};

// Qualifying lead stage bitrix_ids
const QUAL_STAGES = [
  'IN_PROCESS','PROCESSED','UC_1KPATX','UC_Q2U9EL','UC_KXC3ZW',
  'UC_L28G68','CONVERTED','CONVERTED_CONSULT','CONSULTATION',
  'CALLBACK','THINKING','NO_ANSWER',
];
const QUAL_LIST = QUAL_STAGES.map(s => `'${s}'`).join(',');

// Meeting (Konsultatsiya) stage bitrix_ids
const MEETING_STAGES = ['UC_L28G68','CONSULTATION'];
const MEETING_LIST   = MEETING_STAGES.map(s => `'${s}'`).join(',');

// Normalize phone → last 9 digits (handles +998XXXXXXXXX, 0XXXXXXXXX, local)
const PHONE_NORM = `RIGHT(REGEXP_REPLACE({col}, '[^0-9]', '', 'g'), 9)`;

function normExpr(col) { return PHONE_NORM.replace('{col}', col); }

function makeEmpty(n) { return Array(n).fill(0); }

// Platform detection from adset/campaign name:
//   adset contains " I/" or starts with "I/" → instagram
//   otherwise → target
const PLATFORM_CASE = `
  CASE
    WHEN adset_name ~ '(^|\\s|-)I/'
      OR LOWER(adset_name) LIKE '%instagram%'
      OR LOWER(campaign_name) LIKE '%instagram%'
    THEN 'instagram'
    ELSE 'target'
  END
`;

// GET /api/marketing/kunlik?month=iyun&year=2026
router.get('/kunlik', async (req, res) => {
  const monthKey = (req.query.month || '').toLowerCase();
  const year     = parseInt(req.query.year) || new Date().getFullYear();
  const monthNum = MONTH_NUMS[monthKey];
  if (!monthNum) return res.status(400).json({ error: `Unknown month: ${monthKey}` });

  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const monthStart = `${year}-${String(monthNum).padStart(2,'0')}-01`;
  const monthEnd   = `${year}-${String(monthNum).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`;

  const METRICS = ['leads','qual_leads','meetings','deals','deals_sum','sales_count','sales_sum','cancelled'];

  const result = { target: {} };
  for (const m of METRICS) result.target[m] = makeEmpty(daysInMonth);

  // "Target" source_id in Bitrix24 = UC_89FPH6
  const TARGET_SRC = 'UC_89FPH6';

  try {
    // ── 1. Leads count: from Bitrix leads where source_id = UC_89FPH6 ──
    const leadsRes = await pool.query(`
      SELECT
        EXTRACT(DAY FROM date_create AT TIME ZONE 'Asia/Tashkent')::int AS day,
        COUNT(*)::int AS cnt
      FROM leads
      WHERE (date_create AT TIME ZONE 'Asia/Tashkent')::date >= $1
        AND (date_create AT TIME ZONE 'Asia/Tashkent')::date <= $2
        AND source_id = $3
      GROUP BY day
    `, [monthStart, monthEnd, TARGET_SRC]);

    for (const row of leadsRes.rows) {
      if (row.day >= 1 && row.day <= daysInMonth) {
        result.target.leads[row.day - 1] += row.cnt;
      }
    }

    // ── 2. Qual leads + cancelled (lead-level) from Bitrix leads ──
    const qualLeadsRes = await pool.query(`
      SELECT
        EXTRACT(DAY FROM l.date_create AT TIME ZONE 'Asia/Tashkent')::int AS day,
        s.bitrix_id AS stage_bid,
        s.is_final,
        s.is_won
      FROM leads l
      LEFT JOIN stages s ON s.id = l.stage_id AND s.entity = 'lead'
      WHERE (l.date_create AT TIME ZONE 'Asia/Tashkent')::date >= $1
        AND (l.date_create AT TIME ZONE 'Asia/Tashkent')::date <= $2
        AND l.source_id = $3
    `, [monthStart, monthEnd, TARGET_SRC]);

    for (const row of qualLeadsRes.rows) {
      if (!row.day || row.day < 1 || row.day > daysInMonth) continue;
      const i = row.day - 1;
      if (QUAL_STAGES.includes(row.stage_bid)) {
        result.target.qual_leads[i]++;
      }
      if (row.is_final && !row.is_won) {
        result.target.cancelled[i]++;
      }
    }

    // ── 3. Deal-based metrics: meetings, sales, cancelled (by date_create) ──
    const dealMetricsRes = await pool.query(`
      SELECT
        EXTRACT(DAY FROM d.date_create AT TIME ZONE 'Asia/Tashkent')::int AS day,
        s.bitrix_id AS stage_bid,
        s.is_won,
        s.is_final,
        COALESCE(d.opportunity, 0)::numeric AS opp
      FROM deals d
      LEFT JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal'
      WHERE (d.date_create AT TIME ZONE 'Asia/Tashkent')::date >= $1
        AND (d.date_create AT TIME ZONE 'Asia/Tashkent')::date <= $2
        AND d.source_id = $3
    `, [monthStart, monthEnd, TARGET_SRC]);

    for (const row of dealMetricsRes.rows) {
      if (!row.day || row.day < 1 || row.day > daysInMonth) continue;
      const i   = row.day - 1;
      const opp = parseFloat(row.opp) || 0;

      if (row.stage_bid === 'NEW') {
        result.target.meetings[i]++;
      }
      // Sotuv bo'ldi = won deals by date_create
      if (row.is_won) {
        result.target.sales_count[i]++;
        result.target.sales_sum[i] = Math.round((result.target.sales_sum[i] + opp) * 100) / 100;
      }
      if (row.is_final && !row.is_won) {
        result.target.cancelled[i]++;
      }
    }

    // ── 4. Kelishuvlar: by when deal reached UC_W35V62 stage (stage history) ──
    const kelishuvRes = await pool.query(`
      SELECT
        EXTRACT(DAY FROM dsh.changed_at AT TIME ZONE 'Asia/Tashkent')::int AS day,
        COALESCE(d.opportunity, 0)::numeric AS opp
      FROM deal_stage_history dsh
      JOIN stages s ON s.id = dsh.stage_id AND s.bitrix_id = 'UC_W35V62'
      JOIN deals d ON d.id = dsh.deal_id AND d.source_id = $3
      WHERE (dsh.changed_at AT TIME ZONE 'Asia/Tashkent')::date >= $1
        AND (dsh.changed_at AT TIME ZONE 'Asia/Tashkent')::date <= $2
    `, [monthStart, monthEnd, TARGET_SRC]);

    for (const row of kelishuvRes.rows) {
      if (!row.day || row.day < 1 || row.day > daysInMonth) continue;
      const i   = row.day - 1;
      const opp = parseFloat(row.opp) || 0;
      result.target.deals[i]++;
      result.target.deals_sum[i] = Math.round((result.target.deals_sum[i] + opp) * 100) / 100;
    }

    res.json({ month: monthKey, year, data: result });
  } catch (err) {
    console.error('[marketing/kunlik]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Schema ────────────────────────────────────────────────────────
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kunlik_plans (
      id         SERIAL PRIMARY KEY,
      section    TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      month      INTEGER NOT NULL,
      year       INTEGER NOT NULL,
      plan_value NUMERIC(15,2) NOT NULL DEFAULT 0,
      UNIQUE(section, metric_key, month, year)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kunlik_overrides (
      id         SERIAL PRIMARY KEY,
      section    TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      month      INTEGER NOT NULL,
      year       INTEGER NOT NULL,
      day        INTEGER NOT NULL,
      value      NUMERIC(15,2) NOT NULL,
      UNIQUE(section, metric_key, month, year, day)
    )
  `);
}
ensureSchema().catch(e => console.error('[marketing] schema error:', e.message));

// GET /api/marketing/kunlik-meta?month=iyun&year=2026
// Returns plans + overrides for both sections
router.get('/kunlik-meta', async (req, res) => {
  const monthKey = (req.query.month || '').toLowerCase();
  const year     = parseInt(req.query.year) || new Date().getFullYear();
  const monthNum = MONTH_NUMS[monthKey];
  if (!monthNum) return res.status(400).json({ error: `Unknown month: ${monthKey}` });

  try {
    const plansRes = await pool.query(
      'SELECT section, metric_key, plan_value FROM kunlik_plans WHERE month=$1 AND year=$2',
      [monthNum, year]
    );
    const overRes  = await pool.query(
      'SELECT section, metric_key, day, value FROM kunlik_overrides WHERE month=$1 AND year=$2',
      [monthNum, year]
    );

    // Structure: { target: { budget: 1500, leads: 550, ... }, instagram: {...} }
    const plans = { target: {}, instagram: {} };
    for (const r of plansRes.rows) plans[r.section][r.metric_key] = parseFloat(r.plan_value);

    // Structure: { target: { budget: { 1: 51, 2: 63 }, ... }, instagram: {...} }
    const overrides = { target: {}, instagram: {} };
    for (const r of overRes.rows) {
      if (!overrides[r.section][r.metric_key]) overrides[r.section][r.metric_key] = {};
      overrides[r.section][r.metric_key][r.day] = parseFloat(r.value);
    }

    res.json({ month: monthKey, year, plans, overrides });
  } catch (err) {
    console.error('[marketing/kunlik-meta GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/marketing/kunlik-plan
// Body: { section, metric_key, month, year, value }
router.put('/kunlik-plan', async (req, res) => {
  const { section, metric_key, month, year, value } = req.body;
  const monthNum = MONTH_NUMS[(month || '').toLowerCase()];
  if (!monthNum || !section || !metric_key)
    return res.status(400).json({ error: 'section, metric_key, month, year, value required' });

  try {
    await pool.query(`
      INSERT INTO kunlik_plans (section, metric_key, month, year, plan_value)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (section, metric_key, month, year)
      DO UPDATE SET plan_value = EXCLUDED.plan_value
    `, [section, metric_key, monthNum, year, parseFloat(value) || 0]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing/kunlik-plan PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/marketing/kunlik-override
// Body: { section, metric_key, month, year, day, value }
router.put('/kunlik-override', async (req, res) => {
  const { section, metric_key, month, year, day, value } = req.body;
  const monthNum = MONTH_NUMS[(month || '').toLowerCase()];
  if (!monthNum || !section || !metric_key || !day)
    return res.status(400).json({ error: 'section, metric_key, month, year, day, value required' });

  try {
    if (value === null || value === '' || value === undefined) {
      // Delete override (revert to auto)
      await pool.query(
        'DELETE FROM kunlik_overrides WHERE section=$1 AND metric_key=$2 AND month=$3 AND year=$4 AND day=$5',
        [section, metric_key, monthNum, year, day]
      );
    } else {
      await pool.query(`
        INSERT INTO kunlik_overrides (section, metric_key, month, year, day, value)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (section, metric_key, month, year, day)
        DO UPDATE SET value = EXCLUDED.value
      `, [section, metric_key, monthNum, year, day, parseFloat(value) || 0]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing/kunlik-override PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
