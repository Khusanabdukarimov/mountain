import { apiGet, authedFetch, API_URL_CRM } from './client';

export type MetaInsightsRow = {
  budget: number[];
  leads: number[];
  clicks: number[];
  impressions: number[];
};

export type MetaInsightsResponse = {
  month: string;
  year: number;
  data: {
    target: MetaInsightsRow;
    instagram: MetaInsightsRow;
  };
};

export type BitrixDailyRow = {
  sales_sum: number[];
  sales_count: number[];
  qual_leads: number[];
  deals: number[];
};

export type BitrixDailyResponse = {
  month: string;
  year: number;
  data: {
    target: BitrixDailyRow;
    instagram: BitrixDailyRow;
  };
};

export type KunlikRow = {
  leads: number[];
  qual_leads: number[];
  meetings: number[];
  deals: number[];
  deals_sum: number[];
  sales_count: number[];
  sales_sum: number[];
  cancelled: number[];
};

export type UnmatchedRow = {
  sales_count: number[];
  sales_sum: number[];
};

export type KunlikResponse = {
  month: string;
  year: number;
  data: {
    target: KunlikRow;
    instagram: KunlikRow;
    unmatched: UnmatchedRow;
  };
};

export type DashboardDailyResponse = {
  date: string;
  facebook: { date?: string; spend?: number | string; leads_count?: number; error?: string };
  bitrix: {
    visits_count: number;
    leads_count: number;
    closed_deals: { sum: number; count: number };
  };
};

export const MONTH_KEYS = [
  'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
] as const;
export type MonthKey = typeof MONTH_KEYS[number];

export const MONTH_LABELS: Record<MonthKey, string> = {
  yanvar: 'Yanvar', fevral: 'Fevral', mart: 'Mart', aprel: 'Aprel',
  may: 'May', iyun: 'Iyun', iyul: 'Iyul', avgust: 'Avgust',
  sentabr: 'Sentabr', oktabr: 'Oktabr', noyabr: 'Noyabr', dekabr: 'Dekabr',
};

export function getMetaInsights(month: MonthKey, year: number, ad_account_id?: string, force = false, from?: string, to?: string, targetologs: string[] = []) {
  void ad_account_id;
  const tParam = targetologs.length > 0 ? targetologs.join(',') : undefined;
  return apiGet<MetaInsightsResponse>('/api/campaigns/insights', {
    month, year,
    ...(force  ? { force: 'true' } : {}),
    ...(from   ? { from }          : {}),
    ...(to     ? { to }            : {}),
    ...(tParam ? { targetolog: tParam } : {}),
  });
}

export function getBitrixDaily(month: MonthKey, year: number) {
  return apiGet<BitrixDailyResponse>('/api/marketing/bitrix-daily', { month, year });
}

export function getKunlikHisobot(month: MonthKey, year: number, targetologs: string[] = [], responsibleIds: number[] = []) {
  const targetolog = targetologs.length > 0 ? targetologs.join(',') : 'all';
  const responsible_id = responsibleIds.length > 0 ? responsibleIds.join(',') : undefined;
  return apiGet<KunlikResponse>('/api/marketing/kunlik', { month, year, targetolog, responsible_id });
}

export type KunlikMeta = {
  month: string; year: number;
  plans:     Record<string, Partial<Record<string, number>>>;
  overrides: Record<string, Partial<Record<string, Record<number, number>>>>;
};

export type KunlikCustomSection = {
  id: number;
  title: string;
  uf_field: string;
  uf_field_deal: string;
  source_names: string[];
  color: string;
};

export type KunlikSegmentResponse = {
  month: string;
  year: number;
  section_id: number;
  data: {
    leads: number[];
    qual_leads: number[];
    meetings: number[];
    deals: number[];
    deals_sum: number[];
    sales_count: number[];
    sales_sum: number[];
    cancelled: number[];
  };
};

export function getKunlikMeta(month: MonthKey, year: number) {
  return apiGet<KunlikMeta>('/api/marketing/kunlik-meta', { month, year });
}

export function getUfFieldOptions(field = 'UF_CRM_1775824803703') {
  return apiGet<{ options: { id: string; label: string }[] }>('/api/campaigns/uf-field-options', { field });
}

export function getKunlikSections() {
  return apiGet<{ sections: KunlikCustomSection[] }>('/api/marketing/kunlik-sections', {});
}

export function createKunlikSection(body: Omit<KunlikCustomSection, 'id'>) {
  return authedFetch('/api/marketing/kunlik-sections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteKunlikSection(id: number) {
  return authedFetch(`/api/marketing/kunlik-sections/${id}`, { method: 'DELETE' });
}

export function getKunlikSegment(section_id: number, month: MonthKey, year: number, responsibleIds: number[] = []) {
  const responsible_id = responsibleIds.length > 0 ? responsibleIds.join(',') : undefined;
  return apiGet<KunlikSegmentResponse>('/api/marketing/kunlik-segment', { section_id, month, year, responsible_id });
}

export type KunlikJamiStats = {
  month: string; year: number;
  total_leads: number; qual_leads: number; cancelled: number;
  total_deals: number; deals_sum: number;
  total_sales: number; sales_sum: number;
  total_paid: number;
};

export function getKunlikJamiStats(month: MonthKey, year: number, responsibleIds: number[] = []) {
  const responsible_id = responsibleIds.length > 0 ? responsibleIds.join(',') : undefined;
  return apiGet<KunlikJamiStats>('/api/marketing/kunlik-jami-stats', { month, year, responsible_id });
}

export function saveKunlikPlan(section: string, metric_key: string, month: MonthKey, year: number, value: number) {
  return authedFetch('/api/marketing/kunlik-plan', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section, metric_key, month, year, value }),
  });
}

export function saveKunlikOverride(section: string, metric_key: string, month: MonthKey, year: number, day: number, value: number | null) {
  return authedFetch('/api/marketing/kunlik-override', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section, metric_key, month, year, day, value }),
  });
}

export type CampaignAdRow = {
  campaign_name: string;
  adset_name: string;
  ad_name: string;
  objective: string;
  platform: 'facebook' | 'instagram';
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  unique_clicks: number;
  link_clicks: number;
  leads: number;
  landing_page_views: number;
  cpm: number;
  cpc: number;
  cpl: number;
  ctr: number;
  hook_rate: number;
  visit_rate: number;
  lid_rate: number;
};

export type CampaignsResponse = {
  month: string;
  year: number;
  rows: CampaignAdRow[];
};

export function getMetaCampaigns(month: MonthKey, year: number, force = false, from?: string, to?: string) {
  return apiGet<CampaignsResponse>('/api/campaigns/rows', {
    month, year,
    ...(force ? { force: 'true' } : {}),
    ...(from ? { from } : {}),
    ...(to   ? { to }   : {}),
  });
}

export function getDashboardDaily(date: string) {
  return apiGet<DashboardDailyResponse>('/api/dashboard/daily', { date_str: date }, API_URL_CRM);
}

export type LeadgenForm = {
  form_id: string;
  form_name: string;
  status: string;
  leads_count: number | null;
  sifatli_lid: number;
  created_time: string;
  adset_id: string;
  adset_name: string;
};

export type CampaignForms = {
  campaign_id: string;
  campaign_name: string;
  objective: string;
  forms: LeadgenForm[];
};

export type CampaignFormsResponse = {
  count: number;
  campaigns: CampaignForms[];
};

export function getCampaignForms(month?: string, year?: number, from?: string, to?: string) {
  const params: Record<string, string | number | undefined> = {};
  if (month) params.month = month;
  if (year)  params.year  = year;
  if (from)  params.from  = from;
  if (to)    params.to    = to;
  return apiGet<CampaignFormsResponse>('/api/campaigns/forms', params);
}

export interface FormLead {
  id: string;
  name: string;
  phone: string;
  email: string;
  created_at: string;
  bitrix_id: number | null;
  stage_name: string | null;
  stage_code: string | null;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  field_data: Record<string, string>;
}

export type PageForm = {
  form_id:      string;
  form_name:    string;
  status:       string;
  leads_count:  number;
  created_time: string;
  page_name:    string;
};

export function getPageForms(month?: string, year?: number, from?: string, to?: string) {
  return apiGet<{ forms: PageForm[] }>('/api/meta/page-forms', {
    ...(month ? { month } : {}),
    ...(year  ? { year: String(year) } : {}),
    ...(from  ? { from }  : {}),
    ...(to    ? { to }    : {}),
  });
}

export function getFormLeads(formId: string, campaignId?: string, from?: string, to?: string, campaignName?: string) {
  return apiGet<{ count: number; leads: FormLead[] }>('/api/campaigns/leads', {
    ...(formId ? { form_id: formId } : {}),
    ...(campaignId ? { campaign_id: campaignId } : {}),
    ...(campaignName ? { campaign_name: campaignName } : {}),
    ...(from ? { from } : {}),
    ...(to   ? { to }   : {}),
  });
}

export type CreativeRow = {
  adset_name:    string;
  campaign_name: string;
  ad_id:         string | null;
  ad_name:       string | null;
  post_url:      string | null;
  spend:         number;
  meta_leads:    number;
  in_bitrix:     number;
  not_in_bitrix: number;
  sifatli:            number;
  sifatsiz:           number;
  bekor_boldi:        number;
  konsultatsiya_otdi: number;
  sotuv_boldi:        number;
  sotuv_sum:          number;
  sifat_rate:    number;
};

export function getCampaignCreatives(month: MonthKey, year: number, from?: string, to?: string, sotuvFrom?: string, sotuvTo?: string) {
  return apiGet<{ creatives: CreativeRow[] }>('/api/campaigns/creatives', {
    month, year,
    ...(from      ? { from }               : {}),
    ...(to        ? { to }                 : {}),
    ...(sotuvFrom ? { sotuv_from: sotuvFrom } : {}),
    ...(sotuvTo   ? { sotuv_to:   sotuvTo }   : {}),
  });
}

export type CreativeLead = {
  fb_id:           string;
  full_name:       string;
  phone:           string;
  created_time:    string;
  platform:        string;
  campaign_name:   string;
  bitrix_id:       number | null;
  stage_name:      string | null;
  stage_code:      string | null;
  is_duplicate:    boolean;
  deal_id:         number | null;
  deal_stage_name: string | null;
};

export type CreativeDeal = {
  id:          number;
  phone:       string;
  responsible: string;
  opportunity: number;
  currency:    string;
  date:        string | null;
  stage:       string;
};

export function getCreativeDeals(adset_name: string, month: MonthKey, year: number, from?: string, to?: string, sotuvFrom?: string, sotuvTo?: string) {
  return apiGet<{ deals: CreativeDeal[] }>(
    '/api/campaigns/creative-deals',
    {
      adset_name, month, year,
      ...(from      ? { from }               : {}),
      ...(to        ? { to }                 : {}),
      ...(sotuvFrom ? { sotuv_from: sotuvFrom } : {}),
      ...(sotuvTo   ? { sotuv_to:   sotuvTo }   : {}),
    },
  );
}

export function getActiveCampaignNames() {
  return apiGet<{ campaigns: string[] }>('/api/campaigns/active-names', {});
}

export type CampaignFormStat = {
  campaign_name: string;
  jami_lid:      number;
  tasdiqlangan:  number;
  bitrixda_bor:  number;
  bitrixda_yoq:  number;
  sifatli:       number;
  sifatsiz:      number;
  bekor_boldi:   number;
  sotuv_boldi:   number;
};

export function getCampaignFormStats(from?: string, to?: string, formIds?: string[]) {
  return apiGet<{ rows: CampaignFormStat[] }>('/api/campaigns/form-stats', {
    ...(from ? { from } : {}),
    ...(to   ? { to }   : {}),
    ...(formIds && formIds.length ? { form_id: formIds.join(',') } : {}),
  });
}

export function getCreativeLeads(adset_name: string, month: MonthKey, year: number, from?: string, to?: string) {
  return apiGet<{ adset_name: string; leads: CreativeLead[] }>(
    '/api/campaigns/creative-leads',
    {
      adset_name, month, year,
      ...(from ? { from } : {}),
      ...(to   ? { to }   : {}),
    },
  );
}


// ── Campaign targetolog management ────────────────────────────────
export type CampaignAssignment = {
  campaign_name: string;
  total_leads:   number;
  total_spend:   number;
  last_date:     string;
  targetolog:    string | null;
  is_override:   boolean;
};

export function getCampaignAssignments() {
  return apiGet<CampaignAssignment[]>('/api/campaigns/campaign-assignments');
}

export async function assignCampaign(campaign_name: string, targetolog: string) {
  const { authedFetch, API_URL_CRM } = await import('./client');
  const res = await authedFetch('/api/campaigns/campaign-assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign_name, targetolog }),
  }, API_URL_CRM);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function unassignCampaign(campaign_name: string) {
  const { authedFetch, API_URL_CRM } = await import('./client');
  const res = await authedFetch('/api/campaigns/campaign-assign', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign_name }),
  }, API_URL_CRM);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
