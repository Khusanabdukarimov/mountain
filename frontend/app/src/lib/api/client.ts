import { getStoredToken, clearStoredToken } from '@/lib/auth';
import { reportSubscriptionExpired } from '@/lib/subscriptionEvents';

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function authHeaders(): Record<string, string> {
  const t = getStoredToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function handle401() {
  clearStoredToken();
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
}

export const API_URL_CRM = import.meta.env.VITE_API_URL_CRM || "";
export const API_URL_PAYROLL = import.meta.env.VITE_API_URL_PAYROLL || "";

export async function apiGet<T>(
  path: string, 
  params?: Record<string, string | number | undefined | null>,
  baseUrl: string = API_URL_PAYROLL
): Promise<T> {
  // If baseUrl is empty, it relies on Vite proxy or same-domain
  const base = baseUrl || window.location.origin;
  const url = new URL(path, base);
  
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  
  const res = await window.fetch(url.toString(), { headers: authHeaders() });
  if (res.status === 401) handle401();
  if (!res.ok) {
    let payload: unknown = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    reportSubscriptionExpired(res.status, payload);
    throw new ApiError(`${res.status} ${res.statusText}`, res.status, payload);
  }
  return res.json() as Promise<T>;
}

/** Wrapper around fetch that adds auth header and handles 401. */
export async function authedFetch(
  input: RequestInfo, 
  init: RequestInit = {},
  baseUrl: string = API_URL_PAYROLL
): Promise<Response> {
  let finalInput = input;
  if (typeof input === "string" && !input.startsWith("http") && baseUrl) {
    finalInput = baseUrl + input;
  }

  const headers = { ...(init.headers as Record<string, string> | undefined ?? {}), ...authHeaders() };
  const res = await window.fetch(finalInput, { ...init, headers });
  if (res.status === 401) handle401();
  if (res.status === 402) res.clone().json().then(p => reportSubscriptionExpired(402, p)).catch(() => { /* not JSON */ });
  return res;
}
