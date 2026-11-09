const test = require('node:test');
const assert = require('node:assert/strict');

const state = { cache: new Map(), queries: [], bitrixCalls: [], bitrix: new Map(), bitrixFails: false, freshIds: new Set() };

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports,
  };
}
mock('../src/db/pool', {
  query: async (sql, params) => {
    state.queries.push(sql);
    if (/CREATE TABLE/.test(sql)) return { rows: [] };
    if (/SELECT id, name, phone/.test(sql)) {
      return { rows: params[0].filter(id => state.cache.has(id)).map(id => ({ id, ...state.cache.get(id), fresh: state.freshIds.has(id) })) };
    }
    if (/INSERT INTO crm_contacts/.test(sql)) { state.cache.set(Number(params[0]), { name: params[1], phone: params[2] }); state.freshIds.add(Number(params[0])); return { rows: [] }; }
    throw new Error(`unexpected sql ${sql.slice(0, 40)}`);
  },
});
mock('../src/services/bitrix', {
  bitrixPost: async (method, params) => {
    state.bitrixCalls.push({ method, ids: params.filter.ID });
    if (state.bitrixFails) return { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'too many requests' };
    return { result: params.filter.ID.filter(id => state.bitrix.has(id)).map(id => ({ ID: String(id), ...state.bitrix.get(id) })) };
  },
});

const { getContacts, fullName, firstPhone, toRows } = require('../src/services/dealContacts');
const reset = () => { state.cache = new Map(); state.queries = []; state.bitrixCalls = []; state.bitrix = new Map(); state.bitrixFails = false; state.freshIds = new Set(); };

test('fullName: first + last name; placeholder names are no name', () => {
  assert.equal(fullName({ NAME: 'Samariddin', LAST_NAME: 'aka rukkola' }), 'Samariddin aka rukkola');
  assert.equal(fullName({ NAME: 'Habibullo ', LAST_NAME: "Yo'l qurulish" }), "Habibullo Yo'l qurulish");
  assert.equal(fullName({ NAME: 'Анас', LAST_NAME: '' }), 'Анас');
  assert.equal(fullName({ NAME: '.', LAST_NAME: '.' }), '');
  assert.equal(fullName({}), '');
});

test('firstPhone: the first non-empty number as written', () => {
  assert.equal(firstPhone({ PHONE: [{ VALUE: '+998977039536' }, { VALUE: '+998977039536' }] }), '+998977039536');
  assert.equal(firstPhone({ PHONE: [{ VALUE: ' ' }, { VALUE: '998701010' }] }), '998701010');
  assert.equal(firstPhone({}), '');
});

test('toRows: a contact Bitrix did not return (deleted) is stored empty, so it is not asked again every time', () => {
  assert.deepEqual(toRows([1, 2], [{ ID: '1', NAME: 'Ali', PHONE: [{ VALUE: '+998901112233' }] }]),
    [{ id: 1, name: 'Ali', phone: '+998901112233' }, { id: 2, name: '', phone: '' }]);
});

test('first view reads Bitrix once and caches; the second view is served from the cache', async () => {
  reset();
  state.bitrix.set(6040, { NAME: 'Asror', LAST_NAME: '', PHONE: [{ VALUE: '+998977039536' }] });
  const a = await getContacts([6040, 6040, null, undefined]);
  assert.deepEqual(a.get(6040), { name: 'Asror', phone: '+998977039536' });
  assert.equal(state.bitrixCalls.length, 1);
  assert.deepEqual(state.bitrixCalls[0].ids, [6040]);
  const b = await getContacts([6040]);
  assert.deepEqual(b.get(6040), { name: 'Asror', phone: '+998977039536' });
  assert.equal(state.bitrixCalls.length, 1);
});

test('only the missing or stale contacts are asked from Bitrix', async () => {
  reset();
  state.cache.set(1, { name: 'Cached', phone: '111' }); state.freshIds.add(1);
  state.cache.set(2, { name: 'Old', phone: '222' });               // stale
  state.bitrix.set(2, { NAME: 'New', PHONE: [{ VALUE: '333' }] });
  state.bitrix.set(3, { NAME: 'Third', PHONE: [] });
  const m = await getContacts([1, 2, 3]);
  assert.deepEqual(state.bitrixCalls[0].ids, [2, 3]);
  assert.deepEqual(m.get(1), { name: 'Cached', phone: '111' });
  assert.deepEqual(m.get(2), { name: 'New', phone: '333' });
  assert.deepEqual(m.get(3), { name: 'Third', phone: '' });
});

test('Bitrix failing: the stale cache is served and nothing throws', async () => {
  reset();
  state.cache.set(2, { name: 'Old', phone: '222' });
  state.bitrixFails = true;
  const m = await getContacts([2, 9]);
  assert.deepEqual(m.get(2), { name: 'Old', phone: '222' });
  assert.equal(m.has(9), false);
});

test('more than 50 contacts are read in pages of 50', async () => {
  reset();
  const ids = Array.from({ length: 120 }, (_, i) => i + 1);
  for (const id of ids) state.bitrix.set(id, { NAME: `C${id}`, PHONE: [] });
  const t0 = Date.now();
  const m = await getContacts(ids);
  assert.deepEqual(state.bitrixCalls.map(c => c.ids.length), [50, 50, 20]);
  assert.equal(m.size, 120);
  assert.ok(Date.now() - t0 >= 1100, 'respects the 2 requests/second limit');
});
