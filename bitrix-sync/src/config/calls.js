/**
 * OnlinePBX call model — semantics verified against a live OnlinePBX CDR feed.
 *
 * A record from mongo_history/search.json looks like:
 *   { uuid, caller_id_name, caller_id_number, destination_number,
 *     start_stamp, end_stamp, duration, user_talk_time, hangup_cause,
 *     accountcode: 'inbound'|'outbound'|'local', contacted?, gateway,
 *     quality_score, events: [{type:'transfer'|'user', number, ...}] }
 *
 * These helpers turn that into the fields the dashboard reports on. They are
 * pure functions of one record so they can be unit-tested without a PBX.
 */

/** accountcode is the direction of the call. */
const DIRECTIONS = ['inbound', 'outbound', 'local'];

/**
 * "Answered" = an agent actually talked. user_talk_time is the only field that
 * means a live conversation happened — hangup_cause NORMAL_CLEARING and the
 * presence of a "user" ring event both include calls that rang an extension but
 * were never picked up.
 */
function isAnswered(rec) {
  return (rec.user_talk_time || 0) > 0;
}

/**
 * A missed inbound: the customer called and no agent talked to them. These are
 * the call-backs owed — the number worth surfacing on the dashboard.
 */
function isMissedInbound(rec) {
  return rec.accountcode === 'inbound' && !isAnswered(rec);
}

/**
 * The extension the call belongs to, matching how OnlinePBX itself attributes
 * calls when you filter its call log by extension:
 *
 *   outbound / local → the extension that dialed (caller_id_number)
 *   inbound          → destination_number when it is an extension. OnlinePBX
 *                      rewrites destination_number to the ANSWERING extension
 *                      even for calls that arrived through a queue, so this
 *                      covers answered queue calls too. A missed queue call
 *                      keeps the queue number (e.g. 5200) as its destination and
 *                      therefore belongs to nobody — it is the queue's, not a
 *                      person's. Only a missed call dialled DIRECTLY to an
 *                      extension is attributed to that extension.
 *
 * The answered-user fallback covers the rare answered call whose destination
 * stayed a queue number.
 *
 * `knownExts` is the set of real extension numbers; a destination that isn't one
 * (a queue, an IVR) yields null. Pass it from pbx_users so the rule needs no
 * hardcoded extension list.
 */
function operatorExt(rec, knownExts) {
  const isExt = (n) => (knownExts ? knownExts.has(String(n)) : /^\d{2,4}$/.test(String(n || '')));

  if (rec.accountcode === 'outbound' || rec.accountcode === 'local') {
    return isExt(rec.caller_id_number) ? String(rec.caller_id_number) : null;
  }
  // inbound
  if (isExt(rec.destination_number)) return String(rec.destination_number);
  if (isAnswered(rec)) {
    const userEvents = (rec.events || []).filter((e) => e.type === 'user' && e.number);
    if (userEvents.length) return String(userEvents[userEvents.length - 1].number);
  }
  return null; // queue-missed → belongs to the queue, not an operator
}

/**
 * The external party's phone number (the customer), independent of direction:
 *   outbound → who we called (destination_number)
 *   inbound  → who called us (caller_id_number)
 */
function customerNumber(rec) {
  if (rec.accountcode === 'outbound') return rec.destination_number || null;
  if (rec.accountcode === 'inbound') return rec.caller_id_number || null;
  return null; // local call — both parties internal
}

/**
 * Last N digits of a phone, for matching against lead phones stored in another
 * format (+998 90 123 45 67 vs 901234567). 9 covers Uzbek/Kazakh subscriber
 * numbers without the country code.
 */
function normalizePhone(num) {
  if (!num) return null;
  const digits = String(num).replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

/** hangup_cause values that mean the far end never answered (for reporting). */
const NO_ANSWER_CAUSES = new Set([
  'ORIGINATOR_CANCEL', 'NO_ANSWER', 'NO_USER_RESPONSE', 'USER_BUSY',
  'SUBSCRIBER_ABSENT', 'RECOVERY_ON_TIMER_EXPIRE',
]);

module.exports = {
  DIRECTIONS,
  NO_ANSWER_CAUSES,
  isAnswered,
  isMissedInbound,
  operatorExt,
  customerNumber,
  normalizePhone,
};
