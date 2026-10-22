import { apiGet, authedFetch, API_URL_CRM } from './client';

// ── Types ─────────────────────────────────────────────────────────

export type PeriodType = 'monthly' | 'quarterly';

export type RejaPlan = {
  id: number;
  name: string | null;
  period_type: PeriodType;
  period_start: string;
  period_end: string;
  /** Date the weekly columns are counted from (monthly plans); null = the plan's own start. */
  week_start: string | null;
  total_target: number;
  employee_count: number;
  distributed_total: number;
  created_at: string;
};

export type RejaEmployee = {
  responsible_id: number;
  full_name: string;
  work_position: string | null;
  active: boolean;
  photo_url: string | null;
  target: number;
  actual_sales: number;
  deal_count: number;
};

export type RejaDistributionResponse = {
  plan: RejaPlan;
  employees: RejaEmployee[];
};

export type RejaSubperiod = {
  index: number;
  start: string;
  end: string;
  label: string;
  target: number;
  actual: number;
  isPast: boolean;
  isCurrent: boolean;
  pct: number;
};

export type RejaProgressEmployee = {
  responsible_id: number;
  full_name: string;
  work_position: string | null;
  photo_url: string | null;
  target: number;
  total_actual: number;
  pct: number;
  subperiods: RejaSubperiod[];
};

export type RejaProgressResponse = {
  plan: RejaPlan;
  subperiods: { index: number; label: string; start: string; end: string }[];
  employees: RejaProgressEmployee[];
  summary: { total_target: number; total_actual: number; pct: number; prev_actual: number; growth_pct: number | null };
};

// ── API calls ─────────────────────────────────────────────────────

export function getRejaPlans() {
  return apiGet<RejaPlan[]>('/api/reja/plans', {}, API_URL_CRM);
}

export async function createRejaPlan(body: {
  name?: string;
  period_type: PeriodType;
  period_start: string;
  period_end: string;
  total_target: number;
}): Promise<RejaPlan> {
  const res = await authedFetch('/api/reja/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, API_URL_CRM);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function updateRejaPlan(
  id: number,
  body: { name?: string; total_target?: number; period_start?: string; period_end?: string; week_start?: string | null },
): Promise<RejaPlan> {
  const res = await authedFetch(`/api/reja/plans/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, API_URL_CRM);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function deleteRejaPlan(id: number): Promise<void> {
  const res = await authedFetch(`/api/reja/plans/${id}`, { method: 'DELETE' }, API_URL_CRM);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export function getRejaDistribution(planId: number) {
  return apiGet<RejaDistributionResponse>(`/api/reja/plans/${planId}/distribution`, {}, API_URL_CRM);
}

export async function saveRejaDistribution(
  planId: number,
  targets: { responsible_id: number; target: number }[],
): Promise<void> {
  const res = await authedFetch(`/api/reja/plans/${planId}/distribution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets }),
  }, API_URL_CRM);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export function getRejaProgress(planId: number) {
  return apiGet<RejaProgressResponse>(`/api/reja/plans/${planId}/progress`, {}, API_URL_CRM);
}

export function listAllResponsibles() {
  return apiGet<{ id: number; full_name: string }[]>('/api/dashboard/responsibles-list', {}, API_URL_CRM);
}
