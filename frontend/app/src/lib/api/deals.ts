import { apiGet, API_URL_CRM } from './client';

export type DealsFilter = {
  start_date?: string;
  end_date?: string;
  assigned_by?: number;
  stage_id?: string;
  source_id?: string;
};

export type StatsDealsByUser = {
  id: string;
  name: string;
  total: number;
  won_revenue: number;
  by_stage: Record<string, number>;
};

export type StatsDealsResponse = {
  total: number;
  won_count: number;
  lost_count: number;
  total_won_revenue: number;
  conversion_rate: number;
  by_stage: Record<string, number>;
  by_user: StatsDealsByUser[];
  all_stages: string[];
  stage_names: Record<string, string>;
  users: { id: string; name: string }[];
};

export type DealsBySource = {
  id: string;
  label: string;
  ishlaydi: number;
  provodka: number;
  success: number;
  revenue: number;
  total: number;
  conversion: number;
};

export type DealsBySourceResponse = {
  sources: DealsBySource[];
  source_names: Record<string, string>;
};

export function getDealsStats(filter: DealsFilter) {
  return apiGet<StatsDealsResponse>('/api/stats/deals', filter);
}

export function getDealsBySource(filter: DealsFilter) {
  return apiGet<DealsBySourceResponse>('/api/stats/deals/by-source', filter);
}

// ── New endpoints (bitrix-sync) ──────────────────────────────────

export type DealKpiStats = {
  total: number;
  yangi: number;
  sotuv_boldi: number;
  bekor: number;
  jami_sotuv: number;
  tolangan: number;
  ortacha_chek: number;
  konversiya: number;
};

export type DealFilterOptions = {
  responsibles: { id: number; full_name: string }[];
  stages: { id: number; name: string }[];
  sources: { id: string; name: string }[];
};

export type DealRow = {
  id: number;
  responsible: string;
  mijoz: string;
  summa: number;
  manba: string;
  sana: string;
  stage_name: string;
  is_won: boolean;
  is_final: boolean;
};

export type DealsListResponse = {
  total: number;
  page: number;
  limit: number;
  items: DealRow[];
};

export type DealsListFilter = {
  from?: string;
  to?: string;
  search?: string;
  status?: 'won' | 'lost' | 'active' | '';
  responsible_id?: string;
  stage_id?: string;
  source?: string;
  page?: number;
  limit?: number;
  mode?: string;
};

export function getDealKpiStats(filter: {
  from?: string; to?: string;
  responsible_id?: string; stage_id?: string; source?: string;
  mode?: string;
}) {
  return apiGet<DealKpiStats>('/api/dashboard/deals-stats', filter as Record<string, string | number | undefined>, API_URL_CRM);
}

export function getDealsList(filter: DealsListFilter) {
  return apiGet<DealsListResponse>('/api/dashboard/deals-list', filter as Record<string, string | number | undefined>, API_URL_CRM);
}

export function getDealFilterOptions(filter?: { mode?: string }) {
  return apiGet<DealFilterOptions>('/api/dashboard/deal-filter-options', filter || {}, API_URL_CRM);
}

export type DealsConversionRow = {
  responsible_id: number;
  full_name: string;
  work_position?: string | null;
  total: number;
  jarayonda: number;
  sotuv_boldi: number;
  bekor_boldi: number;
  jami_sotuv: number;
};

export type DealsResponsiblesRow = {
  responsible_id: number;
  full_name: string;
  work_position?: string | null;
  total: number;
  konsultatsiya: number;
  kelishuv: number;
  ish_boshlandi: number;
  sotuv_boldi: number;
  bekor_boldi: number;
};

export function getDealsConversion(filter: { from?: string; to?: string; mode?: string; responsible_id?: string; stage_id?: string; source?: string }) {
  return apiGet<DealsConversionRow[]>('/api/dashboard/deals-conversion', filter as Record<string, string | undefined>, API_URL_CRM);
}

export function getDealsResponsibles(filter: { from?: string; to?: string; mode?: string; responsible_id?: string; stage_id?: string; source?: string }) {
  return apiGet<DealsResponsiblesRow[]>('/api/dashboard/deals-responsibles', filter as Record<string, string | undefined>, API_URL_CRM);
}

export type DealSourceStatsRow = {
  source_id: string;
  source_name: string;
  umumiy: number;
  jarayonda: number;
  bekor_boldi: number;
  sotuv_boldi: number;
};

export function getDealSourceStats(filter: { from?: string; to?: string; mode?: string; responsible_id?: string; stage_id?: string; source?: string }) {
  return apiGet<DealSourceStatsRow[]>('/api/dashboard/deals-source-stats', filter as Record<string, string | undefined>, API_URL_CRM);
}
