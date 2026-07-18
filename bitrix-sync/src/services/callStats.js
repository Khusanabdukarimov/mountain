/**
 * CallStatistikasi payload, reconciled to match the OnlinePBX panel to the
 * second (logic ported from a live-verified deployment).
 *
 * Definitions, all confirmed against OnlinePBX:
 *   direction        accountcode (inbound / outbound / local=internal)
 *   Все (all)        inbound + outbound + internal
 *   answered/success talk_time > 0 (a real conversation)
 *   Пропущенные      inbound not answered
 *   НДЗ              outbound not answered
 *   Не перезвонили   a missed inbound with NO answered contact (either
 *                    direction) to that number within 24h — NOT just an outbound
 *                    callback; a customer who calls again and gets through counts
 *   разговоров       Σ talk_time   ·   длительность   Σ duration
 * Operator attribution follows OnlinePBX's own (see config/calls.js): inbound by
 * destination extension, so queue-missed calls belong to the queue, not a person.
 *
 * Rows must be fetched for [from, to+1 day] with an `in_range` flag so a call
 * missed on the last day can still see its next-day callback.
 */

const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;
const pctOf = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const ms = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

/**
 * @param rows { responsible_id, full_name, direction, customer_norm,
 *               start_stamp, duration, talk, answered, in_range }[]
 * @param filters {
 *   opId     when set, totals + rows are scoped to this operator, but the
 *            callback map stays global (a colleague's callback to the same
 *            customer still counts as reached);
 *   kind     inbound | outbound | callback (callback has no PBX analogue → 0);
 *   status   success | failed | missed | ndz | recalled | unrecalled;
 *   durFrom / durTo   seconds, on total call duration;
 * }
 */
function computeCallStatsFull(rows, dateFrom, dateTo, filters = {}) {
  const opId = filters.opId ?? null;
  const kind = filters.kind ?? null;
  const status = filters.status ?? null;
  const durFrom = filters.durFrom ?? null;
  const durTo = filters.durTo ?? null;

  // Answered-contact times per number (any direction), for callback detection.
  // Built from ALL rows, before any filtering — the callback map stays global.
  const contact = new Map();
  for (const r of rows) {
    if (!r.answered || !r.customer_norm) continue;
    const t = ms(r.start_stamp);
    if (t == null) continue;
    if (!contact.has(r.customer_norm)) contact.set(r.customer_norm, []);
    contact.get(r.customer_norm).push(t);
  }
  const contactedWithin = (num, missMs) =>
    (contact.get(num) || []).some((t) => t > missMs && t <= missMs + RECALL_WINDOW_MS);
  const firstContactAfter = (num, missMs) => {
    const c = (contact.get(num) || []).filter((t) => t > missMs && t <= missMs + RECALL_WINDOW_MS);
    return c.length ? Math.min(...c) : null;
  };

  const keep = (r) => {
    if (opId != null && Number(r.responsible_id) !== Number(opId)) return false;

    if (kind === 'inbound' || kind === 'outbound') {
      if (r.direction !== kind) return false;
    } else if (kind === 'callback') {
      return false; // OnlinePBX has no callback call type
    }

    const dur = Number(r.duration || 0);
    if (durFrom != null && dur < durFrom) return false;
    if (durTo != null && dur > durTo) return false;

    if (status) {
      const answered = !!r.answered;
      const missedIn = r.direction === 'inbound' && !answered;
      if (status === 'success' && !answered) return false;
      if (status === 'failed' && answered) return false;
      if (status === 'missed' && !missedIn) return false;
      if (status === 'ndz' && !(r.direction === 'outbound' && !answered)) return false;
      if (status === 'recalled' || status === 'unrecalled') {
        if (!missedIn) return false;
        const at = ms(r.start_stamp);
        const reached = !!(r.customer_norm && at != null && contactedWithin(r.customer_norm, at));
        if (status === 'recalled' && !reached) return false;
        if (status === 'unrecalled' && reached) return false;
      }
    }
    return true;
  };

  const ops = new Map();
  const getOp = (r) => {
    const key = r.responsible_id != null ? String(r.responsible_id) : 'queue';
    if (!ops.has(key)) {
      ops.set(key, {
        responsible_id: r.responsible_id != null ? Number(r.responsible_id) : null,
        full_name: r.full_name || 'Call Centre — javobsiz', photo_url: r.photo_url || null,
        inbound_calls: 0, outbound_calls: 0, callback_calls: 0,
        success_calls: 0, failed_calls: 0, ndz_calls: 0,
        missed_inbound: 0, missed_recalled: 0, missed_unrecalled: 0,
        talk_in: 0, talk_out: 0, dur_in: 0, dur_out: 0,
        _in: new Set(), _out: new Set(), _all: new Set(), _missed: [],
      });
    }
    return ops.get(key);
  };

  let inbound = 0, outbound = 0, internal = 0, missed = 0, ndz = 0, talkExt = 0, durExt = 0;
  const missedEvents = [];

  for (const r of rows) {
    if (!r.in_range) continue;
    if (!keep(r)) continue;
    if (r.direction === 'local') { internal += 1; continue; }
    if (r.direction !== 'inbound' && r.direction !== 'outbound') continue;

    const dur = Number(r.duration || 0);
    const talk = Number(r.talk || 0);
    const answered = !!r.answered;
    const b = getOp(r);
    talkExt += talk; durExt += dur;
    if (r.customer_norm) b._all.add(r.customer_norm);

    if (r.direction === 'inbound') {
      inbound += 1; b.inbound_calls += 1; b.talk_in += talk; b.dur_in += dur;
      if (r.customer_norm) b._in.add(r.customer_norm);
      if (answered) b.success_calls += 1;
      else {
        missed += 1; b.missed_inbound += 1; b.failed_calls += 1;
        const ev = { num: r.customer_norm, at: ms(r.start_stamp) };
        b._missed.push(ev); missedEvents.push(ev);
      }
    } else {
      outbound += 1; b.outbound_calls += 1; b.talk_out += talk; b.dur_out += dur;
      if (r.customer_norm) b._out.add(r.customer_norm);
      if (answered) b.success_calls += 1;
      else { ndz += 1; b.ndz_calls += 1; b.failed_calls += 1; }
    }
  }

  let nePerezvonili = 0;
  const reactions = [];
  for (const ev of missedEvents) {
    if (!ev.num || ev.at == null) { nePerezvonili += 1; continue; }
    const fc = firstContactAfter(ev.num, ev.at);
    if (fc) reactions.push(Math.round((fc - ev.at) / 1000));
    else nePerezvonili += 1;
  }

  const responsibles = [...ops.values()]
    .filter((b) => b.inbound_calls + b.outbound_calls > 0)
    .map((b) => {
      for (const m of b._missed) {
        if (m.num && m.at != null && contactedWithin(m.num, m.at)) b.missed_recalled += 1;
        else b.missed_unrecalled += 1;
      }
      const total = b.inbound_calls + b.outbound_calls;
      const talkTotal = b.talk_in + b.talk_out;
      const out = {
        responsible_id: b.responsible_id, full_name: b.full_name, photo_url: b.photo_url,
        inbound_calls: b.inbound_calls, outbound_calls: b.outbound_calls, total_calls: total,
        callback_calls: 0, success_calls: b.success_calls, failed_calls: b.failed_calls, ndz_calls: b.ndz_calls,
        missed_inbound: b.missed_inbound, missed_recalled: b.missed_recalled, missed_unrecalled: b.missed_unrecalled,
        unique_inbound: b._in.size, unique_outbound: b._out.size, unique_total: b._all.size,
        // Duration columns carry TALK time (разговоров) to match the OnlinePBX panel.
        inbound_duration: b.talk_in, outbound_duration: b.talk_out, total_duration: talkTotal,
        // Call length (длительность) kept separately for anyone who needs it.
        call_dur_in: b.dur_in, call_dur_out: b.dur_out, call_dur_total: b.dur_in + b.dur_out,
        avg_duration: total ? Math.round((b.dur_in + b.dur_out) / total) : 0,
      };
      return out;
    })
    .sort((a, b) => b.total_calls - a.total_calls);

  const external = inbound + outbound;
  const success = external - missed - ndz;
  return {
    date_from: dateFrom || '', date_to: dateTo || '',
    total_calls: external + internal,           // Все — matches OnlinePBX
    external_calls: external,
    inbound_calls: inbound, outbound_calls: outbound, internal_calls: internal, callback_calls: 0,
    success_calls: success, failed_calls: missed + ndz, ndz_calls: ndz, missed_inbound: missed,
    total_duration: talkExt,                    // разговоров (talk) — shown by the total card
    call_duration_total: durExt,                // длительность (call length)
    avg_duration: external ? Math.round(durExt / external) : 0,
    success_pct: pctOf(success, external), failed_pct: pctOf(missed + ndz, external),
    ne_perezvonili: nePerezvonili,
    reaksiya_vaqti: reactions.length ? Math.round(reactions.reduce((s, n) => s + n, 0) / reactions.length) : 0,
    responsibles,
  };
}

module.exports = { computeCallStatsFull };
