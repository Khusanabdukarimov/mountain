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

test('stores the deal card UTM_CAMPAIGN as the last parameter, one placeholder per value', async () => {
  calls.length = 0;
  await upsertDeal({ ...raw, UTM_CAMPAIGN: 'AE | Leads | Mountain | 16.09' });

  const { sql, params } = calls[0];
  const placeholders = new Set(sql.match(/\$\d+/g));
  assert.equal(placeholders.size, params.length);
  assert.equal(params[params.length - 1], 'AE | Leads | Mountain | 16.09');
  assert.match(sql, /utm_campaign\s*=\s*COALESCE\(EXCLUDED\.utm_campaign, deals\.utm_campaign\)/);
});

test('a deal without UTM_CAMPAIGN passes NULL, which the upsert keeps from erasing a stored value', async () => {
  calls.length = 0;
  await upsertDeal(raw);
  assert.equal(calls[0].params[calls[0].params.length - 1], null);
});
