import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSubscription } from "@/lib/subscription";
import { SUBSCRIPTION_EXPIRED_EVENT } from "@/lib/subscriptionEvents";
import SubscriptionExpiredPage from "@/pages/SubscriptionExpiredPage";

/** Subscription status, polled; the server decides, the browser only displays. */
export function useSubscription() {
  return useQuery({
    queryKey: ["subscription"],
    queryFn: fetchSubscription,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/**
 * Wraps the whole app. Once the server reports the subscription as expired, every
 * route — login included — is replaced by the "Subscription Expired" page. Any API
 * answer `402 subscription_expired` forces an immediate re-check, so the switch
 * happens the moment access ends, not at the next poll. This is only the display
 * half: the API itself refuses every request after expiry.
 */
export function SubscriptionGate({ children }: { children: ReactNode }) {
  const q = useSubscription();
  const { refetch } = q;

  useEffect(() => {
    const recheck = () => { void refetch(); };
    window.addEventListener(SUBSCRIPTION_EXPIRED_EVENT, recheck);
    return () => window.removeEventListener(SUBSCRIPTION_EXPIRED_EVENT, recheck);
  }, [refetch]);

  if (q.data?.expired) return <SubscriptionExpiredPage status={q.data} />;
  return <>{children}</>;
}
