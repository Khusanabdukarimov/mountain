'use strict';

// Distribution streams are keyed by FORM NAME, matched against the lead's title
// with SQL ILIKE — not by Meta campaign.
//
// A Target lead's title is its form name: ours is exactly the name ("DU - Proten -
// 16.10.25"), Bitrix's connector wraps it (`Заполнение CRM-формы "DU - Proten -
// 16.10.25"`), and managers later add their own notes around it. A stream therefore
// means "title CONTAINS this text", so "DU - Proten" takes every DU - Proten form,
// whatever its date suffix or decoration; a % in it is a LIKE wildcard
// ("Xa Mountain%QL"). Several streams can match one lead: the longest (most specific) wins.
//
// The title exists the moment Bitrix creates the lead — unlike the UTM tags the
// connector fills in afterwards — so a lead is routed right away, no re-routing.

const MAX_LEN = 200;

/**
 * The ILIKE pattern for a stream written by an admin: always "the title contains it", so a
 * manager's note before or after the form name never breaks the match. A % inside the text
 * is a wildcard ("Xa Mountain%QL"); _ and \ are literal.
 */
function toLike(pattern) {
  const p = String(pattern == null ? '' : pattern).trim();
  return `%${p.replace(/[\\_]/g, '\\$&')}%`;
}

/** Stream name from user input, or null when it is empty / too long. */
function cleanPattern(input) {
  const p = String(input == null ? '' : input).trim();
  return p && p.length <= MAX_LEN ? p : null;
}

/** Active streams as { patterns, likes } (parallel arrays), for `unnest($1::text[], $2::text[])` and `ILIKE ANY($2)`. */
async function activeStreams(db) {
  const { rows } = await db.query('SELECT form_pattern FROM taqsimot_form_settings WHERE active = TRUE ORDER BY form_pattern');
  const patterns = rows.map(r => r.form_pattern);
  return { patterns, likes: patterns.map(toLike) };
}

/** The most specific active stream that matches `title`, or null. */
async function streamForTitle(db, title, streams) {
  const { patterns, likes } = streams || await activeStreams(db);
  if (!patterns.length || !title) return null;
  const { rows } = await db.query(
    `SELECT p.pattern FROM unnest($1::text[], $2::text[]) AS p(pattern, lk)
      WHERE $3::text ILIKE p.lk ORDER BY length(p.pattern) DESC, p.pattern LIMIT 1`,
    [patterns, likes, title]);
  return rows[0] ? rows[0].pattern : null;
}

module.exports = { toLike, cleanPattern, activeStreams, streamForTitle, MAX_LEN };
