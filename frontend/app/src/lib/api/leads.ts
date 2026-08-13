import { apiGet, authedFetch, API_URL_CRM } from "./client";

export type LeadFilter = {
  start_date?: string;
  end_date?: string;
  assigned_by?: number;
  status_id?: string;
  source_id?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
};

export type DashboardStatsResponse = {
  header: {
    total_leads: number;
    in_process: number;
    failed: number;
    converted: number;
    conversion_pct: number;
    total_opportunity: number;
    avg_opportunity: number;
    frozen_leads: number;
    avg_age_days: number;
    sifatli_lid_count: number;
    konsultatsiya_belgilandi_count: number;
    konsultatsiya_otkazildi_count: number;
    muvaffaqiyatsiz_count: number;
    sifatsiz_bekor_count: number;
    bekor_boldi_count: number;
  };
  funnel: {
    bitrix_id: string;
    name_uz: string;
    sort_order: number;
    lead_count: number;
    total_opportunity: number;
  }[];
};

export type ResponsiblesStatsResponse = {
  responsibles: {
    responsible_id: number;
    full_name: string;
    work_position?: string | null;
    total: number;
    qongiroqlar: number;
    yangi_lid: number;
    propushenniy: number;
    javob_bermadi: number;
    qayta_aloqa: number;
    oylab_koradi: number;
    konsultatsiya: number;
    otkazilmadi: number;
    konsultatsiya_otkazildi: number;
    sandiq: number;
    sifatsiz: number;
    bekor_boldi: number;
    total_opportunity: number;
  }[];
};

export type DashFilter = {
  start_date?: string;
  end_date?: string;
  responsible_ids?: number[];
  stages?: string[];
  sources?: string[];
  form_ids?: string[];
  mode?: 'default' | 'amocrm' | 'bitrix24';
};

export type FilterOptions = {
  responsibles: { id: number; full_name: string }[];
  stages: { bitrix_id: string; name: string }[];
  sources: { id: string; name: string }[];
  forms: { id: string; name: string; count: number }[];
};

export function getDashboardStats(filter: DashFilter) {
  return apiGet<DashboardStatsResponse>("/api/dashboard/lead-stats", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
    stage: filter.stages?.join(','),
    source: filter.sources?.join(','),
    mode: filter.mode,
  }, API_URL_CRM);
}

export function getResponsiblesStats(filter: DashFilter) {
  return apiGet<ResponsiblesStatsResponse>("/api/dashboard/lead-responsibles", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
    stage: filter.stages?.join(','),
    source: filter.sources?.join(','),
    mode: filter.mode,
  }, API_URL_CRM);
}

/** Which field the Lid va Konversiya table groups by. Metrics are identical
 *  across all of them — only the grouping key changes. */
export type ConversionDimension = "manager" | "source" | "campaign" | "stage" | "report_stage";

export type ConversionStatsResponse = {
  conversion: {
    /** Grouping key — a responsible id, source code, campaign name, or stage code. */
    key: string;
    /** Human label for the key. '—' when the lead has no value for this field. */
    name: string;
    /** Set only for the manager dimension; null otherwise. */
    responsible_id: number | null;
    full_name: string;
    total: number;
    jarayonda: number;
    sifatli_lid: number;
    sifatsiz_lid: number;
    bekor_boldi: number;
    tashrif_buyurdi: number;
  }[];
};

export function getConversionStats(filter: DashFilter, dimension: ConversionDimension = "manager") {
  return apiGet<ConversionStatsResponse>("/api/dashboard/lead-conversion", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
    stage: filter.stages?.join(','),
    source: filter.sources?.join(','),
    mode: filter.mode,
    dimension,
  }, API_URL_CRM);
}

export function getFilterOptions(mode?: string) {
  return apiGet<FilterOptions>("/api/dashboard/lead-filter-options", { mode }, API_URL_CRM);
}

export type TasksSummaryResponse = {
  tasks: {
    responsible_id: number;
    full_name: string;
    total: number;
    in_progress: number;
    completed: number;
    overdue: number;
    completed_late: number;
  }[];
};

export function getTasksSummary(filter: Pick<DashFilter, "start_date" | "end_date" | "mode">) {
  return apiGet<TasksSummaryResponse>("/api/dashboard/tasks-summary", {
    from: filter.start_date,
    to: filter.end_date,
    mode: filter.mode,
  }, API_URL_CRM);
}

export type ReasonsResponse = {
  items: { reason: string; total: number }[];
};

export function getCancelReasons(filter: Pick<DashFilter, "start_date" | "end_date" | "responsible_ids" | "mode">) {
  return apiGet<ReasonsResponse>("/api/dashboard/cancel-reasons", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
    mode: filter.mode,
  }, API_URL_CRM);
}

export function getJunkReasons(filter: Pick<DashFilter, "start_date" | "end_date" | "responsible_ids" | "mode">) {
  return apiGet<ReasonsResponse>("/api/dashboard/junk-reasons", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
    mode: filter.mode,
  }, API_URL_CRM);
}

export function getAmocrmSources() {
  return apiGet<string[]>("/api/dashboard/amocrm-sources", {}, API_URL_CRM);
}

export type UtmStatRow = {
  utm_source: string;
  umumiy_lidlar: number;
  jarayonda: number;
  sifatli_lid: number;
  konsultatsiya_belgilandi: number;
  konsultatsiya_otkazildi: number;
  sifatsiz: number;
  bekor_boldi: number;
  campaign_count: number;
};

export function getUtmStats(filter: Pick<DashFilter, "start_date" | "end_date" | "mode" | "form_ids">) {
  return apiGet<UtmStatRow[]>("/api/dashboard/utm-stats", {
    from: filter.start_date,
    to:   filter.end_date,
    mode: filter.mode,
    form_id: filter.form_ids?.join(','),
  }, API_URL_CRM);
}

export type UtmCampaignRow = UtmStatRow & { utm_campaign: string; responsible_count: number };

export function getUtmCampaignStats(
  utmSource: string,
  utmMedium: string,
  filter: Pick<DashFilter, "start_date" | "end_date" | "mode">,
) {
  return apiGet<UtmCampaignRow[]>("/api/dashboard/utm-campaign-stats", {
    utm_source: utmSource,
    utm_medium: utmMedium,
    from: filter.start_date,
    to:   filter.end_date,
    mode: filter.mode,
  }, API_URL_CRM);
}

export type UtmMediumRow = UtmStatRow & { utm_medium: string; campaign_count: number };

export function getUtmMediumStats(
  utmSource: string,
  filter: Pick<DashFilter, "start_date" | "end_date" | "mode">,
) {
  return apiGet<UtmMediumRow[]>("/api/dashboard/utm-medium-stats", {
    utm_source: utmSource,
    from: filter.start_date,
    to:   filter.end_date,
    mode: filter.mode,
  }, API_URL_CRM);
}

export type UtmContentRow = UtmStatRow & { utm_content: string; responsible_count: number };

export function getUtmContentStats(
  path: { source: string; medium: string; campaign: string },
  filter: Pick<DashFilter, "start_date" | "end_date" | "mode">,
) {
  return apiGet<UtmContentRow[]>("/api/dashboard/utm-content-stats", {
    utm_source:   path.source,
    utm_medium:   path.medium,
    utm_campaign: path.campaign,
    from: filter.start_date,
    to:   filter.end_date,
    mode: filter.mode,
  }, API_URL_CRM);
}

export type UtmTermRow = UtmStatRow & { utm_term: string; responsible_count: number };

export function getUtmTermStats(
  path: { source: string; medium: string; campaign: string; content: string },
  filter: Pick<DashFilter, "start_date" | "end_date" | "mode">,
) {
  return apiGet<UtmTermRow[]>("/api/dashboard/utm-term-stats", {
    utm_source:   path.source,
    utm_medium:   path.medium,
    utm_campaign: path.campaign,
    utm_content:  path.content,
    from: filter.start_date,
    to:   filter.end_date,
    mode: filter.mode,
  }, API_URL_CRM);
}

export type UtmResponsibleRow = {
  full_name: string;
  responsible_id: number;
  umumiy_lidlar: number;
  jarayonda: number;
  sifatli_lid: number;
  konsultatsiya_belgilandi: number;
  konsultatsiya_otkazildi: number;
  sifatsiz: number;
  bekor_boldi: number;
};

export function getUtmResponsibleStats(
  path: { source: string; medium?: string; campaign: string; content?: string; term?: string },
  filter: Pick<DashFilter, "start_date" | "end_date" | "mode">,
) {
  return apiGet<UtmResponsibleRow[]>("/api/dashboard/utm-responsible-stats", {
    utm_source:   path.source,
    utm_campaign: path.campaign,
    utm_medium:   path.medium,
    utm_content:  path.content,
    utm_term:     path.term,
    from: filter.start_date,
    to:   filter.end_date,
    mode: filter.mode,
  }, API_URL_CRM);
}

export type FormStatsRow = {
  web_form_id: string;
  form_name: string;
  umumiy_lidlar: number;
  jarayonda: number;
  sifatli_lid: number;
  konsultatsiya_belgilandi: number;
  konsultatsiya_otkazildi: number;
  sifatsiz: number;
  bekor_boldi: number;
};

export function getFormStats(filter: Pick<DashFilter, "start_date" | "end_date" | "responsible_ids" | "mode">) {
  return apiGet<FormStatsRow[]>("/api/dashboard/form-stats", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
    mode: filter.mode,
  }, API_URL_CRM);
}

export type SourceStatsRow = {
  source_id: string;
  source_name: string;
  umumiy_lidlar: number;
  jarayonda: number;
  sifatli_lid: number;
  konsultatsiya_belgilandi: number;
  konsultatsiya_otkazildi: number;
  sifatsiz: number;
  bekor_boldi: number;
};

export function getSourceStats(filter: Pick<DashFilter, "start_date" | "end_date" | "responsible_ids" | "mode">) {
  return apiGet<SourceStatsRow[]>("/api/dashboard/source-stats", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
    mode: filter.mode,
  }, API_URL_CRM);
}

export type CallStatsRow = {
  responsible_id: number;
  full_name: string;
  photo_url: string | null;
  total_calls: number;
  total_duration: number;
  avg_duration: number;
  success_calls: number;
  failed_calls: number;
  outbound_calls: number;
  inbound_calls: number;
  calls_with_lead: number;
  unique_outbound: number;
  unique_inbound: number;
  unique_total: number;
  outbound_duration: number;
  inbound_duration: number;
  missed_inbound: number;
  callback_calls: number;
};

export type CallGlobalStats = {
  ne_perezvonili: number;
  reaksiya_vaqti: number;
};

export type CallReactionRow = {
  responsible_id: number;
  full_name: string;
  photo_url: string | null;
  missed_calls: number;
  bez_otveta: number;
  avg_response_secs: number;
};

export type CallListRow = {
  id: string;
  phone_number: string | null;
  call_type: number | null;
  duration: number;
  call_start: string | null;
  status_code: number | null;
  status_name: string | null;
  lead_id: number | null;
  crm_entity_type: string | null;
  lead_title: string | null;
  stage_name: string | null;
  stage_bitrix_id: string | null;
};

export type CallDashboardFilter = {
  start_date?: string;
  end_date?: string;
  responsible_id?: number;
  phone?: string;
  source?: string;
  call_kind?: string;
  status?: string;
  duration_from?: number;
  duration_to?: number;
  stage?: string;
};

export type CallFilterOptions = {
  responsibles: { id: number; full_name: string }[];
  sources: { id: string; name: string }[];
};

function callFilterParams(filter: CallDashboardFilter) {
  return {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_id,
    phone: filter.phone,
    source: filter.source,
    call_kind: filter.call_kind,
    status: filter.status,
    duration_from: filter.duration_from,
    duration_to: filter.duration_to,
    stage: filter.stage,
  };
}

export function getCallFilterOptions() {
  return apiGet<CallFilterOptions>("/api/dashboard/call-filter-options", {}, API_URL_CRM);
}

export function getCallStats(filter: Pick<DashFilter, "start_date" | "end_date" | "responsible_ids">) {
  return apiGet<CallStatsRow[]>("/api/dashboard/call-stats", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
  }, API_URL_CRM);
}

export function getCallReactionStats(filter: Pick<DashFilter, "start_date" | "end_date">) {
  return apiGet<CallReactionRow[]>("/api/dashboard/call-reaction-stats", {
    from: filter.start_date,
    to:   filter.end_date,
  }, API_URL_CRM);
}

export function getCallGlobalStats(filter: Pick<DashFilter, "start_date" | "end_date">) {
  return apiGet<CallGlobalStats>("/api/dashboard/call-global-stats", {
    from: filter.start_date,
    to:   filter.end_date,
  }, API_URL_CRM);
}

export async function syncUserPhotos(): Promise<{ ok: boolean; total: number; with_photo: number }> {
  const res = await authedFetch("/api/dashboard/sync-user-photos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, API_URL_CRM);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export type CallStageStatsRow = {
  stage_bitrix_id: string;
  stage_name: string;
  jami: number;
  muvaffaqiyatli: number;
};

export function getCallStageStats(filter: CallDashboardFilter) {
  return apiGet<CallStageStatsRow[]>("/api/dashboard/call-stage-stats", {
    ...callFilterParams(filter),
  }, API_URL_CRM);
}

export function getCallList(responsibleId: number, filter: CallDashboardFilter) {
  return apiGet<CallListRow[]>("/api/dashboard/call-list", {
    ...callFilterParams(filter),
    responsible_id: responsibleId,
  }, API_URL_CRM);
}

export async function syncCalls(from?: string, to?: string): Promise<{ ok: boolean; synced: number }> {
  const res = await authedFetch("/api/dashboard/sync-calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  }, API_URL_CRM);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export type ResponsibleLeadRow = {
  id: number;
  title: string;
  stage_bid: string;
  date_create: string;
  opportunity: number;
  tashrif_sanasi: string | null;
  ne_obrabotinniy: number;
  yangi_lid: number;
  propushenniy: number;
  javob_bermadi: number;
  qayta_aloqa: number;
  oylab_koradi: number;
  tashrif_belgilandi: number;
  kelmadi: number;
  sandiq: number;
  sifatsiz: number;
  bekor_boldi: number;
  tashrif_buyurdi: number;
};

/** Drill-down for one row of the conversion table. Passes the same dimension +
 *  key the row was grouped on, so the sub-table can't disagree with the totals. */
export function getResponsibleLeads(
  key: string | number,
  filter: Pick<DashFilter, "start_date" | "end_date" | "mode">,
  dimension: ConversionDimension = "manager",
) {
  return apiGet<ResponsibleLeadRow[]>("/api/dashboard/responsible-leads", {
    key: String(key),
    dimension,
    from: filter.start_date,
    to: filter.end_date,
    mode: filter.mode,
  }, API_URL_CRM);
}

export function getDealCancelReasons(filter: Pick<DashFilter, "start_date" | "end_date" | "responsible_ids">) {
  return apiGet<ReasonsResponse>("/api/dashboard/deal-cancel-reasons", {
    from: filter.start_date,
    to: filter.end_date,
    responsible_id: filter.responsible_ids?.join(','),
  }, API_URL_CRM);
}

// ── Lead list (raw + enriched) ───────────────────────────────────
export type LeadRow = {
  ID: string;
  TITLE: string | null;
  NAME: string | null;
  LAST_NAME: string | null;
  ASSIGNED_BY_ID: string | null;
  OPPORTUNITY: string | null;
  STATUS_ID: string | null;
  SOURCE_ID: string | null;
  DATE_CREATE: string | null;
  DATE_MODIFY: string | null;
  PHONE: string | null;
  EMAIL: string | null;
  COMMENTS: string | null;
  _status_name?: string;
  _source_name?: string;
  _assigned_name?: string;
};

export type LeadsListFilter = {
  start_date?: string;
  end_date?: string;
  assigned_by?: number;
  status_id?: string;
  source_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
  enrich?: boolean;
};

export function listLeadsRich(filter: LeadsListFilter) {
  return apiGet<{
    count: number;
    leads: LeadRow[];
    offset: number;
    limit: number | null;
  }>("/api/leads", {
    ...filter,
    enrich: filter.enrich ? "true" : undefined,
  } as Record<string, string | number | undefined>, API_URL_CRM);
}

// ── Create lead ──────────────────────────────────────────────────
export type LeadCreateIn = {
  client: string;
  date?: string;
  employee_id?: number;
  source?: string;
  amount?: number;
  status?: string;
  deal_id?: string;
  notes?: string;
};

export async function createLead(
  body: LeadCreateIn,
): Promise<{ result: number }> {
  const res = await authedFetch("/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, API_URL_CRM);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── DB-backed call-stats endpoint (/api/dashboard/call-stats-full) ───────────
export type PyResponsibleCallStats = {
  responsible_id:    number | null;
  full_name:         string;
  photo_url:         string | null;
  total_calls:       number;
  inbound_calls:     number;
  outbound_calls:    number;
  callback_calls:    number;
  success_calls:     number;
  failed_calls:      number;
  ndz_calls:         number;
  missed_inbound:    number;
  missed_recalled:   number;
  missed_unrecalled: number;
  total_duration:    number;
  avg_duration:      number;
  inbound_duration:  number;
  outbound_duration: number;
  unique_inbound:    number;
  unique_outbound:   number;
  unique_total:      number;
};

export type PyCallStatsResult = {
  date_from:      string;
  date_to:        string;
  total_calls:    number;
  inbound_calls:  number;
  outbound_calls: number;
  callback_calls: number;
  success_calls:  number;
  failed_calls:   number;
  ndz_calls:      number;
  missed_inbound: number;
  total_duration: number;
  avg_duration:   number;
  success_pct:    number;
  failed_pct:     number;
  ne_perezvonili: number;
  reaksiya_vaqti: number;
  responsibles:   PyResponsibleCallStats[];
};

export function getPyCallStats(filter: CallDashboardFilter) {
  return apiGet<PyCallStatsResult>("/api/dashboard/call-stats-full", {
    ...callFilterParams(filter),
  }, API_URL_CRM);
}
