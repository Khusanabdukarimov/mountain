const test = require('node:test');
const assert = require('node:assert/strict');

const { attributedSales, rowKey } = require('../src/services/creativeSales');

test('rowKey identifies a creative row by adset, campaign and ad; missing parts are stable', () => {
  assert.equal(rowKey('Adset', 'Camp', '123'), 'Adset|Camp|123');
  assert.equal(rowKey(null, null, null), 'N/A|N/A|');
  assert.notEqual(rowKey('A', 'C', '1'), rowKey('A', 'C', '2'));
});

test('attributedSales passes the lead window and the sale window to the query, in that order', async () => {
  let seen;
  const db = { query: async (sql, params) => { seen = { sql, params }; return { rows: [{ deal_id: 1 }] }; } };
  const rows = await attributedSales(db, { since: '2026-10-01', until: '2026-10-31', sotuvFrom: '2026-10-05', sotuvTo: '2026-10-20' });
  assert.deepEqual(rows, [{ deal_id: 1 }]);
  assert.deepEqual(seen.params, ['2026-10-01', '2026-10-31', '2026-10-05', '2026-10-20']);
  // one row per deal: the form-lead candidates are reduced with DISTINCT ON (deal_id)
  assert.match(seen.sql, /SELECT DISTINCT ON \(c\.deal_id\)/);
});
