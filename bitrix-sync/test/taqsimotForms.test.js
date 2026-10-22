const test = require('node:test');
const assert = require('node:assert/strict');

const { toLike, cleanPattern, activeStreams, streamForTitle } = require('../src/services/taqsimotForms');

test('a stream means "the title contains it"; _ and \\ stay literal', () => {
  assert.equal(toLike('DU - Proten'), '%DU - Proten%');
  assert.equal(toLike('  Xa Mountain 14.10 QL  '), '%Xa Mountain 14.10 QL%');
  assert.equal(toLike('a_b'), '%a\\_b%');
  assert.equal(toLike('a\\b'), '%a\\\\b%');
});

test('a % inside the text stays a wildcard, and the match is still "contains"', () => {
  assert.equal(toLike('Xa Mountain%QL'), '%Xa Mountain%QL%');
  assert.equal(toLike('DU%'), '%DU%%');
});

test('cleanPattern: trims, rejects empty and over-long names', () => {
  assert.equal(cleanPattern('  DU - Proten '), 'DU - Proten');
  assert.equal(cleanPattern('   '), null);
  assert.equal(cleanPattern(undefined), null);
  assert.equal(cleanPattern('x'.repeat(201)), null);
  assert.equal(cleanPattern('x'.repeat(200)), 'x'.repeat(200));
});

test('activeStreams hands the matcher parallel pattern / LIKE arrays', async () => {
  const db = { query: async () => ({ rows: [{ form_pattern: 'DU - Proten' }, { form_pattern: 'Xa Mountain%QL' }] }) };
  assert.deepEqual(await activeStreams(db), { patterns: ['DU - Proten', 'Xa Mountain%QL'], likes: ['%DU - Proten%', '%Xa Mountain%QL%'] });
});

test('streamForTitle asks the database to match the title and returns the most specific stream', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ pattern: 'DU - Proten' }] }; } };
  const streams = { patterns: ['DU', 'DU - Proten'], likes: ['%DU%', '%DU - Proten%'] };
  assert.equal(await streamForTitle(db, 'Заполнение CRM-формы "DU - Proten - 16.10.25"', streams), 'DU - Proten');
  assert.match(calls[0].sql, /ILIKE p\.lk ORDER BY length\(p\.pattern\) DESC/);
  assert.deepEqual(calls[0].params, [streams.patterns, streams.likes, 'Заполнение CRM-формы "DU - Proten - 16.10.25"']);
});

test('no active streams, or no title: no query and no stream', async () => {
  let queried = false;
  const db = { query: async () => { queried = true; return { rows: [] }; } };
  assert.equal(await streamForTitle(db, 'Forma 2', { patterns: [], likes: [] }), null);
  assert.equal(await streamForTitle(db, '', { patterns: ['x'], likes: ['%x%'] }), null);
  assert.equal(queried, false);
});
