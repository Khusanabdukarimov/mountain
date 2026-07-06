const { Router } = require('express');
const pool = require('../db/pool');
const fs = require('fs');
const path = require('path');

const router = Router();

// ── Mode-aware SQL helpers ─────────────────────────────────────────

function leadModeClause(mode) {
  if (mode === 'amocrm')   return `AND l.source_id = 'UC_1WUFJB'`;
  if (mode === 'bitrix24') return `AND (l.source_id IS NULL OR l.source_id != 'UC_1WUFJB')`;
  return '';
}

function leadDateCond(mode, p1, p2) {
  const col = mode === 'amocrm' ? 'COALESCE(l.uf_amo_date, l.date_create)' : 'l.date_create';
  return `($${p1}::date IS NULL OR ${col}::date >= $${p1}::date)\n           AND ($${p2}::date IS NULL OR ${col}::date <= $${p2}::date)`;
}

function leadSrcCond(mode, pi) {
  const col = mode === 'amocrm' ? 'l.uf_filial' : 'l.source_id';
  return `($${pi}::text IS NULL OR ${col}::text = ANY(string_to_array($${pi}, ',')))`;
}

function dealModeClause(mode) {
  if (mode === 'amocrm')   return `AND d.source_id = 'UC_1WUFJB'`;
  if (mode === 'bitrix24') return `AND (d.source_id IS NULL OR d.source_id != 'UC_1WUFJB')`;
  return '';
}

function dealDateCond(mode, p1, p2) {
  const col = mode === 'amocrm' ? 'COALESCE(d.uf_amo_date, d.date_create)' : 'd.date_create';
  return `($${p1}::date IS NULL OR ${col}::date >= $${p1}::date)\n           AND ($${p2}::date IS NULL OR ${col}::date <= $${p2}::date)`;
}

function dealSrcCond(mode, pi) {
  if (mode === 'amocrm') {
    return `EXISTS (
      SELECT 1 FROM lead_phones lp
      JOIN leads l ON l.id = lp.lead_id
      WHERE lp.phone = ph.phone AND l.uf_filial = ANY(string_to_array($${pi}, ','))
    )`;
  } else {
    return `d.source_id = ANY(string_to_array($${pi}, ','))`;
  }
}

const SOURCE_NAMES = {
  'UC_O9BLGT': 'Facebook',
  'UC_3O8GTF': 'Instagram',
  'UC_89FPH6': 'Target',
  'UC_H1PMDS': 'Telegram forma',
  'REPEAT_SALE': 'Website forma',
  'CALL': "Qo'ng'iroq",
  'CALLBACK': "Qayta qo'ng'iroq",
  'Звонок': "Qo'ng'iroq",
  'ADVERTISING': 'Reklama',
  'UC_8BLFVY': "Ko'chadan",
  'UC_3F6D2K': 'Vakansiya',
  'UC_1WUFJB': 'amoCRM',
  'UC_P8729J': 'Tavsiya orqali (NPS)',
  'UC_BU2WXB': 'Networking',
  'UC_Y6RAXP': 'Qayta sotuv (LTV)',
  'UC_BOJPCA': 'Sovuq qo\'ng\'iroq',
  'UC_0QF8D1': 'Veb sayt',
  'UC_CKSPAM': 'Organik tashrif',
};

/**
 * GET /api/dashboard/stats
 * Simple counts + last sync state.
 */
router.get('/stats', async (req, res) => {
  const { mode } = req.query;
  const leadsWhere = mode === 'amocrm' ? `WHERE source_id = 'UC_1WUFJB'` : `WHERE (source_id IS NULL OR source_id != 'UC_1WUFJB')`;
  const dealsWhere = mode === 'amocrm' ? `WHERE source_id = 'UC_1WUFJB'` : `WHERE (source_id IS NULL OR source_id != 'UC_1WUFJB')`;
  try {
    const [leadsRes, dealsRes, syncRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM leads ${leadsWhere}`),
      pool.query(`SELECT COUNT(*) AS total FROM deals ${dealsWhere}`),
      pool.query('SELECT entity, last_sync, total_rows FROM sync_state ORDER BY entity'),
    ]);
    res.json({
      leads: parseInt(leadsRes.rows[0].total),
      deals: parseInt(dealsRes.rows[0].total),
      sync: syncRes.rows,
    });
  } catch (err) {
    console.error('[dashboard/stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/responsibles
 * Lead counts per responsible, broken down by stage.
 * Params: from, to, responsible_id, stage, source
 */
router.get('/responsibles', async (req, res) => {
  const { from, to, responsible_id, stage, source, mode } = req.query;
  const params = [
    from || null,
    to || null,
    responsible_id ? parseInt(responsible_id) : null,
    stage || null,
    source || null,
  ];

  try {
    const { rows } = await pool.query(
      `WITH fl AS (
         SELECT l.id, l.responsible_id, l.opportunity, s.bitrix_id AS stage_bid
         FROM leads l
         JOIN stages s ON s.id = l.stage_id
         WHERE ${leadDateCond(mode, 1, 2)}
           AND ($3::int  IS NULL OR l.responsible_id = $3::int)
           AND ($4::text IS NULL OR s.bitrix_id = $4::text)
           AND ${leadSrcCond(mode, 5)}
           ${leadModeClause(mode)}
       )
       SELECT
         r.id,
         TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
         COUNT(fl.id)                                                              AS total,
         COALESCE(SUM(fl.opportunity), 0)                                         AS revenue,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'NEW')                         AS yangi_lid,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_1KPATX','NO_ANSWER'))    AS javob_bermadi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_Q2U9EL','CALLBACK'))     AS qayta_aloqa,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_KXC3ZW','THINKING'))     AS oylab_koradi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_L28G68','CONSULTATION')) AS konsultatsiya,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_5G8244','NOT_TRANSFERRED')) AS otkazilmadi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('JUNK','ARCHIVE'))           AS sandiq,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'UC_F8K4GI')                  AS sifatsiz,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_NAZK5J','RECYCLED'))     AS bekor_boldi
       FROM responsibles r
       LEFT JOIN fl ON fl.responsible_id = r.id
       WHERE r.active = TRUE
       GROUP BY r.id, r.name, r.last_name
       ORDER BY total DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/responsibles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/funnel
 * Lead count per stage.
 * Params: from, to, responsible_id, source
 */
router.get('/funnel', async (req, res) => {
  const { from, to, responsible_id, source, mode } = req.query;
  const params = [
    from || null,
    to || null,
    responsible_id ? parseInt(responsible_id) : null,
    source || null,
  ];

  try {
    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.name,
         s.bitrix_id,
         s.sort_order,
         s.is_final,
         s.is_won,
         COUNT(l.id) AS total
       FROM stages s
       LEFT JOIN leads l ON l.stage_id = s.id
         AND ${leadDateCond(mode, 1, 2)}
         AND ($3::int  IS NULL OR l.responsible_id = $3::int)
         AND ${leadSrcCond(mode, 4)}
         ${leadModeClause(mode)}
       WHERE s.entity = 'lead'
       GROUP BY s.id, s.name, s.bitrix_id, s.sort_order, s.is_final, s.is_won
       ORDER BY s.sort_order`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/funnel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/leads
 * Paginated lead list.
 * Params: page, limit, responsible_id, stage_id, date_from, date_to, source_id, utm_source, utm_campaign
 */
router.get('/leads', async (req, res) => {
  const {
    page = 1, limit = 50, mode,
    responsible_id, stage_id, date_from, date_to,
    source_id, utm_source, utm_campaign,
  } = req.query;

  const isAmo = mode === 'amocrm';
  const conditions = isAmo ? [`l.source_id = 'UC_1WUFJB'`] : [];
  const params = [];

  if (responsible_id) { params.push(parseInt(responsible_id)); conditions.push(`l.responsible_id = $${params.length}`); }
  if (stage_id)       { params.push(parseInt(stage_id));       conditions.push(`l.stage_id = $${params.length}`); }
  if (date_from) { params.push(date_from); conditions.push(`l.date_create::date >= $${params.length}::date`); }
  if (date_to)   { params.push(date_to);   conditions.push(`l.date_create::date <= $${params.length}::date`); }
  if (source_id) {
    params.push(source_id);
    const srcCol = isAmo ? 'l.uf_filial' : 'l.source_id';
    conditions.push(`${srcCol} = $${params.length}`);
  }
  if (utm_source)     { params.push(utm_source);               conditions.push(`l.utm_source = $${params.length}`); }
  if (utm_campaign)   { params.push(utm_campaign);             conditions.push(`l.utm_campaign = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.push(parseInt(limit));  const limitIdx = params.length;
  params.push(offset);           const offsetIdx = params.length;

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT l.id,
           TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS responsible,
           s.name AS stage, l.opportunity, l.source_id, l.utm_source, l.utm_campaign,
           l.uf_segment, l.uf_filial, l.date_create, l.date_modify
         FROM leads l
         LEFT JOIN responsibles r ON r.id = l.responsible_id
         LEFT JOIN stages s ON s.id = l.stage_id
         ${where}
         ORDER BY l.date_create DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM leads l ${where}`,
        params.slice(0, params.length - 2)
      ),
    ]);
    res.json({
      total: parseInt(countRes.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit),
      data: dataRes.rows,
    });
  } catch (err) {
    console.error('[dashboard/leads]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/responsibles-list
 * All active responsibles for filter dropdown.
 */
router.get('/responsibles-list', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, TRIM(COALESCE(name,'') || ' ' || COALESCE(last_name,'')) AS full_name
       FROM responsibles WHERE active = TRUE ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/responsibles-list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/stages-list
 * All lead stages for filter dropdown.
 */
router.get('/stages-list', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT bitrix_id, name FROM stages
       WHERE entity = 'lead' AND sort_order > 0
       ORDER BY sort_order`
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/stages-list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/sources-list
 * Distinct source_id values for filter dropdown (excluding amoCRM).
 */
router.get('/sources-list', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT source_id AS source
       FROM leads
       WHERE source_id IS NOT NULL AND source_id != '' AND source_id != 'UC_1WUFJB'
       ORDER BY source`
    );
    res.json(rows.map(r => r.source));
  } catch (err) {
    console.error('[dashboard/sources-list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/tasks-summary
 * Tasks grouped by executor (responsible).
 * Params: from, to
 */
router.get('/tasks-summary', async (req, res) => {
  const { from, to, mode } = req.query;
  const params = [from || null, to || null];

  const leadFilter = mode === 'amocrm'
    ? `AND t.lead_id IS NOT NULL AND t.lead_id IN (SELECT id FROM leads WHERE source_id = 'UC_1WUFJB')`
    : ``;

  try {
    const { rows } = await pool.query(
      `SELECT
         r.id AS responsible_id,
         TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
         COUNT(t.id)                                                                              AS total,
         COUNT(t.id) FILTER (WHERE t.status IN ('pending','in_progress','review'))               AS in_progress,
         COUNT(t.id) FILTER (WHERE t.status = 'completed')                                       AS completed,
         COUNT(t.id) FILTER (WHERE t.deadline < NOW() AND t.status != 'completed')               AS overdue,
         COUNT(t.id) FILTER (WHERE t.status = 'completed' AND t.deadline IS NOT NULL AND t.date_closed > t.deadline) AS completed_late
       FROM responsibles r
       LEFT JOIN tasks t ON t.executor_id = r.id
         AND ($1::date IS NULL OR t.date_created >= $1::date)
         AND ($2::date IS NULL OR t.date_created < $2::date + INTERVAL '1 day')
         ${leadFilter}
       WHERE r.active = TRUE
       GROUP BY r.id, r.name, r.last_name
       HAVING COUNT(t.id) > 0
       ORDER BY total DESC`,
      params
    );
    res.json({ tasks: rows });
  } catch (err) {
    console.error('[dashboard/tasks-summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/cancel-reasons
 * Cancellation reason breakdown for UC_NAZK5J (Bekor bo'ldi) stage.
 * Params: from, to, responsible_id
 */
router.get('/cancel-reasons', async (req, res) => {
  const { from, to, responsible_id, mode } = req.query;
  const params = [from || null, to || null, responsible_id || null];
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(l.uf_cancel_reason, 'Noma''lum') AS reason,
         COUNT(*)::int AS total
       FROM leads l
       JOIN stages s ON s.id = l.stage_id AND s.bitrix_id = 'UC_NAZK5J'
       WHERE ${leadDateCond(mode, 1, 2)}
         AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
         ${leadModeClause(mode)}
       GROUP BY l.uf_cancel_reason
       ORDER BY total DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('[dashboard/cancel-reasons]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/junk-reasons
 * Disqualification reason breakdown for UC_F8K4GI (Sifatsiz) stage.
 * Params: from, to, responsible_id
 */
router.get('/junk-reasons', async (req, res) => {
  const { from, to, responsible_id, mode } = req.query;
  const params = [from || null, to || null, responsible_id || null];
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(l.uf_junk_reason, 'Noma''lum') AS reason,
         COUNT(*)::int AS total
       FROM leads l
       JOIN stages s ON s.id = l.stage_id AND s.bitrix_id = 'UC_F8K4GI'
       WHERE ${leadDateCond(mode, 1, 2)}
         AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
         ${leadModeClause(mode)}
       GROUP BY l.uf_junk_reason
       ORDER BY total DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('[dashboard/junk-reasons]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/deal-cancel-reasons
 * Cancellation reason breakdown for lost/cancelled deals.
 * Params: from, to, responsible_id
 */
router.get('/deal-cancel-reasons', async (req, res) => {
  const { from, to, responsible_id } = req.query;
  const params = [
    from || null,
    to || null,
    responsible_id ? parseInt(responsible_id) : null,
  ];
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(d.uf_cancel_reason, 'Noma''lum') AS reason,
         COUNT(*)::int AS total
       FROM deals d
       JOIN stages s ON s.id = d.stage_id AND s.is_final = true AND s.is_won = false
       WHERE ($1::date IS NULL OR d.date_create::date >= $1::date)
         AND ($2::date IS NULL OR d.date_create::date <= $2::date)
         AND ($3::int  IS NULL OR d.responsible_id = $3::int)
         AND (d.source_id IS NULL OR d.source_id NOT ILIKE '%amocrm%')
       GROUP BY d.uf_cancel_reason
       ORDER BY total DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('[dashboard/deal-cancel-reasons]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/deal-filter-options
 * Responsibles, deal stages, and sources for Sdelkalar filter panel.
 */
router.get('/deal-filter-options', async (req, res) => {
  const { mode } = req.query;
  try {
    const [respRes, stageRes, srcRes] = await Promise.all([
      pool.query(`SELECT id, TRIM(COALESCE(name,'') || ' ' || COALESCE(last_name,'')) AS full_name
                  FROM responsibles WHERE active = true ORDER BY name`),
      pool.query(`SELECT DISTINCT s.id, s.name FROM stages s
                  INNER JOIN deals d ON d.stage_id = s.id
                  ${mode === 'amocrm' ? "WHERE d.source_id = 'UC_1WUFJB'" : ""}
                  ORDER BY s.name`),
      mode === 'amocrm'
        ? Promise.resolve({ rows: [] })
        : pool.query(`SELECT DISTINCT source_id FROM deals
                    WHERE source_id IS NOT NULL AND source_id != ''
                    ORDER BY source_id LIMIT 30`),
    ]);

    let sources = [];
    if (mode === 'amocrm') {
      sources = [
        { id: 'Instagram', name: 'Instagram' },
        { id: 'Target', name: 'Target' },
        { id: 'Veb sayt', name: 'Veb sayt' },
        { id: 'Networking', name: 'Networking' },
        { id: 'Sovuq qo\'ng\'iroq', name: 'Sovuq qo\'ng\'iroq' },
        { id: 'Qidiruv', name: 'Qidiruv' },
        { id: 'Boshqalar', name: 'Boshqalar' }
      ];
    } else {
      sources = srcRes.rows.map(r => ({
        id: r.source_id,
        name: SOURCE_NAMES[r.source_id] || r.source_id,
      }));
    }

    res.json({
      responsibles: respRes.rows,
      stages: stageRes.rows,
      sources,
    });
  } catch (err) {
    console.error('[dashboard/deal-filter-options]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/deals-stats', async (req, res) => {
  const { from, to, responsible_id, stage_id, source, mode } = req.query;

  const extra = [];
  const params = [from || null, to || null];
  let pi = 3;
  if (responsible_id) { extra.push(`AND d.responsible_id::text = ANY(string_to_array($${pi++}, ','))`); params.push(responsible_id); }
  if (stage_id)       { extra.push(`AND d.stage_id::text = ANY(string_to_array($${pi++}, ','))`);       params.push(stage_id); }
  if (source) {
    extra.push(`AND ${dealSrcCond(mode, pi++)}`);
    params.push(source);
  }

  // Build payment-date subquery extra conditions (same param indices, inner alias d2)
  // Skip amocrm source condition (uses ph.phone lateral join not available inside subquery)
  const extraPay = [];
  let pi2 = 3;
  if (responsible_id) { extraPay.push(`AND d2.responsible_id::text = ANY(string_to_array($${pi2++}, ','))`); }
  if (stage_id)       { extraPay.push(`AND d2.stage_id::text = ANY(string_to_array($${pi2++}, ','))`); }
  if (source && mode !== 'amocrm') { extraPay.push(`AND d2.source_id = ANY(string_to_array($${pi2++}, ','))`); }

  const tolanganSubq = `(
    SELECT COALESCE(SUM(sub.amount), 0)
    FROM (
      SELECT p.amount_usd AS amount
      FROM deal_payments p
      JOIN deals d2 ON d2.id = p.deal_id
      JOIN stages s2 ON s2.id = d2.stage_id
      WHERE NOT (s2.is_final = true AND s2.is_won = false)
        AND p.paid_at BETWEEN $1::date AND $2::date
        ${extraPay.join(' ')}
      UNION ALL
      SELECT d2.uf_paid_sum AS amount
      FROM deals d2
      JOIN stages s2 ON s2.id = d2.stage_id
      WHERE d2.uf_paid_sum IS NOT NULL AND d2.uf_paid_sum > 0
        AND s2.is_won = true
        AND COALESCE(d2.uf_bp_sale_date, d2.uf_payment_date, d2.date_create)::date BETWEEN $1::date AND $2::date
        AND d2.id NOT IN (SELECT DISTINCT deal_id FROM deal_payments)
        ${extraPay.join(' ')}
    ) sub
  )::numeric`;

  try {
    const [dealRows, leadFunnelRows] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(d.id)::int AS total,
           COUNT(d.id) FILTER (WHERE s.is_final = false AND s.is_won = false)::int AS yangi,
           COUNT(d.id) FILTER (WHERE s.is_won = true)::int AS sotuv_boldi,
           COUNT(d.id) FILTER (WHERE s.bitrix_id = 'UC_W35V62' OR s.is_won = true)::int AS kelishuv_count,
           COUNT(d.id) FILTER (WHERE s.is_final = true AND s.is_won = false)::int  AS bekor,
           COALESCE(SUM(d.opportunity) FILTER (WHERE s.is_won = true AND d.currency_id = 'USD'), 0)::numeric AS jami_sotuv,
           ${tolanganSubq} AS tolangan,
           COALESCE(ROUND(AVG(d.opportunity) FILTER (WHERE s.is_won = true AND d.currency_id = 'USD'), 0), 0)::numeric AS ortacha_chek,
           ROUND(COUNT(d.id) FILTER (WHERE s.is_won = true)::numeric / NULLIF(COUNT(d.id), 0) * 100, 1) AS konversiya,
           COUNT(d.id) FILTER (WHERE s.is_won = true AND d.currency_id != 'USD')::int AS uzs_count
         FROM deals d
         LEFT JOIN stages s ON s.id = d.stage_id
         LEFT JOIN LATERAL (SELECT phone FROM deal_phones WHERE deal_id = d.id LIMIT 1) ph ON true
         WHERE ${dealDateCond(mode, 1, 2)}
           ${dealModeClause(mode)}
           ${extra.join(' ')}`,
        params
      ),
      pool.query(
        `SELECT
           COUNT(l.id) FILTER (WHERE s.bitrix_id IN (
             'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
             'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
             'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
           ))::int AS sifatli_lid,
           COUNT(l.id) FILTER (WHERE l.uf_tashrif_sanasi IS NOT NULL AND l.uf_tashrif_sanasi != '' AND l.uf_tashrif_sanasi != 'false')::int AS konsultatsiya_belgilandi,
           COUNT(l.id) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi
         FROM leads l
         LEFT JOIN stages s ON s.id = l.stage_id AND s.entity = 'lead'
         WHERE ($1::date IS NULL OR l.date_create::date >= $1::date)
           AND ($2::date IS NULL OR l.date_create::date <= $2::date)
           AND ($3::text IS NULL OR l.source_id = ANY(string_to_array($3, ',')))
           AND ($4::text IS NULL OR l.id IN (
             SELECT d.lead_id FROM deals d
             WHERE d.lead_id IS NOT NULL
               AND d.responsible_id::text = ANY(string_to_array($4, ','))
           ))`,
        [from || null, to || null, source || null, responsible_id || null]
      ),
    ]);
    res.json({ ...dealRows.rows[0], ...leadFunnelRows.rows[0] });
  } catch (err) {
    console.error('[dashboard/deals-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/deals-list', async (req, res) => {
  const { from, to, search, status, responsible_id, stage_id, source, mode } = req.query;
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  const buildWhere = (extra = []) => {
    const dateCond = dealDateCond(mode, 1, 2);
    const parts = [
      dateCond.split('\n')[0].trim(),
      dateCond.split('\n')[1].trim().replace(/^AND\s+/i, ''),
      dealModeClause(mode).slice(4)
    ];
    const statusPart =
      status === 'won'    ? 'AND s.is_won = true' :
      status === 'lost'   ? 'AND s.is_final = true AND s.is_won = false' :
      status === 'active' ? 'AND s.is_final = false' : '';
    if (statusPart) parts.push(statusPart.slice(4));
    return parts.concat(extra).filter(Boolean).map((p, i) => (i === 0 ? `WHERE ${p}` : `  AND ${p}`)).join('\n');
  };

  const baseParams = [from || null, to || null];
  let pi = 3;
  const extra = [];
  if (responsible_id) { extra.push(`d.responsible_id::text = ANY(string_to_array($${pi++}, ','))`); baseParams.push(responsible_id); }
  if (stage_id)       { extra.push(`d.stage_id::text = ANY(string_to_array($${pi++}, ','))`);       baseParams.push(stage_id); }
  if (source) {
    extra.push(dealSrcCond(mode, pi++));
    baseParams.push(source);
  }

  if (search) {
    extra.push(`(TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) ILIKE '%' || $${pi} || '%' OR d.source_id ILIKE '%' || $${pi} || '%' OR ph.phone ILIKE '%' || $${pi} || '%')`);
    baseParams.push(search);
    pi++;
  }

  try {
    const listParams = [...baseParams, limit, offset];
    const { rows } = await pool.query(
      `SELECT
         d.id,
         TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS responsible,
         COALESCE(ph.phone, '—')    AS mijoz,
         d.opportunity::numeric     AS summa,
         COALESCE(d.source_id, '—') AS manba,
         d.date_create              AS sana,
         s.name                     AS stage_name,
         s.is_won,
         s.is_final
       FROM deals d
       LEFT JOIN stages s ON s.id = d.stage_id
       LEFT JOIN responsibles r ON r.id = d.responsible_id
       LEFT JOIN LATERAL (SELECT phone FROM deal_phones WHERE deal_id = d.id LIMIT 1) ph ON true
       ${buildWhere(extra)}
       ORDER BY d.date_create DESC
       LIMIT $${pi} OFFSET $${pi + 1}`,
      listParams
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM deals d
       LEFT JOIN stages s ON s.id = d.stage_id
       LEFT JOIN responsibles r ON r.id = d.responsible_id
       LEFT JOIN LATERAL (SELECT phone FROM deal_phones WHERE deal_id = d.id LIMIT 1) ph ON true
       ${buildWhere(extra)}`,
      baseParams
    );

    const items = [];
    for (const row of rows) {
      let resolvedManba = row.manba;
      if (mode === 'amocrm' && row.mijoz && row.mijoz !== '—') {
        const { rows: filialRes } = await pool.query(`
          SELECT l.uf_filial FROM lead_phones lp
          JOIN leads l ON l.id = lp.lead_id
          WHERE lp.phone = $1 AND l.uf_filial IS NOT NULL AND l.uf_filial != ''
          LIMIT 1
        `, [row.mijoz]);
        resolvedManba = filialRes.length ? filialRes[0].uf_filial : 'Boshqalar';
      }
      items.push({
        ...row,
        manba: SOURCE_NAMES[resolvedManba] || resolvedManba || '—',
      });
    }

    res.json({ total: countRows[0].total, page, limit, items });
  } catch (err) {
    console.error('[dashboard/deals-list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/deals-conversion', async (req, res) => {
  const { from, to, mode, responsible_id, stage_id, source } = req.query;
  const extra = [];
  const params = [from || null, to || null];
  let pi = 3;
  if (responsible_id) { extra.push(`AND d.responsible_id::text = ANY(string_to_array($${pi++}, ','))`); params.push(responsible_id); }
  if (stage_id)       { extra.push(`AND d.stage_id::text = ANY(string_to_array($${pi++}, ','))`);       params.push(stage_id); }
  if (source)         { extra.push(`AND ${dealSrcCond(mode, pi++)}`);                                    params.push(source); }
  try {
    const { rows } = await pool.query(
      `WITH fd AS (
         SELECT d.id, d.responsible_id, d.opportunity, d.currency_id, s.is_won, s.is_final, s.bitrix_id AS stage_bid
         FROM deals d
         JOIN stages s ON s.id = d.stage_id
         LEFT JOIN LATERAL (SELECT phone FROM deal_phones WHERE deal_id = d.id LIMIT 1) ph ON true
         WHERE ${dealDateCond(mode, 1, 2)}
           ${dealModeClause(mode)}
           ${extra.join(' ')}
       )
       SELECT
         r.id AS responsible_id,
         TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
         r.work_position,
         COUNT(fd.id)::int AS total,
         COUNT(fd.id) FILTER (WHERE NOT fd.is_won = true AND NOT fd.is_final)::int AS jarayonda,
         COUNT(fd.id) FILTER (WHERE fd.is_won = true)::int AS sotuv_boldi,
         COUNT(fd.id) FILTER (WHERE fd.is_final AND NOT fd.is_won)::int AS bekor_boldi,
         COALESCE(SUM(fd.opportunity) FILTER (WHERE fd.is_won = true AND fd.currency_id = 'USD'), 0)::numeric AS jami_sotuv
       FROM responsibles r
       JOIN fd ON fd.responsible_id = r.id
       GROUP BY r.id, r.name, r.last_name, r.work_position
       HAVING COUNT(fd.id) > 0
       ORDER BY total DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/deals-conversion]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/deals-responsibles?from=&to=
 * Per-responsible deal counts broken down by actual deal stages.
 */
router.get('/deals-responsibles', async (req, res) => {
  const { from, to, mode, responsible_id, stage_id, source } = req.query;
  const extra = [];
  const params = [from || null, to || null];
  let pi = 3;
  if (responsible_id) { extra.push(`AND d.responsible_id::text = ANY(string_to_array($${pi++}, ','))`); params.push(responsible_id); }
  if (stage_id)       { extra.push(`AND d.stage_id::text = ANY(string_to_array($${pi++}, ','))`);       params.push(stage_id); }
  if (source)         { extra.push(`AND ${dealSrcCond(mode, pi++)}`);                                    params.push(source); }
  try {
    const { rows } = await pool.query(
      `WITH fd AS (
         SELECT d.id, d.responsible_id, s.bitrix_id AS stage_bid, s.is_won, s.is_final
         FROM deals d
         JOIN stages s ON s.id = d.stage_id
         LEFT JOIN LATERAL (SELECT phone FROM deal_phones WHERE deal_id = d.id LIMIT 1) ph ON true
         WHERE ${dealDateCond(mode, 1, 2)}
           ${dealModeClause(mode)}
           ${extra.join(' ')}
       )
       SELECT
         r.id AS responsible_id,
         TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
         r.work_position,
         COUNT(fd.id)::int AS total,
         COUNT(fd.id) FILTER (WHERE fd.stage_bid IN ('NEW','C1:NEW','C1:CONSULTATION_DONE'))::int              AS konsultatsiya,
         COUNT(fd.id) FILTER (WHERE fd.stage_bid IN ('UC_W35V62','C1:AGREEMENT'))::int                         AS kelishuv,
         COUNT(fd.id) FILTER (WHERE fd.stage_bid IN ('UC_EHGFKW','UC_3BDUY6'))::int                           AS ish_boshlandi,
         COUNT(fd.id) FILTER (WHERE fd.is_won = true)::int AS sotuv_boldi,
         COUNT(fd.id) FILTER (WHERE fd.is_final AND NOT fd.is_won)::int                                        AS bekor_boldi
       FROM responsibles r
       JOIN fd ON fd.responsible_id = r.id
       GROUP BY r.id, r.name, r.last_name, r.work_position
       HAVING COUNT(fd.id) > 0
       ORDER BY total DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/deals-responsibles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/amocrm-sources
 * Distinct amoCRM sub-source values (uf_filial = UF_CRM_1778260858916).
 */
router.get('/amocrm-sources', async (_req, res) => {
  // Try DB first; on failure, fall back to a local JSON file so UI can work without Postgres.
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT uf_filial AS source
       FROM leads
       WHERE source_id = 'UC_1WUFJB'
         AND uf_filial IS NOT NULL AND uf_filial != '' AND uf_filial != 'false'
       ORDER BY source`
    );
    return res.json(rows.map(r => r.source));
  } catch (err) {
    console.error('[dashboard/amocrm-sources] DB query failed:', err.message || err);
    // Fallback: look for bitrix-sync/amocrm_sources.json in cwd
    try {
      const file = path.resolve(process.cwd(), 'amocrm_sources.json');
      if (fs.existsSync(file)) {
        const txt = fs.readFileSync(file, 'utf8');
        const arr = JSON.parse(txt);
        if (Array.isArray(arr)) return res.json(arr);
      }
    } catch (fe) {
      console.error('[dashboard/amocrm-sources] fallback read failed:', fe.message || fe);
    }
    res.status(500).json({ error: 'Failed to load amoCRM sources (DB error and no fallback file)' });
  }
});

// ══════════════════════════════════════════════════════════════════
// Lead dashboard endpoints — single source of truth (replaces Python)
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/dashboard/lead-stats
 * Header KPIs + funnel per stage.  Replaces Python /api/stats.
 * Params: from, to, responsible_id, stage, source, mode
 */
router.get('/lead-stats', async (req, res) => {
  const { from, to, responsible_id, stage, source, mode } = req.query;

  const statsParams  = [from || null, to || null, responsible_id || null, stage || null, source || null];
  const funnelParams = [from || null, to || null, responsible_id || null, source || null];

  const statsWhere = `${leadDateCond(mode, 1, 2)}
      AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
      AND ($4::text IS NULL OR s.bitrix_id = ANY(string_to_array($4, ',')))
      AND ${leadSrcCond(mode, 5)}
      ${leadModeClause(mode)}`;

  const funnelJoin = `${leadDateCond(mode, 1, 2)}
      AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
      AND ${leadSrcCond(mode, 4)}
      ${leadModeClause(mode)}`;

  try {
    const [statsRes, funnelRes, callsRes, dealFunnelRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int                                                                       AS total_leads,
           COUNT(*) FILTER (WHERE NOT s.is_final)::int                                        AS in_process,
           COUNT(*) FILTER (WHERE s.is_final AND NOT s.is_won)::int                           AS failed,
           COUNT(*) FILTER (WHERE s.is_final AND s.is_won)::int                               AS converted,
           ROUND(COUNT(*) FILTER (WHERE s.is_final AND s.is_won)::numeric
                 / NULLIF(COUNT(*), 0) * 100, 2)                                              AS conversion_pct,
           COALESCE(SUM(l.opportunity), 0)::numeric                                           AS total_opportunity,
           COALESCE(ROUND(AVG(l.opportunity), 0), 0)::numeric                                 AS avg_opportunity,
           COUNT(*) FILTER (WHERE NOT s.is_final AND l.date_modify < NOW() - INTERVAL '7 days')::int AS frozen_leads,
           ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - l.date_create)) / 86400.0)
             FILTER (WHERE NOT s.is_final), 1)                                                AS avg_age_days,
           COUNT(l.id) FILTER (WHERE s.bitrix_id = 'UC_F8K4GI')::int                         AS sifatsiz_bekor_count,
           COUNT(l.id) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int           AS bekor_boldi_count,
           COUNT(l.id) FILTER (WHERE s.bitrix_id IN (
             'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
             'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
             'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
           ))::int AS sifatli_lid_count,
           COUNT(l.id) FILTER (WHERE l.uf_tashrif_sanasi IS NOT NULL AND l.uf_tashrif_sanasi != '' AND l.uf_tashrif_sanasi != 'false')::int AS konsultatsiya_belgilandi_count,
           COUNT(l.id) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int  AS konsultatsiya_otkazildi_count,
           COUNT(l.id) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK'))::int                AS muvaffaqiyatsiz_count
         FROM leads l
         JOIN stages s ON s.id = l.stage_id
         WHERE ${statsWhere}`,
        statsParams
      ),
      pool.query(
        `SELECT
           s.bitrix_id,
           s.name AS name_uz,
           s.sort_order,
           COUNT(l.id)::int                          AS lead_count,
           COALESCE(SUM(l.opportunity), 0)::numeric  AS total_opportunity
         FROM stages s
         LEFT JOIN leads l ON l.stage_id = s.id AND ${funnelJoin}
         WHERE s.entity = 'lead' AND s.sort_order > 0
         GROUP BY s.id, s.bitrix_id, s.name, s.sort_order
         ORDER BY s.sort_order`,
        funnelParams
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total_calls
         FROM calls
         WHERE ($1::date IS NULL OR (call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
           AND ($2::date IS NULL OR (call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)`,
        [from || null, to || null]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE s.bitrix_id = 'UC_W35V62' OR s.is_won = true)::int AS kelishuv_count,
           COUNT(*) FILTER (WHERE s.is_won = true)::int                               AS sotuv_count
         FROM deals d
         LEFT JOIN stages s ON s.id = d.stage_id AND s.entity = 'deal'
         LEFT JOIN leads l ON l.id = d.lead_id
         WHERE ($1::date IS NULL OR d.date_create::date >= $1::date)
           AND ($2::date IS NULL OR d.date_create::date <= $2::date)
           AND ($3::text IS NULL OR d.source_id = ANY(string_to_array($3, ',')))
           AND ($4::text IS NULL OR (
             CASE WHEN d.lead_id IS NOT NULL
               THEN l.responsible_id::text = ANY(string_to_array($4, ','))
               ELSE d.responsible_id::text = ANY(string_to_array($4, ','))
             END
           ))`,
        [from || null, to || null, source || null, responsible_id || null]
      ),
    ]);
    const header = {
      ...(statsRes.rows[0] || {}),
      total_calls:    callsRes.rows[0]?.total_calls ?? 0,
      kelishuv_count: dealFunnelRes.rows[0]?.kelishuv_count ?? 0,
      sotuv_count:    dealFunnelRes.rows[0]?.sotuv_count ?? 0,
    };
    res.json({ header, funnel: funnelRes.rows });
  } catch (err) {
    console.error('[dashboard/lead-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/lead-responsibles
 * Per-responsible lead breakdown with all stage columns.  Replaces Python /api/responsibles.
 */
router.get('/lead-responsibles', async (req, res) => {
  const { from, to, responsible_id, stage, source, mode } = req.query;
  const params = [from || null, to || null, responsible_id || null, stage || null, source || null];

  try {
    const { rows } = await pool.query(
      `WITH fl AS (
         SELECT l.id, l.responsible_id, l.opportunity, s.bitrix_id AS stage_bid
         FROM leads l
         JOIN stages s ON s.id = l.stage_id
         WHERE ${leadDateCond(mode, 1, 2)}
           AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
           AND ($4::text IS NULL OR s.bitrix_id = ANY(string_to_array($4, ',')))
           AND ${leadSrcCond(mode, 5)}
           ${leadModeClause(mode)}
       )
       SELECT
         r.id                                                                                  AS responsible_id,
         TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,''))                         AS full_name,
         COUNT(fl.id)::int                                                                     AS total,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'NEW')::int                                AS qongiroqlar,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'IN_PROCESS')::int                         AS yangi_lid,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'PROCESSED')::int                          AS propushenniy,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_1KPATX','NO_ANSWER'))::int            AS javob_bermadi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_Q2U9EL','CALLBACK'))::int             AS qayta_aloqa,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_KXC3ZW','THINKING'))::int             AS oylab_koradi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_L28G68','CONSULTATION'))::int         AS konsultatsiya,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_5G8244','NOT_TRANSFERRED'))::int      AS otkazilmadi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'CONVERTED')::int                          AS konsultatsiya_otkazildi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('JUNK','ARCHIVE'))::int                   AS sandiq,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'UC_F8K4GI')::int                          AS sifatsiz,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_NAZK5J','RECYCLED'))::int             AS bekor_boldi,
         COALESCE(SUM(fl.opportunity), 0)::numeric                                            AS total_opportunity
       FROM responsibles r
       LEFT JOIN fl ON fl.responsible_id = r.id
       WHERE r.active = TRUE
       GROUP BY r.id, r.name, r.last_name, r.work_position
       ORDER BY total DESC`,
      params
    );
    res.json({ responsibles: rows });
  } catch (err) {
    console.error('[dashboard/lead-responsibles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/lead-conversion
 * Per-responsible conversion funnel.  Replaces Python /api/conversion.
 */
router.get('/lead-conversion', async (req, res) => {
  const { from, to, responsible_id, stage, source, mode } = req.query;
  const params = [from || null, to || null, responsible_id || null, stage || null, source || null];

  try {
    const { rows } = await pool.query(
      `WITH fl AS (
         SELECT l.id, l.responsible_id, s.bitrix_id AS stage_bid
         FROM leads l
         JOIN stages s ON s.id = l.stage_id
         WHERE ${leadDateCond(mode, 1, 2)}
           AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
           AND ($4::text IS NULL OR s.bitrix_id = ANY(string_to_array($4, ',')))
           AND ${leadSrcCond(mode, 5)}
           ${leadModeClause(mode)}
       )
       SELECT
         r.id                                                                                  AS responsible_id,
         TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,''))                         AS full_name,
         COUNT(fl.id)::int                                                                     AS total,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN (
           'NEW','IN_PROCESS','PROCESSED',
           'UC_1KPATX','UC_Q2U9EL','UC_KXC3ZW','UC_L28G68','UC_5G8244'
         ))::int                                                                               AS jarayonda,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN (
           'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
           'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
           'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
         ))::int                                                                               AS sifatli_lid,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_F8K4GI','JUNK'))::int                AS sifatsiz_lid,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid IN ('UC_NAZK5J','RECYCLED'))::int             AS bekor_boldi,
         COUNT(fl.id) FILTER (WHERE fl.stage_bid = 'CONVERTED')::int                         AS tashrif_buyurdi
       FROM responsibles r
       LEFT JOIN fl ON fl.responsible_id = r.id
       WHERE r.active = TRUE
       GROUP BY r.id, r.name, r.last_name
       ORDER BY total DESC`,
      params
    );
    res.json({ conversion: rows });
  } catch (err) {
    console.error('[dashboard/lead-conversion]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/lead-filter-options
 * Responsibles, lead stages, and sources.  Replaces Python /api/filter-options.
 */
router.get('/lead-filter-options', async (req, res) => {
  const { mode } = req.query;
  const srcExclude = mode === 'bitrix24'
    ? `AND source_id != 'UC_1WUFJB'`
    : mode === 'amocrm'
      ? `AND source_id = 'UC_1WUFJB'`
      : '';
  try {
    const [respRes, stageRes, srcRes, formRes] = await Promise.all([
      pool.query(
        `SELECT id, TRIM(COALESCE(name,'') || ' ' || COALESCE(last_name,'')) AS full_name
         FROM responsibles WHERE active = TRUE ORDER BY name`
      ),
      pool.query(
        `SELECT bitrix_id, name FROM stages
         WHERE entity = 'lead' AND sort_order > 0
         ORDER BY sort_order`
      ),
      pool.query(
        `SELECT DISTINCT source_id FROM leads
         WHERE source_id IS NOT NULL AND source_id != '' ${srcExclude}
         ORDER BY source_id LIMIT 60`
      ),
      pool.query(
        `SELECT form_id AS id, form_name AS name, lead_count
         FROM crm_forms
         WHERE active = TRUE
         ORDER BY lead_count DESC NULLS LAST, name`
      ).catch(() => ({ rows: [] })),
    ]);
    res.json({
      responsibles: respRes.rows,
      stages: stageRes.rows,
      sources: srcRes.rows.map(r => ({ id: r.source_id, name: SOURCE_NAMES[r.source_id] || r.source_id })),
      forms: formRes.rows.map(r => ({ id: r.id, name: r.name, count: r.lead_count })),
    });
  } catch (err) {
    console.error('[dashboard/lead-filter-options]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/taqsimot
 * Returns all active responsibles with their taqsimot_pct values.
 */
router.get('/taqsimot', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
              r.email, r.work_position, r.taqsimot_pct
       FROM responsibles r
       WHERE r.active = TRUE
       ORDER BY r.name`
    );
    res.json({ responsibles: rows });
  } catch (err) {
    console.error('[dashboard/taqsimot GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/dashboard/taqsimot/:id
 * Body: { "taqsimot_pct": 22.5 }
 * Updates responsibles.taqsimot_pct and returns new total across all active distributors.
 */
router.put('/taqsimot/:id', async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const pct = parseFloat(req.body?.taqsimot_pct);
  if (isNaN(id) || isNaN(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ error: 'Invalid id or taqsimot_pct (0–100)' });
  }
  try {
    await pool.query(
      `UPDATE responsibles SET taqsimot_pct = $1 WHERE id = $2`,
      [pct, id]
    );
    const { rows } = await pool.query(
      `SELECT SUM(taqsimot_pct)::numeric AS total
       FROM responsibles WHERE taqsimot_pct > 0 AND active = TRUE`
    );
    const total = parseFloat(rows[0].total || 0);
    res.json({
      ok: true,
      id,
      taqsimot_pct: pct,
      total_pct: total,
      warning: total !== 100 ? `Jami: ${total}% (100% bo'lishi kerak)` : null,
    });
  } catch (err) {
    console.error('[dashboard/taqsimot PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/taqsimot-stats
 * Today's distribution accuracy per responsible.
 */
router.get('/taqsimot-stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        r.id,
        TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name,
        r.taqsimot_pct::float                                         AS target_pct,
        COUNT(l.id)::int                                              AS today_count,
        ROUND(
          COUNT(l.id)::numeric /
          NULLIF(SUM(COUNT(l.id)) OVER(), 0) * 100, 1
        )::float                                                      AS actual_pct,
        ROUND(
          r.taqsimot_pct -
          (COUNT(l.id)::numeric / NULLIF(SUM(COUNT(l.id)) OVER(), 0) * 100), 1
        )::float                                                      AS deficit_pct
      FROM responsibles r
      LEFT JOIN leads l ON l.responsible_id = r.id
        AND l.date_create >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
        AND (l.source_id IS NULL OR l.source_id != 'UC_1WUFJB')
      WHERE r.taqsimot_pct > 0 AND r.active = TRUE
      GROUP BY r.id, r.name, r.last_name, r.taqsimot_pct
      ORDER BY r.taqsimot_pct DESC
    `);
    res.json({ stats: rows, date: new Date().toISOString() });
  } catch (err) {
    console.error('[dashboard/taqsimot-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/utm-campaign-stats', async (req, res) => {
  const { from, to, mode, utm_source, utm_medium } = req.query;
  if (!utm_source) return res.status(400).json({ error: 'utm_source required' });
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(NULLIF(l.utm_campaign, ''), 'Nomalum') AS utm_campaign,
         COUNT(*)::int                                                              AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244','IN_PROCESS'
         ))::int AS jarayonda,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
           'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
           'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
         ))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi,
         COUNT(DISTINCT l.responsible_id)::int                                     AS responsible_count
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       WHERE ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND ($3::text IS NULL OR TRIM(l.utm_source) = $3)
         AND ($4::text IS NULL OR COALESCE(NULLIF(TRIM(l.utm_medium),''),'Nomalum') = $4)
         ${leadModeClause(mode)}
       GROUP BY COALESCE(NULLIF(l.utm_campaign, ''), 'Nomalum')
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, utm_source || null, utm_medium || null],
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/utm-campaign-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/utm-medium-stats', async (req, res) => {
  const { from, to, mode, utm_source } = req.query;
  if (!utm_source) return res.status(400).json({ error: 'utm_source required' });
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(l.utm_medium), ''), 'Nomalum') AS utm_medium,
         COUNT(*)::int AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244','IN_PROCESS'
         ))::int AS jarayonda,
         (COUNT(*) - COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_F8K4GI','UC_NAZK5J','RECYCLED','JUNK','ARCHIVE'
         )))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi,
         COUNT(DISTINCT NULLIF(l.utm_campaign, ''))::int AS campaign_count
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       WHERE ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND TRIM(l.utm_source) = $3
         ${leadModeClause(mode)}
       GROUP BY COALESCE(NULLIF(TRIM(l.utm_medium), ''), 'Nomalum')
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, utm_source],
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/utm-medium-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/utm-content-stats', async (req, res) => {
  const { from, to, mode, utm_source, utm_medium, utm_campaign } = req.query;
  if (!utm_source) return res.status(400).json({ error: 'utm_source required' });
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(l.utm_content), ''), 'Nomalum') AS utm_content,
         COUNT(*)::int AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244','IN_PROCESS'
         ))::int AS jarayonda,
         (COUNT(*) - COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_F8K4GI','UC_NAZK5J','RECYCLED','JUNK','ARCHIVE'
         )))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi,
         COUNT(DISTINCT l.responsible_id)::int AS responsible_count
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       WHERE ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND ($3::text IS NULL OR TRIM(l.utm_source) = $3)
         AND ($4::text IS NULL OR COALESCE(NULLIF(TRIM(l.utm_medium),''),'Nomalum') = $4)
         AND (
           $5::text IS NULL
           OR ($5 = 'Nomalum' AND (l.utm_campaign IS NULL OR l.utm_campaign = ''))
           OR ($5 != 'Nomalum' AND l.utm_campaign = $5)
         )
         ${leadModeClause(mode)}
       GROUP BY COALESCE(NULLIF(TRIM(l.utm_content), ''), 'Nomalum')
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, utm_source || null, utm_medium || null, utm_campaign || null],
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/utm-content-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/utm-term-stats', async (req, res) => {
  const { from, to, mode, utm_source, utm_medium, utm_campaign, utm_content } = req.query;
  if (!utm_source) return res.status(400).json({ error: 'utm_source required' });
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(l.utm_term), ''), 'Nomalum') AS utm_term,
         COUNT(*)::int AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244','IN_PROCESS'
         ))::int AS jarayonda,
         (COUNT(*) - COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_F8K4GI','UC_NAZK5J','RECYCLED','JUNK','ARCHIVE'
         )))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi,
         COUNT(DISTINCT l.responsible_id)::int AS responsible_count
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       WHERE ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND ($3::text IS NULL OR TRIM(l.utm_source) = $3)
         AND ($4::text IS NULL OR COALESCE(NULLIF(TRIM(l.utm_medium),''),'Nomalum') = $4)
         AND (
           $5::text IS NULL
           OR ($5 = 'Nomalum' AND (l.utm_campaign IS NULL OR l.utm_campaign = ''))
           OR ($5 != 'Nomalum' AND l.utm_campaign = $5)
         )
         AND (
           $6::text IS NULL
           OR ($6 = 'Nomalum' AND (l.utm_content IS NULL OR l.utm_content = ''))
           OR ($6 != 'Nomalum' AND l.utm_content = $6)
         )
         ${leadModeClause(mode)}
       GROUP BY COALESCE(NULLIF(TRIM(l.utm_term), ''), 'Nomalum')
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, utm_source || null, utm_medium || null, utm_campaign || null, utm_content || null],
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/utm-term-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/utm-responsible-stats', async (req, res) => {
  const { from, to, mode, utm_source, utm_campaign, utm_medium, utm_content, utm_term } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')), 'Nomalum') AS full_name,
         l.responsible_id,
         COUNT(*)::int                                                              AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244','IN_PROCESS'
         ))::int AS jarayonda,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
           'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
           'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
         ))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       LEFT JOIN responsibles r ON r.id = l.responsible_id
       WHERE ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND ($3::text IS NULL OR TRIM(l.utm_source) = $3)
         AND (
           $4::text IS NULL
           OR ($4 = 'Nomalum' AND (l.utm_campaign IS NULL OR l.utm_campaign = ''))
           OR ($4 != 'Nomalum' AND l.utm_campaign = $4)
         )
         AND ($5::text IS NULL OR COALESCE(NULLIF(TRIM(l.utm_medium),''),'Nomalum') = $5)
         AND (
           $6::text IS NULL
           OR ($6 = 'Nomalum' AND (l.utm_content IS NULL OR l.utm_content = ''))
           OR ($6 != 'Nomalum' AND l.utm_content = $6)
         )
         AND (
           $7::text IS NULL
           OR ($7 = 'Nomalum' AND (l.utm_term IS NULL OR l.utm_term = ''))
           OR ($7 != 'Nomalum' AND l.utm_term = $7)
         )
         ${leadModeClause(mode)}
       GROUP BY l.responsible_id, r.name, r.last_name
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, utm_source || null, utm_campaign || null, utm_medium || null, utm_content || null, utm_term || null],
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/utm-responsible-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/utm-stats', async (req, res) => {
  const { from, to, mode, form_id } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         TRIM(l.utm_source) AS utm_source,
         COUNT(*)::int                                                              AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244','IN_PROCESS'
         ))::int AS jarayonda,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
           'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
           'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
         ))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi,
         COUNT(DISTINCT NULLIF(l.utm_campaign, ''))::int                           AS campaign_count
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       WHERE l.utm_source IS NOT NULL AND TRIM(l.utm_source) != ''
         AND ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND ($3::text IS NULL
              OR NOT EXISTS (SELECT 1 FROM crm_forms WHERE form_id = $3 AND fb_form_id IS NOT NULL)
              OR EXISTS (
                SELECT 1 FROM crm_forms cf2
                WHERE cf2.form_id = $3 AND cf2.fb_form_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM lead_phones lp
                    JOIN facebook_leads fl ON fl.phone = lp.phone
                    WHERE lp.lead_id = l.id AND fl.form_id = cf2.fb_form_id
                  )
              ))
         ${leadModeClause(mode)}
       GROUP BY TRIM(l.utm_source)
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, form_id || null],
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/utm-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/source-stats
 * Leads grouped by source with funnel breakdown.
 * Params: from, to, responsible_id, mode
 */
router.get('/source-stats', async (req, res) => {
  const { from, to, responsible_id, mode } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(l.source_id, 'Nomalum') AS source_id,
         COUNT(*)::int AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244',
           'IN_PROCESS'
         ))::int AS jarayonda,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
           'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
           'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
         ))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       WHERE ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
         ${leadModeClause(mode)}
       GROUP BY COALESCE(l.source_id, 'Nomalum')
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, responsible_id || null]
    );
    res.json(rows.map(r => ({
      ...r,
      source_name: SOURCE_NAMES[r.source_id] || r.source_id,
    })));
  } catch (err) {
    console.error('[dashboard/source-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/form-stats
 * Leads grouped by web_form_id (direct DB field), joined with crm_forms for name.
 * Params: from, to, responsible_id, mode
 */
router.get('/form-stats', async (req, res) => {
  const { from, to, responsible_id, mode } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         l.web_form_id,
         COALESCE(cf.form_name, 'Noma''lum') AS form_name,
         COUNT(*)::int AS umumiy_lidlar,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'NEW','NO_ANSWER','UC_1KPATX','CALLBACK','UC_Q2U9EL',
           'THINKING','UC_KXC3ZW','NOT_TRANSFERRED','UC_5G8244','IN_PROCESS'
         ))::int AS jarayonda,
         COUNT(*) FILTER (WHERE s.bitrix_id IN (
           'UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
           'CONVERTED_CONSULT','CONVERTED','UC_NAZK5J','RECYCLED',
           'UC_5G8244','NOT_TRANSFERRED','JUNK','ARCHIVE'
         ))::int AS sifatli_lid,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int AS konsultatsiya_belgilandi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int AS konsultatsiya_otkazildi,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_F8K4GI','JUNK','ARCHIVE'))::int AS sifatsiz,
         COUNT(*) FILTER (WHERE s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int AS bekor_boldi
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       LEFT JOIN crm_forms cf ON cf.form_id = l.web_form_id::text
       WHERE l.web_form_id IS NOT NULL AND TRIM(l.web_form_id::text) != ''
         AND ($1::date IS NULL OR l.date_create::date >= $1::date)
         AND ($2::date IS NULL OR l.date_create::date <= $2::date)
         AND ($3::text IS NULL OR l.responsible_id::text = ANY(string_to_array($3, ',')))
         ${leadModeClause(mode)}
       GROUP BY l.web_form_id, cf.form_name
       ORDER BY umumiy_lidlar DESC`,
      [from || null, to || null, responsible_id || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/form-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/dashboard/sync-crm-forms
 * Fetches CRM forms from Bitrix24 and upserts into crm_forms table.
 */
router.post('/sync-crm-forms', async (_req, res) => {
  const BITRIX_URL = process.env.BITRIX_WEBHOOK_URL;
  if (!BITRIX_URL) return res.status(500).json({ error: 'BITRIX_WEBHOOK_URL not set' });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_forms (
        form_id     TEXT PRIMARY KEY,
        form_name   TEXT,
        active      BOOLEAN DEFAULT TRUE,
        lead_count  INT,
        fb_form_id  TEXT,
        synced_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE crm_forms ADD COLUMN IF NOT EXISTS fb_form_id TEXT
    `);
    const resp = await fetch(`${BITRIX_URL}crm.webform.list`);
    const json = await resp.json();
    const forms = json.result || [];
    for (const f of forms) {
      await pool.query(
        `INSERT INTO crm_forms (form_id, form_name, active, synced_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (form_id) DO UPDATE SET
           form_name = EXCLUDED.form_name,
           active    = EXCLUDED.active,
           synced_at = NOW()`,
        [String(f.ID), f.NAME, f.ACTIVE === 'Y']
      );
    }
    // Try to link Bitrix24 form to Facebook form_id by matching form name → campaign_name/adset_name
    await pool.query(`
      UPDATE crm_forms cf SET fb_form_id = sub.form_id
      FROM (
        SELECT form_id,
               MAX(COALESCE(NULLIF(campaign_name,''), adset_name)) AS display_name,
               COUNT(*)::int AS cnt
        FROM facebook_leads WHERE form_id IS NOT NULL
        GROUP BY form_id
      ) sub
      WHERE sub.display_name ILIKE '%' || cf.form_name || '%'
         OR cf.form_name ILIKE '%' || sub.display_name || '%'
    `);
    // Update lead_count from linked facebook_leads
    await pool.query(`
      UPDATE crm_forms cf SET lead_count = sub.cnt
      FROM (
        SELECT form_id, COUNT(*)::int AS cnt FROM facebook_leads
        WHERE form_id IS NOT NULL GROUP BY form_id
      ) sub
      WHERE cf.fb_form_id = sub.form_id
    `);
    res.json({ ok: true, synced: forms.length });
  } catch (err) {
    console.error('[dashboard/sync-crm-forms]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Call sync helpers (voximplant.statistic.get) ──────────────────
async function ensureCallsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id               TEXT PRIMARY KEY,
      responsible_id   INT,
      phone_number     TEXT,
      call_type        INT,
      duration         INT,
      call_start       TIMESTAMPTZ,
      status_code      INT,
      status_name      TEXT,
      lead_id          INT,
      crm_entity_type  TEXT,
      user_name        TEXT,
      failed_code      TEXT,
      call_category    TEXT,
      call_source      TEXT,
      synced_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add photo_url to responsibles if missing
  await pool.query(`ALTER TABLE responsibles ADD COLUMN IF NOT EXISTS photo_url TEXT`);
  // Migrate existing table — add missing columns if needed
  await pool.query(`
    ALTER TABLE calls
      ADD COLUMN IF NOT EXISTS status_name     TEXT,
      ADD COLUMN IF NOT EXISTS lead_id         INT,
      ADD COLUMN IF NOT EXISTS deal_id         INT,
      ADD COLUMN IF NOT EXISTS crm_entity_type TEXT,
      ADD COLUMN IF NOT EXISTS user_name       TEXT,
      ADD COLUMN IF NOT EXISTS failed_code     TEXT,
      ADD COLUMN IF NOT EXISTS call_category   TEXT,
      ADD COLUMN IF NOT EXISTS call_source     TEXT
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS calls_deal_id_idx ON calls(deal_id)`);
  await pool.query(`
    ALTER TABLE calls
      ALTER COLUMN failed_code TYPE TEXT USING failed_code::text
  `);
  await pool.query(`
    UPDATE calls
    SET call_type = CASE call_type WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE call_type END,
        call_source = 'activity'
    WHERE id LIKE 'act_%'
      AND call_source IS NULL
  `);
  await pool.query(`
    UPDATE calls
    SET call_source = 'voximplant'
    WHERE call_source IS NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS calls_call_start_idx ON calls(call_start)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS calls_responsible_idx ON calls(responsible_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS calls_phone_idx ON calls(phone_number)`);
  // Prefer voximplant over crm.activity when both sources have the same call.
  await pool.query(`
    DELETE FROM calls
    WHERE id LIKE 'act_%'
      AND EXISTS (
        SELECT 1 FROM calls c2
        WHERE c2.id NOT LIKE 'act_%'
          AND c2.responsible_id = calls.responsible_id
          AND ABS(EXTRACT(EPOCH FROM (c2.call_start - calls.call_start))) < 120
      )
  `);
}

async function syncCallUsersFromBitrix() {
  const { fetchAll } = require('../services/bitrix');
  const users = await fetchAll('user.get', { ACTIVE: 'Y' });
  await pool.query(`ALTER TABLE responsibles ADD COLUMN IF NOT EXISTS photo_url TEXT`);
  for (const u of users) {
    await pool.query(
      `INSERT INTO responsibles (id, name, last_name, email, work_position, active, photo_url, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         last_name = EXCLUDED.last_name,
         email = EXCLUDED.email,
         work_position = EXCLUDED.work_position,
         active = EXCLUDED.active,
         photo_url = COALESCE(EXCLUDED.photo_url, responsibles.photo_url),
         synced_at = NOW()`,
      [
        parseInt(u.ID),
        u.NAME || null,
        u.LAST_NAME || null,
        u.EMAIL || null,
        u.WORK_POSITION || null,
        u.ACTIVE === 'Y' || u.ACTIVE === true,
        u.PERSONAL_PHOTO || null,
      ]
    );
  }
  return users.length;
}

async function syncCallsFromBitrix(from, to) {
  await ensureCallsTable();
  const { fetchAll, bitrixCall } = require('../services/bitrix');

  // Try voximplant.statistic.get first (requires telephony scope on webhook)
  // Fallback: crm.activity.list with BINDINGS (works with crm scope)
  let records = [];
  let useVoxi = true;

  try {
    const filter = {};
    if (from) filter['>=CALL_START_DATE'] = `${from}T00:00:00`;
    if (to)   filter['<=CALL_START_DATE'] = `${to}T23:59:59`;

    const testRes = await bitrixCall('voximplant.statistic.get', {
      'FILTER[>=CALL_START_DATE]': filter['>=CALL_START_DATE'] || '',
      start: 0,
    });
    if (testRes.error === 'insufficient_scope') {
      useVoxi = false;
      console.log('[calls] voximplant scope missing, falling back to crm.activity.list');
    } else {
      await pool.query(
        `DELETE FROM calls
         WHERE id LIKE 'act_%'
           AND ($1::date IS NULL OR (call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
           AND ($2::date IS NULL OR (call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)`,
        [from || null, to || null],
      );
      records = await fetchAll('voximplant.statistic.get', filter, [
        'CALL_ID', 'PORTAL_USER_ID', 'PORTAL_USER',
        'PHONE_NUMBER', 'CALL_TYPE', 'CALL_DURATION',
        'CALL_START_DATE', 'CALL_START_TIME',
        'CALL_STATUS_CODE', 'CALL_STATUS_CODE_NAME',
        'CALL_FAILED_CODE', 'CALL_FAILED_REASON', 'CALL_CATEGORY',
        'CRM_ENTITY_ID', 'CRM_ENTITY_TYPE',
      ]);
    }
  } catch (e) {
    useVoxi = false;
    console.warn('[calls] voximplant error:', e.message);
  }

  if (!useVoxi) {
    // Remove old voximplant records for this date range to avoid 2x duplicates
    await pool.query(
      `DELETE FROM calls
       WHERE id NOT LIKE 'act_%'
         AND ($1::date IS NULL OR (call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         AND ($2::date IS NULL OR (call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)`,
      [from || null, to || null],
    );
    // Fallback: crm.activity.list (TYPE_ID=2 = calls)
    const filter = { TYPE_ID: 2 };
    if (from) filter['>=START_TIME'] = from;
    if (to)   filter['<=START_TIME'] = to;
    records = await fetchAll('crm.activity.list', filter, [
      'ID', 'RESPONSIBLE_ID', 'START_TIME', 'END_TIME',
      'DIRECTION', 'COMPLETED', 'SUBJECT', 'OWNER_ID', 'OWNER_TYPE_ID',
    ]);
  }

  let upserted = 0;
  for (const r of records) {
    let id, responsibleId, phoneNumber, callType, duration, callStart,
        statusCode, statusName, leadId, dealId, crmEntityType, userName,
        failedCode, callCategory, callSource;

    if (useVoxi) {
      id            = String(r.CALL_ID);
      responsibleId = r.PORTAL_USER_ID  ? parseInt(r.PORTAL_USER_ID)  : null;
      phoneNumber   = r.PHONE_NUMBER    || null;
      callType      = r.CALL_TYPE       ? parseInt(r.CALL_TYPE)        : null;
      duration      = r.CALL_DURATION   ? parseInt(r.CALL_DURATION)    : 0;
      callStart     = r.CALL_START_DATE || r.CALL_START_TIME || null;
      statusCode    = /^\d+$/.test(String(r.CALL_STATUS_CODE || '')) ? parseInt(r.CALL_STATUS_CODE) : null;
      statusName    = r.CALL_STATUS_CODE_NAME || null;
      failedCode    = r.CALL_FAILED_CODE != null && r.CALL_FAILED_CODE !== '' ? String(r.CALL_FAILED_CODE) : null;
      callCategory  = r.CALL_CATEGORY || null;
      callSource    = 'voximplant';
      crmEntityType = r.CRM_ENTITY_TYPE  || null;
      leadId        = crmEntityType === 'LEAD' && r.CRM_ENTITY_ID
                        ? parseInt(r.CRM_ENTITY_ID) : null;
      dealId        = crmEntityType === 'DEAL' && r.CRM_ENTITY_ID
                        ? parseInt(r.CRM_ENTITY_ID) : null;
      userName      = r.PORTAL_USER     || null;
    } else {
      const startMs   = r.START_TIME ? new Date(r.START_TIME).getTime() : null;
      const endMs     = r.END_TIME   ? new Date(r.END_TIME).getTime()   : null;
      // Extract phone from subject like "Исходящий на 90 303 07 70"
      const phoneMatch = r.SUBJECT ? r.SUBJECT.match(/[\d\s\-\+\(\)]{7,}/) : null;
      const isLead     = String(r.OWNER_TYPE_ID) === '1';
      const isDeal     = String(r.OWNER_TYPE_ID) === '2';

      id            = `act_${r.ID}`;
      responsibleId = r.RESPONSIBLE_ID ? parseInt(r.RESPONSIBLE_ID) : null;
      phoneNumber   = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : null;
      callType      = ({ 1: 2, 2: 1 })[parseInt(r.DIRECTION)] || null;
      duration      = (startMs && endMs && endMs > startMs)
                        ? Math.round((endMs - startMs) / 1000) : 0;
      callStart     = r.START_TIME     || null;
      statusCode    = r.COMPLETED === 'Y' ? 200 : null;
      statusName    = r.COMPLETED === 'Y' ? 'SUCCESS' : null;
      failedCode    = r.COMPLETED === 'Y' ? '200' : null;
      callCategory  = null;
      callSource    = 'activity';
      crmEntityType = isLead ? 'LEAD' : isDeal ? 'DEAL' : (r.OWNER_TYPE_ID ? String(r.OWNER_TYPE_ID) : null);
      leadId        = isLead && r.OWNER_ID ? parseInt(r.OWNER_ID) : null;
      dealId        = isDeal && r.OWNER_ID ? parseInt(r.OWNER_ID) : null;
      userName      = null;
    }

    await pool.query(
      `INSERT INTO calls (
         id, responsible_id, phone_number, call_type, duration,
         call_start, status_code, status_name, lead_id, deal_id, crm_entity_type,
         user_name, failed_code, call_category, call_source, synced_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (id) DO UPDATE SET
         responsible_id  = EXCLUDED.responsible_id,
         phone_number    = EXCLUDED.phone_number,
         call_type       = EXCLUDED.call_type,
         duration        = EXCLUDED.duration,
         call_start      = EXCLUDED.call_start,
         status_code     = EXCLUDED.status_code,
         status_name     = EXCLUDED.status_name,
         lead_id         = EXCLUDED.lead_id,
         deal_id         = EXCLUDED.deal_id,
         crm_entity_type = EXCLUDED.crm_entity_type,
         user_name       = EXCLUDED.user_name,
         failed_code     = EXCLUDED.failed_code,
         call_category   = EXCLUDED.call_category,
         call_source     = EXCLUDED.call_source,
         synced_at       = NOW()`,
      [id, responsibleId, phoneNumber, callType, duration,
       callStart, statusCode, statusName, leadId, dealId, crmEntityType, userName,
       failedCode, callCategory, callSource]
    );
    upserted++;
  }
  return upserted;
}

// Tashkent is UTC+5
function tashkentDateISO(offsetDays = 0) {
  const d = new Date(Date.now() + 5 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

// Auto-sync every 5 minutes: last 2 days rolling window (Tashkent time)
function startCallsAutoSync() {
  let firstRun = true;
  const run = async () => {
    try {
      const backfillDays = parseInt(process.env.CALL_SYNC_BACKFILL_DAYS || '45', 10);
      const rollingDays = parseInt(process.env.CALL_SYNC_ROLLING_DAYS || '2', 10);
      const days = firstRun ? backfillDays : rollingDays;
      if (firstRun) {
        try {
          const users = await syncCallUsersFromBitrix();
          console.log(`[calls-autosync] synced ${users} Bitrix users`);
        } catch (userErr) {
          console.warn('[calls-autosync] user sync skipped:', userErr.message);
        }
      }
      const to   = tashkentDateISO(0);
      const from = tashkentDateISO(-Math.max(days, 1));
      const n = await syncCallsFromBitrix(from, to);
      console.log(`[calls-autosync] synced ${n} calls (${from} → ${to} Tashkent)`);
      firstRun = false;
    } catch (err) {
      console.error('[calls-autosync] error:', err.message);
    }
  };
  run();
  setInterval(run, 5 * 60 * 1000);
}

module.exports.startCallsAutoSync = startCallsAutoSync;

/**
 * POST /api/dashboard/sync-calls
 * Manual sync with optional date range.
 */
router.post('/sync-calls', async (req, res) => {
  const { from, to } = req.body || req.query;
  try {
    const upserted = await syncCallsFromBitrix(from, to);
    res.json({ ok: true, synced: upserted });
  } catch (err) {
    console.error('[dashboard/sync-calls]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const CALL_OUTBOUND = 1;
const CALL_INBOUND_TYPES = new Set([2, 3]);
const CALL_CALLBACK = 4;
const CALL_SUCCESS_CODES = new Set(['0', '200']);
const CALL_MISSED_CODE = '304';
const CALL_RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;

function addDaysISO(iso, days) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function callPhoneKey(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (!digits) return null;
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

function callCode(value) {
  if (value == null || value === '') return null;
  return String(value).trim().toUpperCase();
}

function callDuration(row) {
  return Number(row.duration || 0);
}

function callType(row) {
  return Number(row.call_type || 0);
}

function callDate(row) {
  if (!row.call_start) return null;
  const d = new Date(row.call_start);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isInternalCall(row) {
  return String(row.call_category || '').toLowerCase() === 'internal';
}

function isInboundCall(row) {
  return CALL_INBOUND_TYPES.has(callType(row));
}

function isOutboundCall(row) {
  return callType(row) === CALL_OUTBOUND;
}

function isCallbackCall(row) {
  return callType(row) === CALL_CALLBACK;
}

function isSuccessfulCall(row) {
  const code = callCode(row.failed_code);
  if (code) return CALL_SUCCESS_CODES.has(code);
  return Number(row.status_code || 0) === 200 || callDuration(row) >= 10;
}

function isMissedInbound(row) {
  if (!isInboundCall(row)) return false;
  const code = callCode(row.failed_code);
  if (code) return code === CALL_MISSED_CODE;
  return !isSuccessfulCall(row) && callDuration(row) < 10;
}

function isNdzCall(row) {
  return isOutboundCall(row) && !isSuccessfulCall(row);
}

function callFullName(row) {
  const dbName = `${row.resp_name || ''} ${row.resp_last_name || ''}`.trim();
  const userName = String(row.user_name || '').trim();
  if (dbName) return dbName;
  if (userName) return userName;
  return "Noma'lum";
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function optionalInt(value) {
  if (value == null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function optionalText(value) {
  const v = String(value || '').trim();
  return v && v !== 'all' ? v : null;
}

function normalizeCallFilters(query) {
  return {
    responsible_id: optionalInt(query.responsible_id),
    phone: optionalText(query.phone),
    source: optionalText(query.source),
    call_kind: optionalText(query.call_kind),
    status: optionalText(query.status),
    duration_from: optionalInt(query.duration_from),
    duration_to: optionalInt(query.duration_to),
    stage: optionalText(query.stage),
  };
}

function buildOutboundMap(rows) {
  const outboundMap = new Map();
  for (const row of rows) {
    if (isInternalCall(row)) continue;
    const dt = callDate(row);
    const phoneKey = callPhoneKey(row.phone_number);
    if (dt && phoneKey && isOutboundCall(row)) {
      const list = outboundMap.get(phoneKey) || [];
      list.push(dt);
      outboundMap.set(phoneKey, list);
    }
  }
  return outboundMap;
}

function makeCallbackFinder(outboundMap) {
  return (phoneKey, missedAt) => {
    if (!phoneKey || !missedAt) return null;
    const maxTime = missedAt.getTime() + CALL_RECALL_WINDOW_MS;
    return (outboundMap.get(phoneKey) || [])
      .filter((dt) => dt.getTime() > missedAt.getTime() && dt.getTime() <= maxTime)
      .sort((a, b) => a.getTime() - b.getTime())[0] || null;
  };
}

function matchesCallFilters(row, filters, findCallback) {
  if (isInternalCall(row)) return false;

  if (filters.responsible_id != null && Number(row.responsible_id) !== filters.responsible_id) {
    return false;
  }

  if (filters.phone) {
    const needle = String(filters.phone).replace(/\D+/g, '');
    const haystack = String(row.phone_number || '').replace(/\D+/g, '');
    if (!needle || !haystack.includes(needle)) return false;
  }

  if (filters.source && String(row.call_source || '') !== filters.source) {
    return false;
  }

  if (filters.call_kind === 'inbound' && !isInboundCall(row)) return false;
  if (filters.call_kind === 'outbound' && !isOutboundCall(row)) return false;
  if (filters.call_kind === 'callback' && !isCallbackCall(row)) return false;

  const dur = callDuration(row);
  if (filters.duration_from != null && dur < filters.duration_from) return false;
  if (filters.duration_to != null && dur > filters.duration_to) return false;

  if (filters.status) {
    const missed = isMissedInbound(row);
    const phoneKey = callPhoneKey(row.phone_number);
    const dt = callDate(row);
    const callbackAt = missed && findCallback ? findCallback(phoneKey, dt) : null;

    if (filters.status === 'success' && !isSuccessfulCall(row)) return false;
    if (filters.status === 'failed' && isSuccessfulCall(row)) return false;
    if (filters.status === 'missed' && !missed) return false;
    if (filters.status === 'ndz' && !isNdzCall(row)) return false;
    if (filters.status === 'recalled' && (!missed || !callbackAt)) return false;
    if (filters.status === 'unrecalled' && (!missed || callbackAt)) return false;
  }

  if (filters.stage && String(row.stage_bitrix_id || '') !== filters.stage) return false;

  return true;
}

function callSourceName(source) {
  if (source === 'voximplant') return 'Bitrix24 telephony';
  if (source === 'activity') return 'CRM activity';
  return source || "Noma'lum";
}

function computeCallStatsFull(rows, dateFrom, dateTo, filters = {}, activeResponsibles = []) {
  const buckets = new Map();
  const missedMap = new Map();
  const outboundMap = buildOutboundMap(rows);
  const findCallback = makeCallbackFinder(outboundMap);
  let total = 0;
  let inbound = 0;
  let outbound = 0;
  let callback = 0;
  let ndz = 0;
  let missed = 0;
  let totalDuration = 0;
  let noPhoneMissed = 0;

  const getBucket = (row) => {
    const key = row.responsible_id != null ? String(row.responsible_id) : 'unknown';
    if (!buckets.has(key)) {
      buckets.set(key, {
        responsible_id: row.responsible_id != null ? Number(row.responsible_id) : null,
        full_name: callFullName(row),
        photo_url: row.photo_url || null,
        total_calls: 0,
        inbound_calls: 0,
        outbound_calls: 0,
        callback_calls: 0,
        success_calls: 0,
        failed_calls: 0,
        ndz_calls: 0,
        missed_inbound: 0,
        missed_recalled: 0,
        missed_unrecalled: 0,
        total_duration: 0,
        avg_duration: 0,
        inbound_duration: 0,
        outbound_duration: 0,
        unique_inbound: 0,
        unique_outbound: 0,
        unique_total: 0,
        inPhones: new Set(),
        outPhones: new Set(),
        allPhones: new Set(),
        missedEvents: [],
      });
    }
    const bucket = buckets.get(key);
    if (bucket.full_name === "Noma'lum") bucket.full_name = callFullName(row);
    if (!bucket.photo_url && row.photo_url) bucket.photo_url = row.photo_url;
    return bucket;
  };

  for (const row of rows) {
    if (isInternalCall(row)) continue;
    const phoneKey = callPhoneKey(row.phone_number);
    if (!row.in_range) continue;
    if (!matchesCallFilters(row, filters, findCallback)) continue;

    const dt = callDate(row);
    if (isCallbackCall(row)) {
      callback += 1;
      getBucket(row).callback_calls += 1;
      continue;
    }
    if (!isInboundCall(row) && !isOutboundCall(row)) continue;

    const dur = callDuration(row);
    const bucket = getBucket(row);
    const failedForDashboard = isNdzCall(row) || isMissedInbound(row);

    total += 1;
    totalDuration += dur;
    bucket.total_calls += 1;
    bucket.total_duration += dur;

    if (phoneKey) bucket.allPhones.add(phoneKey);

    if (isInboundCall(row)) {
      inbound += 1;
      bucket.inbound_calls += 1;
      bucket.inbound_duration += dur;
      if (phoneKey) bucket.inPhones.add(phoneKey);
    }
    if (isOutboundCall(row)) {
      outbound += 1;
      bucket.outbound_calls += 1;
      bucket.outbound_duration += dur;
      if (phoneKey) bucket.outPhones.add(phoneKey);
    }
    if (isNdzCall(row)) {
      ndz += 1;
      bucket.ndz_calls += 1;
    }
    if (isMissedInbound(row)) {
      missed += 1;
      bucket.missed_inbound += 1;
      bucket.missedEvents.push({ phoneKey, dt });
      if (phoneKey && dt) {
        const list = missedMap.get(phoneKey) || [];
        list.push(dt);
        missedMap.set(phoneKey, list);
      } else {
        noPhoneMissed += 1;
      }
    }
    if (failedForDashboard) {
      bucket.failed_calls += 1;
    } else {
      bucket.success_calls += 1;
    }
  }

  let nePerezvonili = noPhoneMissed;
  const reactionTimes = [];

  for (const [phoneKey, missedTimes] of missedMap.entries()) {
    for (const missedAt of missedTimes) {
      const callbackAt = findCallback(phoneKey, missedAt);
      if (callbackAt) {
        reactionTimes.push(Math.round((callbackAt.getTime() - missedAt.getTime()) / 1000));
      } else {
        nePerezvonili += 1;
      }
    }
  }

  const seenIds = new Set();
  const responsibles = Array.from(buckets.values())
    .filter((bucket) => bucket.total_calls > 0)
    .map((bucket) => {
      for (const ev of bucket.missedEvents) {
        if (findCallback(ev.phoneKey, ev.dt)) bucket.missed_recalled += 1;
        else bucket.missed_unrecalled += 1;
      }
      bucket.avg_duration = bucket.total_calls ? Math.round(bucket.total_duration / bucket.total_calls) : 0;
      bucket.unique_inbound = bucket.inPhones.size;
      bucket.unique_outbound = bucket.outPhones.size;
      bucket.unique_total = bucket.allPhones.size;
      delete bucket.inPhones;
      delete bucket.outPhones;
      delete bucket.allPhones;
      delete bucket.missedEvents;
      if (bucket.responsible_id != null) seenIds.add(bucket.responsible_id);
      return bucket;
    })
    .sort((a, b) => b.total_calls - a.total_calls);

  // Append zero-call rows only for active responsibles not seen in call data at all
  for (const r of activeResponsibles) {
    if (seenIds.has(r.id)) continue;
    // Only include if they had any call record in the calls table (total_calls=0 means filtered period only)
    // We skip purely inactive operators to keep the table focused on active call staff
  }

  const failed = ndz + missed;
  const success = Math.max(total - failed, 0);

  return {
    date_from: dateFrom || '',
    date_to: dateTo || '',
    total_calls: total,
    inbound_calls: inbound,
    outbound_calls: outbound,
    callback_calls: callback,
    success_calls: success,
    failed_calls: failed,
    ndz_calls: ndz,
    missed_inbound: missed,
    total_duration: totalDuration,
    avg_duration: total ? Math.round(totalDuration / total) : 0,
    success_pct: pct(success, total),
    failed_pct: pct(failed, total),
    ne_perezvonili: nePerezvonili,
    reaksiya_vaqti: reactionTimes.length
      ? Math.round(reactionTimes.reduce((s, n) => s + n, 0) / reactionTimes.length)
      : 0,
    responsibles,
  };
}

/**
 * GET /api/dashboard/call-filter-options
 * Options for CallStatistikasi filter drawer.
 */
router.get('/call-filter-options', async (_req, res) => {
  try {
    await ensureCallsTable();
    const [respRes, sourceRes] = await Promise.all([
      pool.query(
        `SELECT DISTINCT r.id,
           TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS full_name
         FROM responsibles r
         JOIN calls c ON c.responsible_id = r.id
         WHERE r.active = TRUE
         ORDER BY full_name`
      ),
      pool.query(
        `SELECT DISTINCT call_source
         FROM calls
         WHERE call_source IS NOT NULL AND call_source != ''
         ORDER BY call_source`
      ),
    ]);

    res.json({
      responsibles: respRes.rows,
      sources: sourceRes.rows.map((r) => ({
        id: r.call_source,
        name: callSourceName(r.call_source),
      })),
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ responsibles: [], sources: [] });
    console.error('[dashboard/call-filter-options]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/call-stats-full
 * DB-backed CallStatistikasi payload. No Bitrix24 request is made here.
 */
router.get('/call-stats-full', async (req, res) => {
  const { from, to } = req.query;
  const filters = normalizeCallFilters(req.query);
  const lookupTo = addDaysISO(to, 1) || to || null;
  try {
    await ensureCallsTable();
    const [{ rows }, { rows: activeRows }] = await Promise.all([
      pool.query(
        `SELECT
           c.id, c.responsible_id, c.phone_number, c.call_type, c.duration,
           c.call_start, c.status_code, c.status_name, c.failed_code,
           c.call_category, c.lead_id, c.crm_entity_type, c.user_name,
           r.name AS resp_name, r.last_name AS resp_last_name, r.photo_url,
           (
             ($1::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
             AND ($2::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
           ) AS in_range
         FROM calls c
         LEFT JOIN responsibles r ON r.id = c.responsible_id
         WHERE c.call_start IS NOT NULL
           AND ($1::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
           AND ($3::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $3::date)
         ORDER BY c.call_start DESC`,
        [from || null, to || null, lookupTo]
      ),
      pool.query(
        `SELECT id,
           TRIM(COALESCE(name,'') || ' ' || COALESCE(last_name,'')) AS full_name,
           photo_url
         FROM responsibles WHERE active = TRUE ORDER BY name`
      ),
    ]);
    res.json(computeCallStatsFull(rows, from, to, filters, activeRows));
  } catch (err) {
    if (err.code === '42P01') return res.json(computeCallStatsFull([], from, to, filters));
    console.error('[dashboard/call-stats-full]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/call-stats
 * Per-responsible call stats. Success = status_code 200 OR duration >= 10s.
 */
router.get('/call-stats', async (req, res) => {
  const { from, to, responsible_id } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         c.responsible_id,
         COALESCE(TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')), 'Noma''lum') AS full_name,
         r.photo_url,
         COUNT(*) FILTER (WHERE c.call_type IN (1,2))::int                                   AS total_calls,
         COALESCE(SUM(c.duration) FILTER (WHERE c.call_type IN (1,2)), 0)::int              AS total_duration,
         COALESCE(ROUND(AVG(c.duration) FILTER (WHERE c.duration >= 10 AND c.call_type IN (1,2))), 0)::int AS avg_duration,
         COUNT(*) FILTER (WHERE c.call_type IN (1,2) AND (COALESCE(c.status_code,0) = 200 OR c.duration >= 10))::int AS success_calls,
         COUNT(*) FILTER (WHERE c.call_type IN (1,2) AND COALESCE(c.status_code,0) != 200 AND c.duration < 10)::int  AS failed_calls,
         COUNT(*) FILTER (WHERE c.call_type = 2)::int                                       AS outbound_calls,
         COUNT(*) FILTER (WHERE c.call_type = 1)::int                                       AS inbound_calls,
         COUNT(*) FILTER (WHERE c.lead_id IS NOT NULL)::int                                 AS calls_with_lead,
         COUNT(DISTINCT c.phone_number) FILTER (WHERE c.call_type = 2)::int                 AS unique_outbound,
         COUNT(DISTINCT c.phone_number) FILTER (WHERE c.call_type = 1)::int                 AS unique_inbound,
         COUNT(DISTINCT c.phone_number)::int                                                 AS unique_total,
         COALESCE(SUM(c.duration) FILTER (WHERE c.call_type = 2), 0)::int                   AS outbound_duration,
         COALESCE(SUM(c.duration) FILTER (WHERE c.call_type = 1), 0)::int                   AS inbound_duration,
         COUNT(*) FILTER (WHERE c.call_type = 1 AND COALESCE(c.status_code,0) != 200 AND c.duration < 10)::int AS missed_inbound,
         -- Обратные: outbound (type=2) calls to a number that had a missed inbound (type=1) within 72h
         COUNT(DISTINCT c.id) FILTER (WHERE
           c.call_type = 2
           AND EXISTS (
             SELECT 1 FROM calls m
             WHERE m.phone_number = c.phone_number
               AND m.call_type = 1
               AND COALESCE(m.status_code,0) != 200 AND m.duration < 10
               AND m.call_start < c.call_start
               AND c.call_start - m.call_start <= INTERVAL '72 hours'
           )
         )::int AS callback_calls
       FROM calls c
       LEFT JOIN responsibles r ON r.id = c.responsible_id
       WHERE ($1::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         AND ($2::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
         AND ($3::int  IS NULL OR c.responsible_id = $3::int)
         AND c.responsible_id IS NOT NULL
       GROUP BY c.responsible_id, r.name, r.last_name, r.photo_url
       ORDER BY total_calls DESC`,
      [from || null, to || null, responsible_id ? parseInt(responsible_id) : null]
    );
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('[dashboard/call-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/call-global-stats
 * Global call metrics: ne_perezvonili, reaksiya_vaqti (avg response time in secs).
 */
router.get('/call-global-stats', async (req, res) => {
  const { from, to } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         -- ne_perezvonili: distinct phone numbers with missed inbound (type=1) but no outbound (type=2) callback within 72h
         COUNT(DISTINCT m.phone_number) FILTER (WHERE
           NOT EXISTS (
             SELECT 1 FROM calls cb
             WHERE cb.phone_number = m.phone_number
               AND cb.call_type = 2
               AND cb.call_start > m.call_start
               AND cb.call_start - m.call_start <= INTERVAL '72 hours'
           )
         )::int AS ne_perezvonili,
         -- reaksiya_vaqti: avg seconds between missed inbound (type=1) and first outbound callback (type=2)
         COALESCE(
           (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (first_cb.call_start - m2.call_start))))::int
            FROM calls m2
            JOIN LATERAL (
              SELECT call_start FROM calls cb2
              WHERE cb2.phone_number = m2.phone_number
                AND cb2.call_type = 2
                AND cb2.call_start > m2.call_start
                AND cb2.call_start - m2.call_start <= INTERVAL '72 hours'
              ORDER BY call_start LIMIT 1
            ) first_cb ON TRUE
            WHERE m2.call_type = 1 AND COALESCE(m2.status_code,0) != 200 AND m2.duration < 10
              AND ($1::date IS NULL OR (m2.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
              AND ($2::date IS NULL OR (m2.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
           ), 0
         )::int AS reaksiya_vaqti
       FROM calls m
       WHERE m.call_type = 1 AND COALESCE(m.status_code,0) != 200 AND m.duration < 10
         AND ($1::date IS NULL OR (m.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         AND ($2::date IS NULL OR (m.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)`,
      [from || null, to || null]
    );
    res.json(rows[0] || { ne_perezvonili: 0, reaksiya_vaqti: 0 });
  } catch (err) {
    if (err.code === '42P01') return res.json({ ne_perezvonili: 0, reaksiya_vaqti: 0 });
    console.error('[dashboard/call-global-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/call-reaction-stats
 * Per-responsible missed call stats + avg response time.
 */
router.get('/call-reaction-stats', async (req, res) => {
  const { from, to } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         m.responsible_id,
         COALESCE(TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')), 'Noma''lum') AS full_name,
         r.photo_url,
         COUNT(*)::int AS missed_calls,
         -- bez_otveta: missed inbound (type=1) with no outbound (type=2) callback within 72h
         COUNT(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM calls cb
           WHERE cb.phone_number = m.phone_number
             AND cb.call_type = 2
             AND cb.call_start > m.call_start
             AND cb.call_start - m.call_start <= INTERVAL '72 hours'
         ))::int AS bez_otveta,
         -- avg_response_secs: avg seconds from missed inbound (type=1) to first outbound callback (type=2)
         COALESCE(ROUND(AVG(
           EXTRACT(EPOCH FROM (
             (SELECT MIN(cb2.call_start) FROM calls cb2
              WHERE cb2.phone_number = m.phone_number
                AND cb2.call_type = 2
                AND cb2.call_start > m.call_start
                AND cb2.call_start - m.call_start <= INTERVAL '72 hours'
             ) - m.call_start
           ))
         ) FILTER (WHERE EXISTS (
           SELECT 1 FROM calls cb3
           WHERE cb3.phone_number = m.phone_number
             AND cb3.call_type = 2
             AND cb3.call_start > m.call_start
             AND cb3.call_start - m.call_start <= INTERVAL '72 hours'
         )), 0)::int AS avg_response_secs
       FROM calls m
       LEFT JOIN responsibles r ON r.id = m.responsible_id
       WHERE m.call_type = 1
         AND COALESCE(m.status_code,0) != 200 AND m.duration < 10
         AND m.responsible_id IS NOT NULL
         AND ($1::date IS NULL OR (m.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         AND ($2::date IS NULL OR (m.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
       GROUP BY m.responsible_id, r.name, r.last_name, r.photo_url
       ORDER BY missed_calls DESC`,
      [from || null, to || null]
    );
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('[dashboard/call-reaction-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/dashboard/sync-user-photos
 * Fetches Bitrix24 user photos and saves to responsibles.photo_url.
 */
router.post('/sync-user-photos', async (_req, res) => {
  try {
    const { fetchAll } = require('../services/bitrix');
    const users = await fetchAll('user.get', { ACTIVE: 'Y' });
    let updated = 0;
    for (const u of users) {
      const photoUrl = u.PERSONAL_PHOTO || null;
      await pool.query(
        `UPDATE responsibles SET photo_url = $1 WHERE id = $2`,
        [photoUrl, parseInt(u.ID)]
      );
      if (photoUrl) updated++;
    }
    res.json({ ok: true, total: users.length, with_photo: updated });
  } catch (err) {
    console.error('[dashboard/sync-user-photos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/call-list
 * Individual calls for a responsible — drill-down.
 */
router.get('/call-list', async (req, res) => {
  const { responsible_id, from, to } = req.query;
  if (!responsible_id) return res.status(400).json({ error: 'responsible_id required' });
  const filters = normalizeCallFilters(req.query);
  const lookupTo = addDaysISO(to, 1) || to || null;
  try {
    const { rows } = await pool.query(
      `SELECT
         c.id, c.phone_number, c.call_type, c.duration,
         c.call_start, c.status_code, c.status_name,
         c.failed_code, c.call_category, c.call_source,
         c.lead_id, c.deal_id, c.crm_entity_type, c.responsible_id,
         l.title AS lead_title,
         COALESCE(s_lh.name, sl.name, s_dh.name, sd.name) AS stage_name,
         COALESCE(s_lh.bitrix_id, sl.bitrix_id, s_dh.bitrix_id, sd.bitrix_id) AS stage_bitrix_id,
         (
           ($1::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
           AND ($2::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
         ) AS in_range
       FROM calls c
       LEFT JOIN leads l  ON l.id = c.lead_id
       LEFT JOIN deals d  ON d.id = c.deal_id
       LEFT JOIN stages sl ON sl.id = l.stage_id
       LEFT JOIN stages sd ON sd.id = d.stage_id
       LEFT JOIN LATERAL (
         SELECT s.name, s.bitrix_id
         FROM lead_stage_history lsh
         JOIN stages s ON s.id = lsh.stage_id
         WHERE lsh.lead_id = c.lead_id AND lsh.changed_at <= c.call_start
         ORDER BY lsh.changed_at DESC LIMIT 1
       ) s_lh ON c.lead_id IS NOT NULL
       LEFT JOIN LATERAL (
         SELECT s.name, s.bitrix_id
         FROM deal_stage_history dsh
         JOIN stages s ON s.id = dsh.stage_id
         WHERE dsh.deal_id = c.deal_id AND dsh.changed_at <= c.call_start
         ORDER BY dsh.changed_at DESC LIMIT 1
       ) s_dh ON c.deal_id IS NOT NULL
       WHERE c.call_start IS NOT NULL
         AND ($1::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         AND ($3::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $3::date)
       ORDER BY c.call_start DESC
       LIMIT 5000`,
      [from || null, to || null, lookupTo]
    );
    const findCallback = makeCallbackFinder(buildOutboundMap(rows));
    const responsibleId = parseInt(responsible_id);
    const filtered = rows
      .filter((row) => Number(row.responsible_id) === responsibleId)
      .filter((row) => row.in_range)
      .filter((row) => matchesCallFilters(row, { ...filters, responsible_id: responsibleId }, findCallback))
      .slice(0, 500);
    res.json(filtered);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('[dashboard/call-list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/call-stage-stats
 * Calls grouped by stage_bitrix_id — shows call counts per lead stage
 */
router.get('/call-stage-stats', async (req, res) => {
  const { responsible_id, from, to } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(s_lh.bitrix_id, sl.bitrix_id, s_dh.bitrix_id, sd.bitrix_id, 'Noma''lum') AS stage_bitrix_id,
         COALESCE(s_lh.name, sl.name, s_dh.name, sd.name, 'Noma''lum') AS stage_name,
         COUNT(*)::int AS jami,
         COUNT(*) FILTER (WHERE c.duration > 0)::int AS muvaffaqiyatli
       FROM calls c
       LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN deals  d ON d.id = c.deal_id
       LEFT JOIN stages sl ON sl.id = l.stage_id
       LEFT JOIN stages sd ON sd.id = d.stage_id
       LEFT JOIN LATERAL (
         SELECT s.name, s.bitrix_id FROM lead_stage_history lsh
         JOIN stages s ON s.id = lsh.stage_id
         WHERE lsh.lead_id = c.lead_id AND lsh.changed_at <= c.call_start
         ORDER BY lsh.changed_at DESC LIMIT 1
       ) s_lh ON c.lead_id IS NOT NULL
       LEFT JOIN LATERAL (
         SELECT s.name, s.bitrix_id FROM deal_stage_history dsh
         JOIN stages s ON s.id = dsh.stage_id
         WHERE dsh.deal_id = c.deal_id AND dsh.changed_at <= c.call_start
         ORDER BY dsh.changed_at DESC LIMIT 1
       ) s_dh ON c.deal_id IS NOT NULL
       WHERE c.call_start IS NOT NULL
         AND (c.lead_id IS NOT NULL OR c.deal_id IS NOT NULL)
         AND ($1::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         AND ($2::date IS NULL OR (c.call_start AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
         AND ($3::int IS NULL OR c.responsible_id = $3::int)
       GROUP BY COALESCE(s_lh.bitrix_id, sl.bitrix_id, s_dh.bitrix_id, sd.bitrix_id, 'Noma''lum'),
                COALESCE(s_lh.name, sl.name, s_dh.name, sd.name, 'Noma''lum')
       ORDER BY jami DESC`,
      [from || null, to || null, responsible_id ? parseInt(responsible_id) : null]
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/call-stage-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/responsible-leads
 * Individual leads for a specific responsible — used for drill-down sub-table.
 */
router.get('/responsible-leads', async (req, res) => {
  const { responsible_id, from, to, mode } = req.query;
  if (!responsible_id) return res.status(400).json({ error: 'responsible_id required' });

  const params = [parseInt(responsible_id), from || null, to || null];

  try {
    const { rows } = await pool.query(
      `SELECT
         l.id,
         COALESCE(NULLIF(TRIM(COALESCE(l.title,'')), ''),
                  NULLIF(TRIM(COALESCE(l.name,'') || ' ' || COALESCE(l.last_name,'')), ''),
                  'Nomalum') AS title,
         s.bitrix_id AS stage_bid,
         l.date_create::date AS date_create,
         l.opportunity,
         NULLIF(NULLIF(l.uf_tashrif_sanasi, ''), 'false') AS tashrif_sanasi,
         (s.bitrix_id IN ('NEW','IN_PROCESS','PROCESSED','UC_1KPATX','NO_ANSWER',
           'UC_Q2U9EL','CALLBACK','UC_KXC3ZW','THINKING','UC_L28G68','CONSULTATION',
           'UC_5G8244','NOT_TRANSFERRED'))::int                                     AS ne_obrabotinniy,
         (s.bitrix_id = 'NEW')::int                                                AS yangi_lid,
         (s.bitrix_id = 'PROCESSED')::int                                          AS propushenniy,
         (s.bitrix_id IN ('UC_1KPATX','NO_ANSWER'))::int                           AS javob_bermadi,
         (s.bitrix_id IN ('UC_Q2U9EL','CALLBACK'))::int                            AS qayta_aloqa,
         (s.bitrix_id IN ('UC_KXC3ZW','THINKING'))::int                            AS oylab_koradi,
         (s.bitrix_id IN ('UC_L28G68','CONSULTATION'))::int                        AS tashrif_belgilandi,
         (s.bitrix_id IN ('UC_5G8244','NOT_TRANSFERRED'))::int                     AS kelmadi,
         (s.bitrix_id IN ('JUNK','ARCHIVE'))::int                                  AS sandiq,
         (s.bitrix_id = 'UC_F8K4GI')::int                                         AS sifatsiz,
         (s.bitrix_id IN ('UC_NAZK5J','RECYCLED'))::int                            AS bekor_boldi,
         (s.bitrix_id IN ('CONVERTED_CONSULT','CONVERTED'))::int                   AS tashrif_buyurdi
       FROM leads l
       JOIN stages s ON s.id = l.stage_id
       WHERE l.responsible_id = $1
         AND ($2::date IS NULL OR l.date_create::date >= $2::date)
         AND ($3::date IS NULL OR l.date_create::date <= $3::date)
         ${mode === 'amocrm' ? `AND l.source_id = 'UC_1WUFJB'` : ``}
       ORDER BY l.date_create DESC
       LIMIT 1000`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[dashboard/responsible-leads]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/deals-source-stats?from=&to=&mode=
 * Deal counts grouped by source — umumiy, jarayonda, bekor bo'ldi, sotuv bo'ldi.
 */
router.get('/deals-source-stats', async (req, res) => {
  const { from, to, mode, responsible_id, stage_id, source } = req.query;
  const extra = [];
  const params = [from || null, to || null];
  let pi = 3;
  if (responsible_id) { extra.push(`AND d.responsible_id::text = ANY(string_to_array($${pi++}, ','))`); params.push(responsible_id); }
  if (stage_id)       { extra.push(`AND d.stage_id::text = ANY(string_to_array($${pi++}, ','))`);       params.push(stage_id); }
  if (source)         { extra.push(`AND ${dealSrcCond(mode, pi++)}`);                                    params.push(source); }
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(d.source_id, '') AS source_id,
         COUNT(d.id)::int                                                              AS umumiy,
         COUNT(d.id) FILTER (WHERE NOT s.is_won AND NOT s.is_final)::int              AS jarayonda,
         COUNT(d.id) FILTER (WHERE s.is_final AND NOT s.is_won)::int                  AS bekor_boldi,
         COUNT(d.id) FILTER (WHERE s.is_won = true)::int AS sotuv_boldi
       FROM deals d
       JOIN stages s ON s.id = d.stage_id
       LEFT JOIN LATERAL (SELECT phone FROM deal_phones WHERE deal_id = d.id LIMIT 1) ph ON true
       WHERE ${dealDateCond(mode, 1, 2)}
         ${dealModeClause(mode)}
         ${extra.join(' ')}
       GROUP BY d.source_id
       ORDER BY umumiy DESC`,
      params
    );
    const result = rows.map(r => ({
      ...r,
      source_name: SOURCE_NAMES[r.source_id] || r.source_id || 'Manbasiz',
    }));
    res.json(result);
  } catch (err) {
    console.error('[dashboard/deals-source-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Payments CRUD (/api/dashboard/payments) ──────────────────────────────────
// Barcha operatsiyalar JSON body orqali, URL da ID yo'q.

const PAYMENT_SELECT = `
  SELECT
    dp.id,
    dp.deal_id,
    dp.tolov_id,
    dp.paid_at,
    dp.amount_usd,
    dp.turi,
    dp.created_at,
    TRIM(COALESCE(r.name,'') || ' ' || COALESCE(r.last_name,'')) AS responsible,
    s.name  AS stage_name,
    d.opportunity,
    d.currency_id
  FROM deal_payments dp
  JOIN deals d ON d.id = dp.deal_id
  LEFT JOIN responsibles r ON r.id = d.responsible_id
  LEFT JOIN stages s ON s.id = d.stage_id`;

// GET  /api/dashboard/payments        { "id": 148 }  — yoki  ?deal_id=4852 (barcha to'lovlar)
router.get('/payments', async (req, res) => {
  try {
    const bodyId  = req.body?.id   ? parseInt(req.body.id,   10) : null;
    const dealId  = req.query.deal_id ? parseInt(req.query.deal_id, 10) : null;
    if (bodyId) {
      const { rows } = await pool.query(`${PAYMENT_SELECT} WHERE dp.id = $1`, [bodyId]);
      if (!rows.length) return res.status(404).json({ error: "To'lov topilmadi" });
      return res.json(rows[0]);
    }
    if (dealId) {
      const { rows } = await pool.query(`${PAYMENT_SELECT} WHERE dp.deal_id = $1 ORDER BY dp.paid_at`, [dealId]);
      return res.json(rows);
    }
    return res.status(400).json({ error: 'id yoki deal_id kerak' });
  } catch (err) {
    console.error('[payments GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/payments        { deal_id, paid_at, amount_usd, turi }
router.post('/payments', async (req, res) => {
  const body = req.body ?? {};

  // Bitrix24 outgoing webhook: ONCRMDYNAMICITEMADDED — tolov_id ni payment ga yozish
  if (body.event === 'ONCRMDYNAMICITEMADDED') {
    console.log('[payments webhook] ADDED raw body:', JSON.stringify(body));
    const tolovId = parseInt(body?.data?.FIELDS?.ID || body?.['data[FIELDS][ID]'], 10);
    const dealId  = parseInt(body?.data?.FIELDS?.PARENT_ID_2 || body?.['data[FIELDS][PARENT_ID_2]'], 10);
    console.log(`[payments webhook] ADDED tolov_id=${tolovId} deal_id=${dealId}`);
    if (tolovId && dealId) {
      try {
        // Eng oxirgi tolov_id=null payment ni yangilash
        const { rowCount } = await pool.query(
          `UPDATE deal_payments SET tolov_id = $1
           WHERE id = (
             SELECT id FROM deal_payments
             WHERE deal_id = $2 AND tolov_id IS NULL
             ORDER BY id DESC LIMIT 1
           )`,
          [tolovId, dealId]
        );
        console.log(`[payments webhook] ADDED: updated ${rowCount} row(s) tolov_id=${tolovId} deal_id=${dealId}`);
        return res.json({ status: 'tolov_id_saved', tolov_id: tolovId, deal_id: dealId, updated: rowCount });
      } catch (err) {
        console.error('[payments webhook ADDED]', err.message);
        return res.status(500).json({ error: err.message });
      }
    }
    return res.json({ status: 'skipped', tolov_id: tolovId, deal_id: dealId });
  }

  // Bitrix24 outgoing webhook: ONCRMDYNAMICITEMDELETE
  if (body.event === 'ONCRMDYNAMICITEMDELETE') {
    console.log('[payments webhook] raw body:', JSON.stringify(body));
    // tolov_id field qiymati turli joylarda kelishi mumkin
    const tolovId = parseInt(
      body?.data?.FIELDS?.ID ||
      body?.['data[FIELDS][ID]'] ||
      body?.data?.ID, 10
    );
    console.log(`[payments webhook] ONCRMDYNAMICITEMDELETE tolov_id=${tolovId}`);
    if (!tolovId) return res.status(400).json({ error: 'FIELDS.ID topilmadi', body });
    try {
      // 1. tolov_id bo'yicha qidirish
      let { rows } = await pool.query(`${PAYMENT_SELECT} WHERE dp.tolov_id = $1`, [tolovId]);
      // 2. topilmasa — deal_id + amount bo'yicha fallback
      if (!rows.length) {
        const dealId = parseInt(body?.data?.FIELDS?.PARENT_ID_2 || body?.['data[FIELDS][PARENT_ID_2]'], 10);
        if (dealId) {
          const fb = await pool.query(
            `${PAYMENT_SELECT} WHERE dp.deal_id = $1 AND dp.tolov_id IS NULL ORDER BY dp.id DESC LIMIT 1`,
            [dealId]
          );
          rows = fb.rows;
        }
      }
      if (!rows.length) {
        console.log(`[payments webhook] not found tolov_id=${tolovId}`);
        return res.json({ status: 'not_found', tolov_id: tolovId });
      }
      const deleted = rows[0];
      await pool.query(`DELETE FROM deal_payments WHERE id = $1`, [deleted.id]);
      console.log(`[payments webhook] deleted id=${deleted.id} tolov_id=${tolovId} deal_id=${deleted.deal_id}`);
      return res.json({ status: 'deleted', deleted });
    } catch (err) {
      console.error('[payments webhook DELETE]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Manual create: { deal_id, paid_at, amount_usd, turi }
  const { deal_id, paid_at, amount_usd, turi } = body;
  if (!deal_id || !paid_at || amount_usd == null) {
    return res.status(400).json({ error: 'deal_id, paid_at, amount_usd majburiy' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO deal_payments (deal_id, paid_at, amount_usd, turi)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [deal_id, paid_at, parseFloat(amount_usd), turi || null]
    );
    const { rows: full } = await pool.query(`${PAYMENT_SELECT} WHERE dp.id = $1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (err) {
    console.error('[payments POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT  /api/dashboard/payments        { id, paid_at?, amount_usd?, turi? }
router.put('/payments', async (req, res) => {
  const { id, paid_at, amount_usd, turi } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'id majburiy' });
  const fields = [], vals = [];
  if (paid_at    != null) { fields.push(`paid_at    = $${vals.push(paid_at)}`); }
  if (amount_usd != null) { fields.push(`amount_usd = $${vals.push(parseFloat(amount_usd))}`); }
  if (turi       != null) { fields.push(`turi       = $${vals.push(turi)}`); }
  if (!fields.length) return res.status(400).json({ error: "O'zgartiriladigan maydon yo'q" });
  vals.push(parseInt(id, 10));
  try {
    const { rowCount } = await pool.query(
      `UPDATE deal_payments SET ${fields.join(', ')} WHERE id = $${vals.length}`,
      vals
    );
    if (!rowCount) return res.status(404).json({ error: "To'lov topilmadi" });
    const { rows } = await pool.query(`${PAYMENT_SELECT} WHERE dp.id = $1`, [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('[payments PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dashboard/payments      { "id": 148 }
// DELETE /api/dashboard/payments
// Body: to'liq payment JSON (deal_id, paid_at, amount_usd, turi) — id shart emas
router.delete('/payments', async (req, res) => {
  const { deal_id, paid_at, amount_usd, turi } = req.body ?? {};
  if (!deal_id || !paid_at || amount_usd == null) {
    return res.status(400).json({ error: 'deal_id, paid_at, amount_usd majburiy' });
  }
  try {
    const { rows } = await pool.query(
      `${PAYMENT_SELECT}
       WHERE dp.deal_id = $1
         AND dp.paid_at = $2::date
         AND dp.amount_usd = $3
         ${turi ? 'AND dp.turi = $4' : ''}
       LIMIT 1`,
      turi ? [deal_id, paid_at, parseFloat(amount_usd), turi] : [deal_id, paid_at, parseFloat(amount_usd)]
    );
    if (!rows.length) return res.status(404).json({ error: "To'lov topilmadi" });
    const deleted = rows[0];
    await pool.query(`DELETE FROM deal_payments WHERE id = $1`, [deleted.id]);
    res.json({ deleted });
  } catch (err) {
    console.error('[payments DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.startCallsAutoSync = startCallsAutoSync;
