// Kept free of imports so the API client can use it without a cycle.
export const SUBSCRIPTION_EXPIRED_EVENT = "subscription:expired";

/** Any API answer `402 subscription_expired` tells the app to re-check its status at once. */
export function reportSubscriptionExpired(status: number, payload: unknown): void {
  if (status === 402 && (payload as { code?: string } | null)?.code === "subscription_expired") {
    window.dispatchEvent(new Event(SUBSCRIPTION_EXPIRED_EVENT));
  }
}
