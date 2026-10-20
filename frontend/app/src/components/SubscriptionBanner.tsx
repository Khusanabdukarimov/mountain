import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSubscription } from "./SubscriptionGate";

function format(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const hms = [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
  return d > 0 ? `${d} kun ${hms}` : hms;
}

/** Countdown to the end of the subscription, shown on every page while a limit is set. */
export function SubscriptionBanner() {
  const { data, dataUpdatedAt, refetch } = useSubscription();
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Measured on the server's clock (server_time at fetch + time elapsed since), so
  // setting the computer's date back does not stretch the countdown.
  const left = data?.enabled && data.expires_at
    ? Math.max(0, Math.floor((Date.parse(data.expires_at) - (Date.parse(data.server_time) + (Date.now() - dataUpdatedAt))) / 1000))
    : null;
  const reachedZero = left === 0;

  useEffect(() => { if (reachedZero) void refetch(); }, [reachedZero, refetch]);

  if (left === null || data?.expired) return null;

  const tone = left <= 86400 ? "red" : left <= 7 * 86400 ? "amber" : "neutral";
  return (
    <div
      className={cn(
        "shrink-0 flex items-center justify-center gap-2 px-3 py-1.5 text-[12px] border-b pl-12 md:pl-3",
        tone === "red" && "bg-red-bg text-red border-red-bd",
        tone === "amber" && "bg-amber-bg text-amber border-amber-bd",
        tone === "neutral" && "bg-bg3 text-text2 border-border",
      )}
      role="status"
    >
      <Hourglass className="w-3.5 h-3.5 shrink-0" />
      <span>Obuna tugashiga:</span>
      <span className="mono font-semibold tabular-nums">{format(left)}</span>
    </div>
  );
}
