const test = require('node:test');
const assert = require('node:assert/strict');

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports,
  };
}
mock('../src/db/pool', { query: async () => { throw new Error('no table yet'); } });

const { departmentScope, deptCsv, restrictResponsibleIds, DEFAULT_MEMBERS } = require('../src/services/salesDepartment');

test('the seed is the nine people of Bitrix departments 2, 36 and 52', () => {
  assert.deepEqual([...DEFAULT_MEMBERS].sort((a, b) => a - b), [12, 14, 16, 18, 20, 22, 32, 74, 106]);
});

test('no responsible picked: the whole department', () => {
  assert.equal(restrictResponsibleIds(undefined, [1, 2, 3]), '1,2,3');
  assert.equal(restrictResponsibleIds('', [1, 2, 3]), '1,2,3');
});

test('a responsible picked: only those who belong to the department', () => {
  assert.equal(restrictResponsibleIds('2', [1, 2, 3]), '2');
  assert.equal(restrictResponsibleIds('2,3,99', [1, 2, 3]), '2,3');
});

test('nobody picked belongs to the department: matches nothing instead of everything', () => {
  assert.equal(restrictResponsibleIds('99', [1, 2, 3]), '0');
  assert.equal(restrictResponsibleIds('99,98', [1, 2, 3]), '0');
});

const run = async (path, query) => {
  const req = { path, query: { ...query } };
  let called = false;
  await departmentScope(req, {}, () => { called = true; });
  assert.ok(called);
  return req;
};

test('a request without ?dept=sotuv is left alone', async () => {
  const req = await run('/lead-stats', { responsible_id: '5' });
  assert.equal(req.query.responsible_id, '5');
  assert.equal(req.deptIds, undefined);
  assert.equal(deptCsv(req), null);
});

test('?dept=sotuv on an endpoint with a responsible filter rewrites that filter', async () => {
  const req = await run('/deals-list', { dept: 'sotuv' });
  assert.equal(req.query.responsible_id, DEFAULT_MEMBERS.join(','));
  assert.equal(deptCsv(req), DEFAULT_MEMBERS.join(','));
  const picked = await run('/lead-stats', { dept: 'sotuv', responsible_id: '20,999' });
  assert.equal(picked.query.responsible_id, '20');
});

test('?dept=sotuv on other endpoints only exposes the member list', async () => {
  const req = await run('/utm-stats', { dept: 'sotuv' });
  assert.equal(req.query.responsible_id, undefined);
  assert.equal(deptCsv(req), DEFAULT_MEMBERS.join(','));
  // responsible-leads' responsible_id is a drill-down key, never rewritten
  const drill = await run('/responsible-leads', { dept: 'sotuv', responsible_id: '999' });
  assert.equal(drill.query.responsible_id, '999');
});
