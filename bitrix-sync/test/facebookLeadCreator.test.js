const test = require('node:test');
const assert = require('node:assert/strict');

const state = { queries: [], calls: [], phoneLeads: [], addResult: { result: 5001 }, claimed: [] };

function mock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports,
  };
}
mock('../src/db/pool', {
  query: async (sql, params) => {
    state.queries.push({ sql, params });
    if (/SELECT bitrix_lead_id FROM facebook_leads/.test(sql)) return { rows: state.claimed.map(id => ({ bitrix_lead_id: id })) };
    return { rows: [] };
  },
});
mock('../src/services/bitrix', {
  bitrixPost: async (method, params) => {
    state.calls.push({ method, params });
    if (method === 'crm.duplicate.findbycomm') return { result: { LEAD: state.phoneLeads.map(l => l.ID) } };
    if (method === 'crm.lead.list') return { result: state.phoneLeads };
    if (method === 'crm.lead.add') return state.addResult;
    throw new Error(`unexpected ${method}`);
  },
  fetchOne: async (_m, id) => ({ ID: id }),
});
mock('../src/services/upsertLead', { upsertLead: async () => {} });

const { buildFields, ensureLeadForSubmission, isFormLead } = require('../src/services/facebookLeadCreator');

const base = {
  id: '111', phone: '+998901112233', full_name: 'Ali', platform: 'ig', is_organic: false,
  created_time: new Date(Date.now() - 5 * 60_000), campaign_name: 'Camp', adset_name: 'Set', ad_name: 'Ad', bitrix_lead_id: null,
};
const reset = () => { state.queries = []; state.calls = []; state.phoneLeads = []; state.addResult = { result: 5001 }; state.claimed = []; };

test('Xa Mountain QL: every answer lands in the connector\'s field', () => {
  const { fields, unmapped } = buildFields({
    ...base, form_id: '1757388405517976',
    field_data: {
      'ismingiz?': 'Боти', phone_number: '+998935978755',
      "biznesdagi_ro'lingiz?": 'ish_boshqaruvchiman', 'qaysi_xizmatimizdan_foydalanmoqchisiz?': 'patentlash',
      "siz_bilan_bog'lanishimiz_uchun_telefon_raqamingiz?": '+998935978755',
      "korxonangiz_faoliyat_turini_yozing_(_qurilish,_ta'lim__..._)": 'Savdo',
    },
  }, 'Xa Mountain 14.10 QL');
  assert.equal(fields.TITLE, 'Xa Mountain 14.10 QL');
  assert.equal(fields.SOURCE_ID, 'UC_89FPH6');
  assert.equal(fields.STATUS_ID, 'IN_PROCESS');
  assert.equal(fields.UF_CRM_1778491100516, 'ish_boshqaruvchiman');
  assert.equal(fields.UF_CRM_1775826286306, 'patentlash');
  assert.equal(fields.UF_CRM_1778261403182, '+998935978755');
  assert.equal(fields.UF_CRM_1775824743431, 'Savdo');
  assert.equal(fields.UTM_SOURCE, 'Instagram');
  assert.equal(fields.UTM_MEDIUM, 'paid');
  assert.deepEqual(unmapped, []);
  assert.equal(fields.COMMENTS, undefined);
});

test('DU Proten: own field set, hidden utm_source value ignored', () => {
  const { fields, unmapped } = buildFields({
    ...base, form_id: '1626642831644108',
    field_data: {
      'ismingiz:': 'Akmal', city: 'Soflik', 'lavozimingiz:': 'Rahbar', 'brendingiz_nomi:': 'Soflik gilam',
      'telefon_raqamingiz:': '906813636', 'qaysi_xizmatimizdan_foydalanmoqchisiz?': 'brendni_patentga_tekshirish',
      utm_source: 'Leadmasterinstantform1', phone_number: '+998906813636',
    },
  }, 'DU - Proten - 16.10.25');
  assert.equal(fields.NAME, 'Akmal');
  assert.equal(fields.UF_CRM_1778491392559, 'Soflik');
  assert.equal(fields.UF_CRM_1791012628, 'Rahbar');
  assert.equal(fields.UF_CRM_1775824743431, 'Soflik gilam');
  assert.equal(fields.UF_CRM_1777533090, '906813636');
  assert.equal(fields.UF_CRM_1778491100516, 'brendni_patentga_tekshirish');
  assert.deepEqual(unmapped, []);
});

test('a phone without the country code gets +998; other numbers are kept as given', () => {
  assert.equal(buildFields({ ...base, form_id: '1601875095315664', phone: '953733371', field_data: {} }, 'Forma 2').fields.PHONE[0].VALUE, '+998953733371');
  assert.equal(buildFields({ ...base, form_id: '1601875095315664', phone: '+79529197171', field_data: {} }, 'Forma 2').fields.PHONE[0].VALUE, '+79529197171');
});

test('answers with no configured field are kept in COMMENTS, never dropped', () => {
  const { fields, unmapped } = buildFields({
    ...base, form_id: '999', field_data: { 'ismingiz?': 'Ali', 'yangi_savol?': 'Ha', email: 'a@b.c', phone_number: '+998901112233' },
  }, 'Some new form');
  assert.equal(fields.TITLE, 'Some new form');
  assert.equal(fields.COMMENTS, 'ismingiz?: Ali\nyangi_savol?: Ha');
  assert.equal(unmapped.length, 2);
});

test('the form\'s own lead already in Bitrix: linked, nothing created', async () => {
  reset();
  state.phoneLeads = [{ ID: '44436', TITLE: 'Заполнение CRM-формы "Xa Mountain 14.10 QL"', DATE_CREATE: new Date().toISOString() }];
  const r = await ensureLeadForSubmission({ ...base, form_id: '1757388405517976', field_data: {} });
  assert.equal(r.status, 'linked');
  assert.equal(r.leadId, '44436');
  assert.ok(!state.calls.some(c => c.method === 'crm.lead.add'));
  assert.ok(state.queries.some(q => /UPDATE facebook_leads SET bitrix_lead_id/.test(q.sql) && q.params[0] === '44436'));
});

test('no lead yet: created, linked, and the mirror takes the submission time', async () => {
  reset();
  const r = await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', field_data: { 'ismingiz?': 'Ali', 'brendingiz_nomi?': 'Axad' } });
  assert.equal(r.status, 'created');
  assert.equal(r.leadId, 5001);
  const add = state.calls.find(c => c.method === 'crm.lead.add');
  assert.equal(add.params.fields.TITLE, 'Forma 2');
  assert.equal(add.params.fields.ASSIGNED_BY_ID, parseInt(process.env.MAIN_RESPONSIBLE_ID || '1', 10));
  assert.ok(state.queries.some(q => /UPDATE facebook_leads SET bitrix_lead_id/.test(q.sql) && q.params[0] === 5001));
  const redate = state.queries.find(q => /UPDATE leads SET date_create/.test(q.sql));
  assert.deepEqual(redate.params, [5001, base.created_time]);
});

test('a lead opened by a call (no form title) does not stop the form lead', async () => {
  reset();
  state.phoneLeads = [{ ID: '44450', TITLE: '+998 50 876 30 00 - Исходящий звонок', DATE_CREATE: new Date().toISOString() }];
  const r = await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', field_data: {} });
  assert.equal(r.status, 'created');
  assert.match(r.reason, /#44450/);
});

test('an old lead on the same phone (before the submission) does not count', async () => {
  reset();
  state.phoneLeads = [{ ID: '1', TITLE: 'Forma 2', DATE_CREATE: new Date(Date.now() - 3 * 86400_000).toISOString() }];
  const r = await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', field_data: {} });
  assert.equal(r.status, 'created');
});

test('already linked, or no usable phone: skipped without calling Bitrix', async () => {
  reset();
  assert.equal((await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', bitrix_lead_id: 7, field_data: {} })).status, 'skipped');
  assert.equal((await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', phone: '7', field_data: {} })).status, 'skipped');
  assert.equal(state.calls.length, 0);
});

test('Bitrix refuses to add: reported as failed and not linked', async () => {
  reset();
  state.addResult = { error: 'X', error_description: 'denied' };
  const r = await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', field_data: {} });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'denied');
  assert.ok(!state.queries.some(q => /UPDATE facebook_leads SET bitrix_lead_id/.test(q.sql)));
});

test('a lead already linked to another submission of the same person is not reused', async () => {
  reset();
  state.phoneLeads = [{ ID: '44558', TITLE: 'Заполнение CRM-формы "Forma 2"', DATE_CREATE: new Date().toISOString() }];
  state.claimed = [44558];
  const r = await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', field_data: {} });
  assert.equal(r.status, 'created');
  // …while a second, unclaimed lead of the form is picked up
  reset();
  state.phoneLeads = [
    { ID: '44558', TITLE: 'Заполнение CRM-формы "Forma 2"', DATE_CREATE: new Date(Date.now() - 60_000).toISOString() },
    { ID: '44560', TITLE: 'Заполнение CRM-формы "Forma 2"', DATE_CREATE: new Date().toISOString() },
  ];
  state.claimed = [44558];
  const r2 = await ensureLeadForSubmission({ ...base, form_id: '1601875095315664', field_data: {} });
  assert.equal(r2.status, 'linked');
  assert.equal(r2.leadId, '44560');
});

const at = (ms) => new Date(base.created_time.getTime() + ms).toISOString();

test('the connector\'s lead is recognised whatever its CRM form is called (made seconds after the submission)', async () => {
  reset();
  // Meta form "Xa Mountain 14.10 HL", Bitrix CRM form "Xa Mountain 14.10"
  state.phoneLeads = [{ ID: '45274', TITLE: 'Заполнение CRM-формы "Xa Mountain 14.10"', DATE_CREATE: at(6_000) }];
  const r = await ensureLeadForSubmission({ ...base, form_id: '2542155936289286', field_data: {} });
  assert.equal(r.status, 'linked');
  assert.equal(r.leadId, '45274');
  assert.ok(!state.calls.some(c => c.method === 'crm.lead.add'));
});

test('a name that differs only in punctuation and case is the same form, even long after the submission', () => {
  const submitted = base.created_time.getTime();
  const lead = { TITLE: 'Заполнение CRM-формы "XA Mountain 07.10"', DATE_CREATE: at(3 * 3600_000) };
  assert.equal(isFormLead(lead, 'XA - Mountain 07.10', submitted), true);
});

test('a connector lead of another name outside the few minutes after the submission is not its lead', async () => {
  const submitted = base.created_time.getTime();
  const other = t => ({ TITLE: 'Заполнение CRM-формы "Forma 2"', DATE_CREATE: at(t) });
  assert.equal(isFormLead(other(30_000), 'Xa Mountain 14.10 QL', submitted), true);        // right after: the connector's
  assert.equal(isFormLead(other(-30_000), 'Xa Mountain 14.10 QL', submitted), true);       // clocks may differ a little
  assert.equal(isFormLead(other(-4 * 60_000), 'Xa Mountain 14.10 QL', submitted), false);  // an earlier submission's lead
  assert.equal(isFormLead(other(10 * 60_000), 'Xa Mountain 14.10 QL', submitted), false);  // too late to be this one
  // and a lead that is not the connector's (a call, a manual lead) is never taken for it
  assert.equal(isFormLead({ TITLE: '+998 50 876 30 00 - Исходящий звонок', DATE_CREATE: at(30_000) }, 'Xa Mountain 14.10 QL', submitted), false);
});

test('a lead of another name outside the window does not stop the form lead from being created', async () => {
  reset();
  state.phoneLeads = [{ ID: '45302', TITLE: 'Заполнение CRM-формы "Forma 2"', DATE_CREATE: at(-4 * 60_000) }];
  const r = await ensureLeadForSubmission({ ...base, form_id: '1757388405517976', field_data: {} });
  assert.equal(r.status, 'created');
});
