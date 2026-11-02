import { useEffect } from "react";
import { ArrowRight, Clock, Crown, Database, Lock, MessageCircle, ShieldCheck } from "lucide-react";
import type { SubscriptionStatus } from "@/lib/subscription";

const SUPPORT_FALLBACK = "@Jahongir_data365";

const FEATURES = [
  { icon: Database, tint: "#34d399", title: "Your data is safe", text: "All your data is securely stored" },
  { icon: Clock, tint: "#60a5fa", title: "Instant reactivation", text: "Access is restored immediately after payment" },
  { icon: Crown, tint: "#a78bfa", title: "Continue using", text: "Get back to your analytics and insights" },
];

/** Shown instead of the whole app once the subscription has expired. Always dark, independent of the app theme. */
export default function SubscriptionExpiredPage({ status }: { status: SubscriptionStatus }) {
  const support = status.support || SUPPORT_FALLBACK;
  const supportUrl = status.support_url || `https://t.me/${support.replace(/^@/, "")}`;

  useEffect(() => { document.title = "Mountain Dashboard — Subscription Expired"; }, []);

  return (
    <div
      className="min-h-screen text-white flex flex-col"
      style={{ background: "radial-gradient(900px 520px at 50% 22%, rgba(88,64,190,.32), transparent 62%), #070a1c" }}
    >
      <header className="flex items-center justify-between px-5 sm:px-8 py-5">
        <div className="flex items-center gap-3">
          {/* The wordmark sits in the middle band of a square image: a wide tile crops the empty margin so it stays legible. */}
          <div className="w-[104px] h-11 rounded-lg bg-white overflow-hidden shrink-0">
            <img src="/mountain-logo.png" alt="Mountain" className="w-full h-full object-cover" />
          </div>
          <span className="text-[18px] sm:text-[20px] font-semibold tracking-tight">Mountain Dashboard</span>
        </div>
        <div className="hidden sm:flex items-center gap-2 text-[13px] text-white/55">
          <Lock size={14} /> Secure &amp; Encrypted
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-5 pt-4 sm:pt-8 pb-10 text-center">
        <svg width="340" height="112" viewBox="0 0 340 112" fill="none" aria-hidden="true" className="mb-6 max-w-full">
          <rect x="1" y="1" width="268" height="92" rx="10" fill="rgba(255,255,255,.03)" stroke="rgba(130,140,220,.35)" />
          <rect x="18" y="20" width="50" height="4" rx="2" fill="rgba(160,170,255,.45)" />
          <rect x="18" y="32" width="50" height="4" rx="2" fill="rgba(160,170,255,.45)" />
          <rect x="18" y="44" width="50" height="4" rx="2" fill="rgba(160,170,255,.45)" />
          <polyline points="112,52 140,42 160,48 190,34 214,40 244,22" stroke="#5b7cff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {[0, 1, 2, 3].map(i => (
            <rect key={i} x={30 + i * 14} y={80 - [8, 14, 6, 18][i]} width="8" height={[8, 14, 6, 18][i]} rx="1.5" fill="rgba(110,125,230,.55)" />
          ))}
          <circle cx="268" cy="84" r="27" fill="#0b1026" stroke="rgba(255,64,110,.7)" />
          <circle cx="268" cy="84" r="20" fill="rgba(255,64,110,.1)" stroke="rgba(255,64,110,.35)" />
          <g transform="translate(257 72)" stroke="#ff4070" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <rect x="2" y="9" width="18" height="13" rx="2.5" />
            <path d="M6 9V6.5a5 5 0 0 1 10 0V9" />
          </g>
        </svg>

        <h1 className="text-[34px] sm:text-[44px] leading-tight font-bold tracking-tight">
          Subscription <span style={{ color: "#ff3d6b" }}>Expired</span>
        </h1>
        <p className="mt-4 max-w-[560px] text-[16px] text-white/75">
          Your access to the dashboard has been suspended due to an overdue payment.
        </p>
        <p className="mt-3 max-w-[520px] text-[14px] text-white/45">
          Once the payment is completed, your access will be automatically restored and all your data will remain safe.
        </p>

        <div className="mt-9 w-full max-w-[780px] grid grid-cols-1 md:grid-cols-3 rounded-2xl border border-white/10 bg-white/[0.03] md:divide-x divide-y md:divide-y-0 divide-white/10">
          {FEATURES.map(({ icon: Icon, tint, title, text }) => (
            <div key={title} className="px-5 py-6 flex flex-col items-center gap-2">
              <div className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: `${tint}1f` }}>
                <Icon size={20} style={{ color: tint }} />
              </div>
              <div className="text-[15px] font-semibold">{title}</div>
              <div className="text-[12.5px] text-white/45 max-w-[190px]">{text}</div>
            </div>
          ))}
        </div>

        <a
          href={supportUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-9 inline-flex items-center gap-2.5 rounded-xl px-8 py-3.5 text-[15px] font-semibold text-white shadow-[0_10px_30px_rgba(88,80,236,.45)] hover:brightness-110 transition"
          style={{ background: "linear-gradient(135deg, #5b5bf0, #6d63ff)" }}
        >
          <MessageCircle size={18} /> Contact Support <ArrowRight size={16} />
        </a>
        <div className="mt-3 text-[13px] text-white/55">
          Telegram: <a href={supportUrl} target="_blank" rel="noopener noreferrer" className="text-[#9aa7ff] hover:underline">{support}</a>
        </div>

        <div className="mt-8 flex items-center gap-2 text-[12.5px] text-white/35">
          <ShieldCheck size={14} /> Your subscription is required to keep using the dashboard.
        </div>
      </main>
    </div>
  );
}
