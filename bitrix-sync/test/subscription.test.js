const test = require('node:test');
const assert = require('node:assert/strict');

const state = { row: null, fail: false };

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports,
  };
}
mock('../src/db/pool', {
  query: async () => { if (state.fail) throw new Error('relation "app_subscription" does not exist'); return { rows: state.row ? [state.row] : [] }; },
});

const { subscriptionGuard, buildStatus, resetCache } = require('../src/middleware/subscription');

const NOW = new Date('2026-10-20T12:00:00Z');
const ms = n => new Date(NOW.getTime() + n * 1000);

async function run(path) {
  resetCache();
  const out = { next: false, status: null, body: null, headers: {} };
  const res = {
    set(k, v) { out.headers[k] = v; return this; },
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  await subscriptionGuard({ path }, res, () => { out.next = true; });
  return out;
}

test('buildStatus: no row, countdown, expired, custom support', () => {
  assert.deepEqual([buildStatus(null, NOW).enabled, buildStatus(null, NOW).expired], [false, false]);
  const live = buildStatus({ expires_at: ms(3 * 86400 + 5), support_contact: null }, NOW);
  assert.equal(live.expired, false);
  assert.equal(live.seconds_left, 3 * 86400 + 5);
  assert.equal(live.support, '@Jahongir_data365');
  assert.equal(live.support_url, 'https://t.me/Jahongir_data365');
  assert.equal(buildStatus({ expires_at: ms(-1) }, NOW).expired, true);
  assert.equal(buildStatus({ expires_at: NOW }, NOW).expired, true);
  assert.equal(buildStatus({ expires_at: ms(60), support_contact: ' @other ' }, NOW).support_url, 'https://t.me/other');
});

test('Tashkent midnight is 19:00 UTC the day before', () => {
  const expires = new Date('2026-10-30T00:00:00+05:00');
  assert.equal(buildStatus({ expires_at: expires }, new Date('2026-10-29T18:59:59Z')).expired, false);
  assert.equal(buildStatus({ expires_at: expires }, new Date('2026-10-29T19:00:00Z')).expired, true);
});

test('expired: every /api/ path gets 402 subscription_expired, including the public payments webhook', async () => {
  state.fail = false; state.row = { expires_at: new Date(Date.now() - 1000), support_contact: null };
  for (const path of ['/api/dashboard/leads', '/api/dashboard/payments', '/api/campaigns/creatives', '/api/reja/plans']) {
    const r = await run(path);
    assert.equal(r.next, false, path);
    assert.equal(r.status, 402, path);
    assert.equal(r.body.code, 'subscription_expired');
    assert.match(r.body.message, /Mountain/);
    assert.equal(r.body.support, '@Jahongir_data365');
    assert.equal(r.headers['Cache-Control'], 'no-store');
  }
});

test('expired: webhooks and the status endpoint stay open', async () => {
  state.fail = false; state.row = { expires_at: new Date(Date.now() - 1000) };
  for (const path of ['/webhook/lead/created', '/webhook/facebook', '/health', '/api/subscription']) {
    const r = await run(path);
    assert.equal(r.next, true, path);
  }
});

test('not expired, no row, or an unreadable table: nothing is blocked', async () => {
  state.fail = false; state.row = { expires_at: new Date(Date.now() + 86400000) };
  assert.equal((await run('/api/dashboard/leads')).next, true);
  state.row = null;
  assert.equal((await run('/api/dashboard/leads')).next, true);
  state.fail = true;
  assert.equal((await run('/api/dashboard/leads')).next, true);
});
