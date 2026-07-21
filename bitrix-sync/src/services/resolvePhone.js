// Candidate phone field keys, in priority order.
const PHONE_FIELD_KEYS = [
  'phone_number', 'phone',
  'telefon_raqamingizni_qoldiring!', 'номер_телефона',
  'telefon_raqamingiz:', 'telefon_raqamingiz',
];

/**
 * Pick the best phone from a lead-form fields object. Some forms carry BOTH
 * Meta's built-in "Phone number" field and a free-text "Telefon raqamingiz"
 * field — a spam/careless submission can leave one junk ("1") while the
 * other holds a real number. Prefer whichever candidate is a valid
 * >=9-digit phone; only fall back to the first non-empty (possibly junk)
 * value if none qualify.
 *
 * Used by both the real-time webhook (facebookWebhook.js) and the periodic
 * Meta API sync (campaigns.js upsertLead) — both ingestion paths must agree,
 * otherwise the scheduled sync re-overwrites a webhook-resolved phone (or a
 * manual DB correction) back to a junk value on its next run.
 */
function resolvePhone(fields) {
  const candidates = PHONE_FIELD_KEYS.map(k => fields[k]).filter(Boolean);
  const valid = candidates.find(v => String(v).replace(/[^0-9]/g, '').length >= 9);
  return valid || candidates[0] || null;
}

module.exports = { resolvePhone };
