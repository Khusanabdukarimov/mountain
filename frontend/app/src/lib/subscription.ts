import { API_URL_PAYROLL } from "./api/client";

export type SubscriptionStatus = {
  enabled: boolean;      // false = no limit configured: nothing locked, no countdown
  expired: boolean;
  brand: string;
  server_time: string;   // the server's clock — the countdown is measured against it, not the browser's
  expires_at?: string;
  seconds_left?: number;
  support?: string;      // e.g. "@Jahongir_data365"
  support_url?: string;  // https://t.me/Jahongir_data365
};

/** Public endpoint (open even when expired); plain fetch so a lock never triggers the API client's 401/402 handling. */
export async function fetchSubscription(): Promise<SubscriptionStatus> {
  const base = API_URL_PAYROLL || window.location.origin;
  const res = await window.fetch(new URL("/api/subscription", base).toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`subscription status ${res.status}`);
  return res.json() as Promise<SubscriptionStatus>;
}
