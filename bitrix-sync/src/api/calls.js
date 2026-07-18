/**
 * Call statistics API — OnlinePBX-backed.
 *
 * Serves the CallStatistikasi page on the same /api/dashboard/* paths the old
 * Bitrix-voximplant implementation used, so the frontend contract is unchanged:
 *   GET  /call-stats-full     PyCallStatsResult (cards + per-operator table)
 *   GET  /call-list           CallListRow[] (per-operator drill-down)
 *   GET  /call-filter-options { responsibles, sources, stages }
 *   POST /sync-calls          manual pull ({from,to} dates or {hours})
 * Here a "responsible" IS a PBX extension — responsible_id == the ext number.
 */

const { Router } = require('express');
const pool = require('../db/pool');
const { computeCallStatsFull } = require('../services/callStats');

const router = Router();

const fail = (res, tag) => (err) => {
  console.error(`[calls/${tag}] ${err.message}`);
  res.status(500).json({ error: err.message });
};

/** "2026-07-15" + n days → "2026-07-16" (UTC, date-only). */
function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const optInt = (v) => {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const optText = (v) => {
  const s = String(v || '').trim();
  return s && s !== 'all' ? s : null;
};

// The newest lead / deal sharing the call's phone number (last 9 digits) — the
// OnlinePBX replacement for the CRM_ENTITY_ID that Bitrix telephony used to
// attach. Everything resolves inside Postgres, no Bitrix round-trips.
const LEAD_BY_PHONE = `
  SELECT l.id AS lead_id, l.title AS lead_title,
         s.name AS stage_name, s.bitrix_id AS stage_bitrix_id
  FROM lead_phones lp
  JOIN leads l ON l.id = lp.lead_id
  LEFT JOIN stages s ON s.id = l.stage_id
  WHERE RIGHT(regexp_replace(lp.phone, '\\D', '', 'g'), 9) = c.customer_norm
  ORDER BY l.date_create DESC NULLS LAST
  LIMIT 1`;

const DEAL_BY_PHONE = `
  SELECT d.id AS deal_id,
         s.name AS stage_name, s.bitrix_id AS stage_bitrix_id
  FROM deal_phones dp
  JOIN deals d ON d.id = dp.deal_id
  LEFT JOIN stages s ON s.id = d.stage_id
  WHERE RIGHT(regexp_replace(dp.phone, '\\D', '', 'g'), 9) = c.customer_norm
  ORDER BY d.date_create DESC NULLS LAST
  LIMIT 1`;

// Scalar (single-column) variants for WHERE-clause stage matching.
const LEAD_STAGE_BY_PHONE = `
  SELECT s.bitrix_id
  FROM lead_phones lp
  JOIN leads l ON l.id = lp.lead_id
  LEFT JOIN stages s ON s.id = l.stage_id
  WHERE RIGHT(regexp_replace(lp.phone, '\\D', '', 'g'), 9) = c.customer_norm
  ORDER BY l.date_create DESC NULLS LAST
  LIMIT 1`;

const DEAL_STAGE_BY_PHONE = `
  SELECT s.bitrix_id
  FROM deal_phones dp
  JOIN deals d ON d.id = dp.deal_id
  LEFT JOIN stages s ON s.id = d.stage_id
  WHERE RIGHT(regexp_replace(dp.phone, '\\D', '', 'g'), 9) = c.customer_norm
  ORDER BY d.date_create DESC NULLS LAST
  LIMIT 1`;

/**
 * GET /call-stats-full — the whole CallStatistikasi payload (PyCallStatsResult).
 *
 * Rows are pulled for [from, to+1 day] with an `in_range` flag: the extra day
 * lets a call missed on the last day still find a next-day callback, while only
 * in-range rows are counted. All metric logic lives in services/callStats.js.
 * The operator/status/kind/duration filters are applied inside the compute (not
 * in SQL) so the callback map stays global — a colleague's callback to the same
 * customer still counts.
 */
router.get('/call-stats-full', async (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const phone = req.query.phone ? String(req.query.phone).replace(/\D/g, '') : null;
  const stage = optText(req.query.stage);
  const filters = {
    opId: optInt(req.query.responsible_id),
    kind: optText(req.query.call_kind),
    status: optText(req.query.status),
    durFrom: optInt(req.query.duration_from),
    durTo: optInt(req.query.duration_to),
  };

  try {
    const { rows } = await pool.query(
      `SELECT c.uuid,
              CASE WHEN c.operator_ext ~ '^[0-9]+$' THEN c.operator_ext::int ELSE NULL END AS responsible_id,
              u.name AS full_name,
              c.direction, c.customer_norm, c.customer_number,
              c.start_stamp, c.duration, c.talk_time AS talk, c.answered,
              (
                ($1::date IS NULL OR (c.start_stamp AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
                AND ($2::date IS NULL OR (c.start_stamp AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
              ) AS in_range
       FROM pbx_calls c
       LEFT JOIN pbx_users u ON u.ext = c.operator_ext
       WHERE c.start_stamp IS NOT NULL
         AND ($1::date IS NULL OR (c.start_stamp AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         -- $3 = to + 1 day, the callback look-ahead
         AND ($3::date IS NULL OR (c.start_stamp AT TIME ZONE 'Asia/Tashkent')::date <= $3::date)
         AND ($4::text IS NULL OR c.customer_norm LIKE '%' || $4 || '%')
         -- Bosqich filter: keep calls whose newest same-phone lead OR deal is in $5.
         AND ($5::text IS NULL
              OR $5::text = (${LEAD_STAGE_BY_PHONE})
              OR $5::text = (${DEAL_STAGE_BY_PHONE}))
       ORDER BY c.start_stamp DESC`,
      [from, to, to ? addDaysISO(to, 1) : null, phone, stage],
    );
    res.json(computeCallStatsFull(rows, from || '', to || '', filters));
  } catch (err) {
    fail(res, 'call-stats-full')(err);
  }
});

/**
 * GET /call-list — the per-operator drill-down (CallListRow[]).
 * Returns a bare array, matching the reference contract.
 */
router.get('/call-list', async (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const respId = optInt(req.query.responsible_id);
  const phone = req.query.phone ? String(req.query.phone).replace(/\D/g, '') : null;
  const kind = optText(req.query.call_kind); // inbound|outbound|callback
  const stage = optText(req.query.stage);
  const status = optText(req.query.status);
  const durFrom = optInt(req.query.duration_from);
  const durTo = optInt(req.query.duration_to);

  if (kind === 'callback') return res.json([]); // no callback type on the PBX

  // recalled/unrecalled need the answered-contact map; plain statuses are SQL.
  const statusSql =
    status === 'success' ? 'AND c.answered' :
    status === 'failed' ? 'AND NOT c.answered' :
    status === 'ndz' ? `AND c.direction = 'outbound' AND NOT c.answered` :
    status === 'missed' || status === 'recalled' || status === 'unrecalled'
      ? `AND c.direction = 'inbound' AND NOT c.answered` : '';

  try {
    const { rows } = await pool.query(
      `SELECT c.uuid AS id,
              c.customer_number AS phone_number,
              CASE c.direction WHEN 'outbound' THEN 1 WHEN 'inbound' THEN 2 ELSE NULL END AS call_type,
              c.duration,
              c.talk_time,
              c.answered,
              c.customer_norm,
              c.start_stamp AS call_start,
              CASE WHEN c.answered THEN 200 ELSE NULL END AS status_code,
              c.hangup_cause AS status_name,
              ld.lead_id,
              CASE WHEN ld.lead_id IS NOT NULL THEN 'lead' END AS crm_entity_type,
              ld.lead_title,
              COALESCE(ld.stage_name, dd.stage_name) AS stage_name,
              COALESCE(ld.stage_bitrix_id, dd.stage_bitrix_id) AS stage_bitrix_id
       FROM pbx_calls c
       LEFT JOIN LATERAL (${LEAD_BY_PHONE}) ld ON c.customer_norm IS NOT NULL
       LEFT JOIN LATERAL (${DEAL_BY_PHONE}) dd ON c.customer_norm IS NOT NULL
       WHERE c.start_stamp IS NOT NULL
         AND c.direction <> 'local'
         AND ($1::date IS NULL OR (c.start_stamp AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
         AND ($2::date IS NULL OR (c.start_stamp AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)
         AND ($3::int  IS NULL OR (c.operator_ext ~ '^[0-9]+$' AND c.operator_ext::int = $3::int))
         AND ($4::text IS NULL OR c.customer_norm LIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR c.direction = $5::text)
         AND ($6::text IS NULL
              OR $6::text = ld.stage_bitrix_id
              OR $6::text = dd.stage_bitrix_id)
         AND ($7::int IS NULL OR c.duration >= $7::int)
         AND ($8::int IS NULL OR c.duration <= $8::int)
         ${statusSql}
       ORDER BY c.start_stamp DESC
       LIMIT 1000`,
      [from, to, respId, phone,
       kind === 'inbound' || kind === 'outbound' ? kind : null,
       stage, durFrom, durTo],
    );

    let out = rows;
    if (status === 'recalled' || status === 'unrecalled') {
      // Contact map over [from, to+1 day] — same look-ahead as the stats.
      const { rows: contacts } = await pool.query(
        `SELECT customer_norm, start_stamp
         FROM pbx_calls
         WHERE answered AND customer_norm IS NOT NULL
           AND ($1::date IS NULL OR (start_stamp AT TIME ZONE 'Asia/Tashkent')::date >= $1::date)
           AND ($2::date IS NULL OR (start_stamp AT TIME ZONE 'Asia/Tashkent')::date <= $2::date)`,
        [from, to ? addDaysISO(to, 1) : null],
      );
      const contact = new Map();
      for (const r of contacts) {
        const t = new Date(r.start_stamp).getTime();
        if (Number.isNaN(t)) continue;
        if (!contact.has(r.customer_norm)) contact.set(r.customer_norm, []);
        contact.get(r.customer_norm).push(t);
      }
      const WINDOW = 24 * 60 * 60 * 1000;
      const reached = (r) => {
        const at = new Date(r.call_start).getTime();
        if (!r.customer_norm || Number.isNaN(at)) return false;
        return (contact.get(r.customer_norm) || []).some((t) => t > at && t <= at + WINDOW);
      };
      out = rows.filter((r) => (status === 'recalled' ? reached(r) : !reached(r)));
    }
    res.json(out);
  } catch (err) {
    fail(res, 'call-list')(err);
  }
});

/**
 * GET /call-filter-options — reference shape { responsibles, sources, stages }.
 * A "responsible" is a PBX extension (id = ext number). Only extensions that
 * actually placed/took a call are offered.
 */
router.get('/call-filter-options', async (_req, res) => {
  try {
    const [ops, stages] = await Promise.all([
      pool.query(
        `SELECT DISTINCT (u.ext)::int AS id, COALESCE(u.name, u.ext) AS full_name
         FROM pbx_users u
         JOIN pbx_calls c ON c.operator_ext = u.ext
         WHERE u.ext ~ '^[0-9]+$'
         ORDER BY full_name`,
      ),
      pool.query(
        `SELECT bitrix_id, name FROM stages WHERE entity = 'lead' ORDER BY sort_order`,
      ),
    ]);
    res.json({
      responsibles: ops.rows,
      sources: [{ id: 'onlinepbx', name: 'OnlinePBX' }],
      stages: stages.rows,
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ responsibles: [], sources: [], stages: [] });
    fail(res, 'call-filter-options')(err);
  }
});

/**
 * POST /sync-calls — manual pull. Accepts {from,to} ISO dates (Tashkent) like
 * the old Bitrix endpoint, or {hours} for a rolling window (default 24h).
 */
router.post('/sync-calls', async (req, res) => {
  const q = { ...req.query, ...(req.body || {}) };
  try {
    const { syncCallRange, syncRecentCalls, nowUnix } = require('../sync/syncCalls');
    let result;
    if (q.from) {
      const fromUnix = Math.floor(new Date(`${q.from}T00:00:00+05:00`).getTime() / 1000);
      const toUnix = q.to
        ? Math.floor(new Date(`${q.to}T23:59:59+05:00`).getTime() / 1000)
        : nowUnix();
      if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix)) {
        return res.status(400).json({ error: 'from/to formati noto‘g‘ri, YYYY-MM-DD kerak' });
      }
      result = await syncCallRange(fromUnix, Math.min(toUnix, nowUnix()));
    } else {
      const hours = parseInt(q.hours, 10) || 24;
      result = await syncRecentCalls(hours);
    }
    res.json({ ok: true, synced: result.total, ...result });
  } catch (err) {
    fail(res, 'sync-calls')(err);
  }
});

// ── Extra PBX-native views (not used by CallStatistikasi, handy for reports) ──

// Shared filter: $1 from · $2 to · $3 operator_ext · $4 direction. The pool sets
// the session TZ to Asia/Tashkent, so ::date lands on the right local day.
const CALL_WHERE = `
      ($1::date IS NULL OR c.start_stamp::date >= $1::date)
  AND ($2::date IS NULL OR c.start_stamp::date <= $2::date)
  AND ($3::text IS NULL OR c.operator_ext = ANY(string_to_array($3, ',')))
  AND ($4::text IS NULL OR c.direction    = ANY(string_to_array($4, ',')))`;

const rangeParams = (q) => [q.from || null, q.to || null, q.operator_ext || null, q.direction || null];

/** GET /call-global-stats — headline KPI totals. */
router.get('/call-global-stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH fc AS (SELECT c.* FROM pbx_calls c WHERE ${CALL_WHERE})
       SELECT COUNT(*)::int                                             AS total_calls,
              COUNT(*) FILTER (WHERE direction = 'inbound')::int        AS inbound_calls,
              COUNT(*) FILTER (WHERE direction = 'outbound')::int       AS outbound_calls,
              COUNT(*) FILTER (WHERE direction = 'local')::int          AS local_calls,
              COUNT(*) FILTER (WHERE answered)::int                     AS answered_calls,
              COUNT(*) FILTER (WHERE direction = 'inbound' AND NOT answered)::int AS missed_inbound,
              ROUND(COUNT(*) FILTER (WHERE answered)::numeric
                    / NULLIF(COUNT(*), 0) * 100, 1)                     AS answered_pct,
              ROUND(COUNT(*) FILTER (WHERE direction = 'inbound' AND answered)::numeric
                    / NULLIF(COUNT(*) FILTER (WHERE direction = 'inbound'), 0) * 100, 1) AS inbound_answered_pct,
              COALESCE(SUM(talk_time), 0)::int                          AS total_talk,
              COALESCE(ROUND(AVG(talk_time) FILTER (WHERE answered)), 0)::int AS avg_talk
       FROM fc`,
      rangeParams(req.query),
    );
    res.json(rows[0] || {});
  } catch (err) {
    fail(res, 'call-global-stats')(err);
  }
});

/** GET /call-daily — calls per local day, split by direction and answered. */
router.get('/call-daily', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH fc AS (SELECT c.* FROM pbx_calls c WHERE ${CALL_WHERE})
       SELECT start_stamp::date                                        AS day,
              COUNT(*)::int                                            AS total,
              COUNT(*) FILTER (WHERE direction = 'inbound')::int       AS inbound,
              COUNT(*) FILTER (WHERE direction = 'outbound')::int      AS outbound,
              COUNT(*) FILTER (WHERE answered)::int                    AS answered,
              COUNT(*) FILTER (WHERE direction = 'inbound' AND NOT answered)::int AS missed_inbound
       FROM fc
       WHERE start_stamp IS NOT NULL
       GROUP BY start_stamp::date
       ORDER BY day`,
      rangeParams(req.query),
    );
    res.json(rows);
  } catch (err) {
    fail(res, 'call-daily')(err);
  }
});

/**
 * GET /call-missed — inbound calls nobody answered, de-duplicated to the latest
 * per customer, flagged when the customer was later reached. The pending list is
 * who still needs calling back.
 */
router.get('/call-missed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH fc AS (SELECT c.* FROM pbx_calls c WHERE ${CALL_WHERE}),
       missed AS (
         SELECT DISTINCT ON (customer_norm)
                customer_norm, customer_number, start_stamp, uuid
         FROM fc
         WHERE direction = 'inbound' AND NOT answered AND customer_norm IS NOT NULL
         ORDER BY customer_norm, start_stamp DESC
       )
       SELECT m.customer_number,
              m.customer_norm,
              m.start_stamp AS last_missed_at,
              EXISTS (
                SELECT 1 FROM fc r
                WHERE r.customer_norm = m.customer_norm AND r.answered
              ) AS later_reached
       FROM missed m
       ORDER BY m.start_stamp DESC`,
      rangeParams(req.query),
    );
    const pending = rows.filter((r) => !r.later_reached);
    res.json({ total_missed_customers: rows.length, pending_callback: pending.length, items: rows });
  } catch (err) {
    fail(res, 'call-missed')(err);
  }
});

module.exports = router;
