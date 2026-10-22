const test = require('node:test');
const assert = require('node:assert/strict');

const state = { campaign: null, rawCampaign: null, assignments: [] };

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath),
    filename: require.resolve(modulePath),
    loaded: true,
    exports,
  };
}

mock('../src/db/pool', {
  query: async (sql) => {
    if (sql.includes('SELECT stage_id FROM leads')) {
      return { rows: [{ stage_id: null }] };
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

test('a lead update, even one that changes the campaign UTM, never re-distributes the lead', async () => {
  // streams are keyed by form name (the lead title, known at creation), so there is nothing to re-route
  state.rawCampaign = 'Campaign A';
  await leadUpdated(req, res);
  state.rawCampaign = 'Campaign B';
  await leadUpdated(req, res);
  assert.deepEqual(state.assignments, []);
});
