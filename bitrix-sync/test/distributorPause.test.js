const test = require('node:test');
const assert = require('node:assert/strict');

const state = { expired: false, connects: 0, logs: [] };

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports,
  };
}
mock('../src/db/pool', {
  connect: async () => {
    state.connects++;
    // a client whose queries find no lead: the distributor rolls back and returns null
    return { query: async sql => (/SELECT COALESCE\(NULLIF\(l\.utm_campaign/.test(sql) ? { rows: [] } : { rows: [] }), release() {} };
  },
});
mock('../src/services/bitrix', { bitrixCall: async () => ({}) });
mock('../src/middleware/subscription', { getStatus: async () => ({ expired: state.expired }) });

const { distributeLead } = require('../src/services/distributor');
const realLog = console.log;

test('expired subscription: nothing is distributed and the database is not touched', async () => {
  state.expired = true; state.connects = 0; state.logs = [];
  console.log = (...a) => state.logs.push(a.join(' '));
  let result;
  try { result = await distributeLead(123, 'Some campaign'); } finally { console.log = realLog; }
  assert.equal(result, null);
  assert.equal(state.connects, 0);
  assert.match(state.logs.join('\n'), /Lead 123 NOT distributed: subscription expired/);
});

test('active subscription: distribution proceeds as before', async () => {
  state.expired = false; state.connects = 0;
  const realErr = console.error; console.error = () => {};
  try { await distributeLead(123); } finally { console.error = realErr; }
  assert.equal(state.connects, 1);
});
