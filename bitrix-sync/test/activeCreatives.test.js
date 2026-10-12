const test = require('node:test');
const assert = require('node:assert/strict');

const state = { known: [], inserted: [], deactivate: null };

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath),
    filename: require.resolve(modulePath),
    loaded: true,
    exports,
  };
}

mock('../src/db/pool', {
  query: async (sql, params) => {
    if (sql.includes('SELECT ad_id FROM meta_active_creatives')) {
      return { rows: state.known.map(ad_id => ({ ad_id })) };
    }
    if (sql.includes('INSERT INTO meta_active_creatives')) {
      state.inserted.push(params);
      return { rowCount: 1 };
    }
    if (sql.includes('UPDATE meta_active_creatives')) {
      state.deactivate = params;
      return { rowCount: 2 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
});

const { syncActiveCreatives } = require('../src/services/activeCreatives');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();
const ad = (id, over = {}) => ({
  id, name: `ad ${id}`, created_time: daysAgo(2),
  campaign: { id: 'c1', name: 'Campaign 1', objective: 'OUTCOME_LEADS' },
  adset: { id: 's1', name: 'Adset 1' }, creative: { id: 'k1', name: 'Creative 1' },
  ...over,
});

test('lists new active lead-gen ads and skips the rest', async () => {
  state.known = []; state.inserted = []; state.deactivate = null;
  const ads = [
    ad('new-lead-ad'),
    ad('awareness', { campaign: { id: 'c2', name: 'Awareness', objective: 'OUTCOME_AWARENESS' } }),
    ad('old-lead-ad', { created_time: daysAgo(150) }),
    ad('no-campaign-name', { campaign: { id: 'c3', objective: 'LEAD_GENERATION' } }),
  ];

  const result = await syncActiveCreatives('act_1', ads, null, NOW);

  assert.deepEqual(state.inserted.map(p => p[0]), ['new-lead-ad', 'no-campaign-name']);
  assert.deepEqual(state.inserted[0], ['new-lead-ad', 'act_1', 'c1', 'Campaign 1', 's1', 'Adset 1', 'ad new-lead-ad', 'k1', 'Creative 1']);
  assert.equal(state.inserted[1][3], 'N/A');
  assert.deepEqual(result, { upserted: 2, deactivated: 2 });
});

test('keeps an already listed ad however old it is, and honours the campaign whitelist', async () => {
  state.known = ['old-lead-ad']; state.inserted = [];
  const ads = [
    ad('old-lead-ad', { created_time: daysAgo(150) }),
    ad('outside-whitelist', { campaign: { id: 'other', name: 'Other', objective: 'OUTCOME_LEADS' } }),
    ad('inside-whitelist'),
  ];

  await syncActiveCreatives('act_1', ads, ['c1'], NOW);

  assert.deepEqual(state.inserted.map(p => p[0]), ['old-lead-ad', 'inside-whitelist']);
});

test('deactivation is scoped to the account and compares against every active ad', async () => {
  state.known = []; state.inserted = []; state.deactivate = null;
  const ads = [ad('a'), ad('awareness', { campaign: { id: 'c2', name: 'Awareness', objective: 'OUTCOME_AWARENESS' } })];

  await syncActiveCreatives('act_123', ads, null, NOW);

  // account id with and without the act_ prefix; the awareness ad is still active
  // on Meta, so it must not be passed as "gone".
  assert.deepEqual(state.deactivate, [['act_123', '123'], ['a', 'awareness']]);
});
