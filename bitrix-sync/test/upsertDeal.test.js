const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath),
    filename: require.resolve(modulePath),
    loaded: true,
    exports,
  };
}

mock('../src/db/pool', {
  query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 7760 }] }; },
});
mock('../src/services/stageResolver', { resolve: async () => 1 });
mock('../src/services/currencyRates', { toUSD: async v => v });

const { upsertDeal } = require('../src/services/upsertDeal');

const raw = { ID: '7760', ASSIGNED_BY_ID: '18', STAGE_ID: 'C0:WON', OPPORTUNITY: '7963', CURRENCY_ID: 'USD', LEAD_ID: null };

test('stores the deal card UTM_CAMPAIGN and UTM_CONTENT, one placeholder per value', async () => {
  calls.length = 0;
  await upsertDeal({
    ...raw,
    UTM_CAMPAIGN: 'AE | Leads | Mountain | 16.09',
    UTM_CONTENT: 'Savlat - TOF - Instant forms - Uzb - M - I/Business - 18.07.26 – Copy',
  });

  const { sql, params } = calls[0];
  const placeholders = new Set(sql.match(/\$\d+/g));
  assert.equal(placeholders.size, params.length);
  assert.deepEqual(params.slice(-2), [
    'AE | Leads | Mountain | 16.09',
    'Savlat - TOF - Instant forms - Uzb - M - I/Business - 18.07.26 – Copy',
  ]);
  assert.match(sql, /utm_campaign\s*=\s*COALESCE\(EXCLUDED\.utm_campaign, deals\.utm_campaign\)/);
  assert.match(sql, /utm_content\s*=\s*COALESCE\(EXCLUDED\.utm_content, deals\.utm_content\)/);
});

test('a deal without UTM fields passes NULL, which the upsert keeps from erasing stored values', async () => {
  calls.length = 0;
  await upsertDeal(raw);
  assert.deepEqual(calls[0].params.slice(-2), [null, null]);
});
