const test = require('node:test');
const assert = require('node:assert/strict');

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports,
  };
}
mock('../src/db/pool', { query: async () => ({ rows: [] }) });

const { getSubperiods } = require('../src/api/reja');
const plan = (over = {}) => ({ period_type: 'monthly', period_start: '2026-10-01', period_end: '2026-10-31', week_start: null, ...over });
const ranges = sp => sp.map(w => `${w.start}..${w.end}`);
const nextDay = iso => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

test('no week start: four 7-day weeks from the plan start, the last one to the period end', () => {
  assert.deepEqual(ranges(getSubperiods(plan())), [
    '2026-10-01..2026-10-07', '2026-10-08..2026-10-14', '2026-10-15..2026-10-21', '2026-10-22..2026-10-31']);
});

test('a later week start: 1-hafta takes the days before it, so the whole period stays covered', () => {
  // Monday 5 Oct: Mon-Sun weeks, 1-hafta also holds 1-4 Oct, 4-hafta runs to the month end
  assert.deepEqual(ranges(getSubperiods(plan({ week_start: '2026-10-05' }))), [
    '2026-10-01..2026-10-11', '2026-10-12..2026-10-18', '2026-10-19..2026-10-25', '2026-10-26..2026-10-31']);
});

test('a week start before the period: 1-hafta is cut to the period start', () => {
  // Monday 28 Sep: 1-hafta is 1-4 Oct (Thu-Sun), then Mon-Sun weeks
  assert.deepEqual(ranges(getSubperiods(plan({ week_start: '2026-09-28' }))), [
    '2026-10-01..2026-10-04', '2026-10-05..2026-10-11', '2026-10-12..2026-10-18', '2026-10-19..2026-10-31']);
});

test('the weeks are contiguous and cover exactly the period, whatever the week start', () => {
  for (let d = -6; d <= 10; d++) {
    const ws = new Date(Date.UTC(2026, 9, 1 + d)).toISOString().slice(0, 10);
    const sp = getSubperiods(plan({ week_start: ws }));
    assert.equal(sp[0].start, '2026-10-01');
    assert.equal(sp[3].end, '2026-10-31');
    for (let i = 1; i < 4; i++) {
      assert.equal(sp[i].start, nextDay(sp[i - 1].end), `week ${i + 1} follows week ${i} (week_start ${ws})`);
      assert.ok(sp[i].start <= sp[i].end, `week ${i + 1} is not empty (week_start ${ws})`);
    }
  }
});

test('a week start that would leave a week empty is ignored', () => {
  const normal = ranges(getSubperiods(plan()));
  assert.deepEqual(ranges(getSubperiods(plan({ week_start: '2026-10-15' }))), normal);  // 4-hafta would start after the end
  assert.deepEqual(ranges(getSubperiods(plan({ week_start: '2026-09-20' }))), normal);  // 1-hafta would end before the start
});
