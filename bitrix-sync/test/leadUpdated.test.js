const test = require('node:test');
const assert = require('node:assert/strict');

const state = { campaign: null, rawCampaign: null, assignments: [] };
const activeCampaigns = new Set(['Campaign A', 'Campaign B']);

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
    if (sql.includes('SELECT stage_id, utm_campaign FROM leads')) {
      return { rows: [{ stage_id: null, utm_campaign: state.campaign }] };
    }
    if (sql.includes('SELECT 1 FROM taqsimot_campaign_settings')) {
      return { rows: activeCampaigns.has(params[0]) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('SELECT l.stage_id, s.bitrix_id')) return { rows: [] };
    return { rows: [] };
  },
});
mock('../src/services/bitrix', {
  fetchOne: async () => ({ UTM_CAMPAIGN: state.rawCampaign }),
});
mock('../src/services/upsertLead', {
  upsertLead: async raw => { state.campaign = raw.UTM_CAMPAIGN || null; },
});
mock('../src/services/metaConversions', { sendQualifiedLead: async () => null });
mock('../src/services/distributor', {
  distributeLead: async (id, campaign) => { state.assignments.push([id, campaign]); },
});

const leadUpdated = require('../src/webhooks/leadUpdated');
const req = { body: { data: { FIELDS: { ID: '123' } } } };
const res = { sendStatus: code => assert.equal(code, 200) };

test('UTM update re-distributes only when campaign changes to an active campaign', async () => {
  state.rawCampaign = 'Campaign A';
  await leadUpdated(req, res);
  assert.deepEqual(state.assignments, [[123, 'Campaign A']]);

  await leadUpdated(req, res); // distributor/ordinary update echo
  assert.equal(state.assignments.length, 1);

  state.rawCampaign = 'Inactive campaign';
  await leadUpdated(req, res);
  assert.equal(state.assignments.length, 1);

  state.rawCampaign = 'Campaign B';
  await leadUpdated(req, res);
  assert.deepEqual(state.assignments, [[123, 'Campaign A'], [123, 'Campaign B']]);
});
