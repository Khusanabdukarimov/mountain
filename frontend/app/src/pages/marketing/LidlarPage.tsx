import { useMemo, useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDarkMode } from "@/hooks/useDarkMode";
import {
  Calendar, Users, Star, TrendingUp, Filter,
  ArrowLeftRight, XCircle, ChevronDown, Search,
} from "lucide-react";
import { Topbar } from "@/components/Topbar";
import {
  getDashboardStats, getResponsiblesStats, getConversionStats,
  getFilterOptions, getTasksSummary, getCancelReasons, getJunkReasons,
  getAmocrmSources,
  getSourceStats, getUtmStats, getUtmCampaignStats, getUtmMediumStats, getUtmContentStats, getUtmTermStats, getUtmResponsibleStats, getResponsibleLeads,
  type DashFilter,
  type SourceStatsRow, type ResponsibleLeadRow, type ConversionDimension,
} from "@/lib/api/leads";
import { fmtNum } from "@/lib/utils";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { DateRangePicker } from "@/components/DateRangePicker";

// ── Date helpers ──────────────────────────────────────────────────
const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO   = () => localISO(new Date());
const daysAgoISO = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localISO(d); };
const startOfMonthISO = () => { const d = new Date(); d.setDate(1); return localISO(d); };

const getDefaultFilter = (): DashFilter => ({ start_date: startOfMonthISO(), end_date: todayISO() });

// ── MultiSelect dropdown component ───────────────────────────────
function MultiSelect({
  label, icon, options, values, onChange, loading,
}: {
  label: string;
  icon: React.ReactNode;
  options: { value: string; label: string }[];
  values: string[];
  onChange: (v: string[]) => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const toggle = (v: string) => {
    onChange(values.includes(v) ? values.filter(x => x !== v) : [...values, v]);
  };

  const displayLabel = values.length === 0
    ? "Barchasi"
    : values.length === 1
      ? (options.find(o => o.value === values[0])?.label ?? values[0]).slice(0, 22)
      : `${values.length} ta tanlangan`;

  return (
    <div ref={ref} style={{ flex: 1, minWidth: 0, position: "relative" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "var(--text3)", marginBottom: 6 }}>
        {icon}{label}
      </label>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--bg)", border: `1px solid ${values.length > 0 ? "rgba(33,150,243,0.5)" : "var(--border)"}`,
          borderRadius: 8, color: values.length > 0 ? "#2196F3" : "var(--text3)",
          fontSize: 12, padding: "8px 10px", cursor: "pointer", boxSizing: "border-box",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {loading ? "Yuklanmoqda…" : displayLabel}
        </span>
        <ChevronDown size={12} style={{ flexShrink: 0, marginLeft: 4, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, minWidth: "100%", zIndex: 600,
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 4px 24px rgba(0,0,0,0.5)", maxHeight: 220, overflowY: "auto", marginTop: 4,
        }}>
          {values.length > 0 && (
            <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
              <button type="button" onClick={() => onChange([])}
                style={{ fontSize: 11, color: "#9E9E9E", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                Hammasini olib tashlash
              </button>
            </div>
          )}
          {options.map(o => {
            const checked = values.includes(o.value);
            return (
              <label key={o.value}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", cursor: "pointer", background: checked ? "rgba(33,150,243,0.08)" : "transparent" }}
                onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = "var(--bg3)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = checked ? "rgba(33,150,243,0.08)" : "transparent"; }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} style={{ accentColor: "#2196F3", flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {o.label}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Responsible table column definitions ─────────────────────────
const RESPONSIBLE_COLS = [
  { key: "qongiroqlar",             label: "Qo'ng'iroqlar",            color: "#9E9E9E" },
  { key: "yangi_lid",               label: "Yangi lid",                color: "#2196F3" },
  { key: "propushenniy",            label: "Propushenniy",             color: "#9E9E9E" },
  { key: "javob_bermadi",           label: "Javob bermadi",            color: "#FF9800" },
  { key: "qayta_aloqa",             label: "Qayta aloqa",              color: "#00BCD4" },
  { key: "oylab_koradi",            label: "O'ylab ko'radi",           color: "#E91E63" },
  { key: "konsultatsiya",           label: "Konsultatsiya belgilandi", color: "#9C27B0" },
  { key: "otkazilmadi",             label: "O'tkazilmadi",             color: "#FF00FF" },
  { key: "sandiq",                  label: "Sandiq",                   color: "#42A5F5" },
  { key: "sifatsiz",                label: "Sifatsiz",                 color: "#F44336" },
  { key: "konsultatsiya_otkazildi", label: "Konsultatsiya o'tkazildi", color: "#4CAF50" },
  { key: "bekor_boldi",             label: "Bekor bo'ldi",             color: "#FFC107" },
] as const;
type RespColKey = typeof RESPONSIBLE_COLS[number]["key"];

/**
 * Lid va Konversiya grouping dimensions. Adding a tab is adding an entry here —
 * the metric columns, the totals row and the drill-down are all shared, because
 * only the grouping key differs between them (the backend computes every metric
 * off the lead's live stage regardless of which dimension is selected).
 * `label` doubles as the header of the group column.
 */
const CONV_DIMS: { key: ConversionDimension; tab: string; label: string }[] = [
  { key: "manager",  tab: "Menejer",   label: "Menejer"   },
  { key: "source",   tab: "Manba",     label: "Manba"     },
  { key: "campaign", tab: "Kampaniya", label: "Kampaniya" },
  { key: "stage",    tab: "Bosqich",   label: "Bosqich"   },
];

// ── Shared mini-components ────────────────────────────────────────
const AVATAR_COLORS = [
  "#2196F3","#E91E63","#9C27B0","#00BCD4","#FF9800",
  "#4CAF50","#FF5722","#3F51B5","#009688","#795548",
];


function AvatarCircle({ name, size = 36 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : (parts[0]?.[0] ?? "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  const bg = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: bg, flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#fff", fontSize: size * 0.36, fontWeight: 700, userSelect: "none",
    }}>
      {initials}
    </div>
  );
}

function MiniBar({ value, max, color, height = 3 }: { value: number; max: number; color: string; height?: number }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ height, borderRadius: 2, background: "var(--bg4)", marginTop: 5, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${w}%`, background: color, borderRadius: 2, transition: "width 0.3s" }} />
    </div>
  );
}

function ConversionDonut({ pct, size = 38 }: { pct: number; size?: number }) {
  const sw = 3;
  const r  = (size - sw * 2) / 2;
  const circ = 2 * Math.PI * r;
  const fill = circ - (Math.min(100, pct) / 100) * circ;
  if (pct <= 0) {
    return (
      <div style={{ width: size, height: size, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width={size} height={size} style={{ position: "absolute" }}>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={sw} />
        </svg>
        <span style={{ fontSize: 10, color: "#555", zIndex: 1 }}>—</span>
      </div>
    );
  }
  const label = pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
  return (
    <div style={{ width: size, height: size, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={size} height={size} style={{ position: "absolute", transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={sw} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#4CAF50" strokeWidth={sw}
                strokeDasharray={circ} strokeDashoffset={fill} strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: 9, color: "#4CAF50", fontWeight: 700, zIndex: 1 }}>{label}</span>
    </div>
  );
}

// ── UTM source display name mapping ──────────────────────────────
const UTM_SOURCE_DISPLAY_NAMES: Record<string, string> = {
  ig:        "Instagram",
  fb:        "Facebook",
  facebook:  "Facebook",
  Facebook:  "Facebook",
  instagram: "Instagram",
  Instagram: "Instagram",
};

// ── Shared funnel column definitions ─────────────────────────────
const UTM_COLS_DEF = [
  { key: "umumiy_lidlar"            as const, label: "UMUMIY LIDLAR",             color: "#2196F3" },
  { key: "jarayonda"                as const, label: "JARAYONDA",                 color: "#FF9800" },
  { key: "sifatli_lid"              as const, label: "SIFATLI LID",               color: "#9C27B0" },
  { key: "konsultatsiya_belgilandi" as const, label: "KONSULTATSIYA BELGILANDI",  color: "#2196F3" },
  { key: "konsultatsiya_otkazildi"  as const, label: "KONSULTATSIYA O'TKAZILDI",  color: "#4CAF50" },
  { key: "sifatsiz"                 as const, label: "SIFATSIZ",                  color: "#F44336" },
  { key: "bekor_boldi"              as const, label: "BEKOR BO'LDI",              color: "#FFC107" },
] as const;


// ── Sparkline ─────────────────────────────────────────────────────
// Catmull-Rom → cubic Bézier smooth path
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  const d: string[] = [`M ${pts[0][0]},${pts[0][1]}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d.push(`C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0]},${p2[1]}`);
  }
  return d.join(" ");
}

function Sparkline({ color, variant = 0 }: { color: string; variant?: number }) {
  // Sine-wave–style control points: y=0 is top, y=60 is bottom; peaks ~10, troughs ~52
  const variants: [number, number][][] = [
    // 0: Blue — classic 2.5-cycle sine wave
    [[0,42],[25,54],[50,28],[75,10],[100,28],[125,52],[150,30],[175,10],[200,28]],
    // 1: Teal — phase-shifted, starts at mid-rise
    [[0,28],[25,10],[50,30],[75,52],[100,32],[125,10],[150,32],[175,54],[200,36]],
    // 2: Purple — slightly stretched, 2 full cycles
    [[0,36],[30,52],[60,28],[90,10],[120,28],[150,52],[175,32],[200,12]],
    // 3: Green — upward-trending wave (used for conversion)
    [[0,54],[30,46],[58,32],[85,18],[110,30],[135,42],[158,26],[180,14],[200,12]],
  ];
  const pts = variants[variant % variants.length];
  const linePath = smoothPath(pts);
  const areaPath = `${linePath} L 200,60 L 0,60 Z`;
  const last = pts[pts.length - 1];
  const gid = `spk${variant}${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg viewBox="0 0 200 60" preserveAspectRatio="none" style={{ width: "100%", height: 80, display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.52" />
          <stop offset="100%" stopColor={color} stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gid})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill={color} />
    </svg>
  );
}

// ── Gradient card shell ───────────────────────────────────────────
type GradCardProps = {
  gradient: string; lightGradient: string; border: string; lightBorder: string; shadow: string;
  icon: React.ReactNode; title: string; children: React.ReactNode;
  sparkColor: string; sparkVariant?: number;
};
function GradCard({ gradient, lightGradient, border, lightBorder, shadow, icon, title, children, sparkColor, sparkVariant = 0 }: GradCardProps) {
  const { theme } = useDarkMode();
  const isDark = theme === 'dark';
  return (
    <div style={{
      background: isDark ? gradient : lightGradient,
      border: `1px solid ${isDark ? border : lightBorder}`,
      boxShadow: shadow,
      borderRadius: 16, padding: "16px 16px 0 16px",
      display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 200,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: isDark ? border.replace(/[\d.]+\)$/, "0.18)") : lightBorder.replace(/[\d.]+\)$/, "0.18)"),
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 8, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: isDark ? "#fff" : "var(--text)", marginBottom: 3 }}>{title}</div>
      {children}
      <div style={{ marginTop: "auto", marginLeft: -16, marginRight: -16 }}>
        <Sparkline color={sparkColor} variant={sparkVariant} />
      </div>
    </div>
  );
}

// ── Shared table header cell style ────────────────────────────────
const TH = (color: string, minW = 140): React.CSSProperties => ({
  padding: "11px 14px", textAlign: "left", fontSize: 12, fontWeight: 700,
  color, textTransform: "uppercase", letterSpacing: "0.04em",
  background: "var(--bg2)", borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap", minWidth: minW,
});
const TD: React.CSSProperties = {
  padding: "10px 14px", verticalAlign: "middle",
  borderBottom: "1px solid var(--border)",
};

// Responsibles excluded from "Lid va konversiya" and "Lid va mas'ullar kesimida" tables
const EXCLUDED_RESPONSIBLES = [
  "Data365", "Data365 Support", "Shaxzod Turanov", "Murodjon",
  "Abror", "Sardor Jumayev", "Sardor Jjumayev", "Main (asosiy)", "Main",
];
const isExcluded = (name: string) =>
  EXCLUDED_RESPONSIBLES.some((ex) => name.trim().toLowerCase().includes(ex.toLowerCase()));

// ─────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────
export default function LidlarPage() {
  const { theme } = useDarkMode();
  const isDark = theme === 'dark';
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const [search] = useState("");
  const [mode, setMode] = useState<'default' | 'amocrm' | 'bitrix24'>('default');

  const [applied, setApplied] = useLocalStorage<DashFilter>("lidlar.filter.v4", getDefaultFilter());

  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node))
        setFilterOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterOpen]);

  const filterOptsQ = useQuery({
    queryKey: ["filter-options", mode],
    queryFn: () => getFilterOptions(mode),
    staleTime: 5 * 60 * 1000,
  });
  const filterOpts = filterOptsQ.data;

  const amocrmSrcQ = useQuery({
    queryKey: ["amocrm-sources"],
    queryFn: getAmocrmSources,
    staleTime: 10 * 60 * 1000,
    enabled: mode === 'amocrm',
  });

  const activeCount = [
    (applied.responsible_ids?.length ?? 0) > 0,
    (applied.stages?.length ?? 0) > 0,
    (applied.sources?.length ?? 0) > 0,
    (applied.form_ids?.length ?? 0) > 0,
    applied.start_date != null || applied.end_date != null,
  ].filter(Boolean).length;

  const appliedWithMode = { ...applied, mode };

  const statsQ      = useQuery({ queryKey: ["stats/dashboard",    appliedWithMode], queryFn: () => getDashboardStats(appliedWithMode) });
  const respQ       = useQuery({ queryKey: ["stats/responsibles", appliedWithMode], queryFn: () => getResponsiblesStats(appliedWithMode) });
  const [convDim, setConvDim] = useState<ConversionDimension>("manager");
  const conversionQ = useQuery({ queryKey: ["stats/conversion",   appliedWithMode, convDim], queryFn: () => getConversionStats(appliedWithMode, convDim) });
  const tasksQ      = useQuery({ queryKey: ["stats/tasks",        appliedWithMode], queryFn: () => getTasksSummary(appliedWithMode) });
  const cancelQ     = useQuery({ queryKey: ["stats/cancel-reasons", appliedWithMode], queryFn: () => getCancelReasons(appliedWithMode) });
  const junkQ       = useQuery({ queryKey: ["stats/junk-reasons",   appliedWithMode], queryFn: () => getJunkReasons(appliedWithMode) });
  const sourceQ     = useQuery({ queryKey: ["stats/source-stats", appliedWithMode], queryFn: () => getSourceStats(appliedWithMode) });
  const utmStatsQ   = useQuery({ queryKey: ["stats/utm-stats", appliedWithMode], queryFn: () => getUtmStats(appliedWithMode) });
  const [selectedRespConv, setSelectedRespConv] = useState<{ id: string; name: string } | null>(null);
  const respLeadsConvQ = useQuery({
    queryKey: ["stats/responsible-leads-conv", selectedRespConv?.id, appliedWithMode, convDim],
    queryFn: () => getResponsibleLeads(selectedRespConv!.id, appliedWithMode, convDim),
    enabled: selectedRespConv !== null,
  });
  const [selectedRespMasul, setSelectedRespMasul] = useState<{ id: number; name: string } | null>(null);
  const respLeadsMasulQ = useQuery({
    queryKey: ["stats/responsible-leads-masul", selectedRespMasul?.id, appliedWithMode],
    queryFn: () => getResponsibleLeads(selectedRespMasul!.id, appliedWithMode),
    enabled: selectedRespMasul !== null,
  });
  type UtmPath = {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
  };
  const [utmPath, setUtmPath] = useState<UtmPath>({});

  const utmLevel =
    utmPath.term     !== undefined ? 5 :
    utmPath.content  !== undefined ? 4 :
    utmPath.campaign !== undefined ? 3 :
    utmPath.medium   !== undefined ? 2 :
    utmPath.source   !== undefined ? 1 : 0;

  const utmMediumQ = useQuery({
    queryKey: ["stats/utm-medium", utmPath.source, appliedWithMode],
    queryFn: () => getUtmMediumStats(utmPath.source!, appliedWithMode),
    enabled: utmLevel >= 1,
    staleTime: 60_000,
  });
  const utmCampaignQ = useQuery({
    queryKey: ["stats/utm-campaigns", utmPath.source, utmPath.medium, appliedWithMode],
    queryFn: () => getUtmCampaignStats(utmPath.source!, utmPath.medium!, appliedWithMode),
    enabled: utmLevel >= 2,
    staleTime: 60_000,
  });
  const utmContentQ = useQuery({
    queryKey: ["stats/utm-content", utmPath.source, utmPath.medium, utmPath.campaign, appliedWithMode],
    queryFn: () => getUtmContentStats({ source: utmPath.source!, medium: utmPath.medium!, campaign: utmPath.campaign! }, appliedWithMode),
    enabled: utmLevel >= 3,
    staleTime: 60_000,
  });
  const utmTermQ = useQuery({
    queryKey: ["stats/utm-term", utmPath.source, utmPath.medium, utmPath.campaign, utmPath.content, appliedWithMode],
    queryFn: () => getUtmTermStats({ source: utmPath.source!, medium: utmPath.medium!, campaign: utmPath.campaign!, content: utmPath.content! }, appliedWithMode),
    enabled: utmLevel >= 4,
    staleTime: 60_000,
  });
  const utmRespQ = useQuery({
    queryKey: ["stats/utm-responsibles", utmPath, appliedWithMode],
    queryFn: () => getUtmResponsibleStats({ source: utmPath.source!, campaign: utmPath.campaign!, medium: utmPath.medium, content: utmPath.content, term: utmPath.term }, appliedWithMode),
    enabled: utmLevel >= 5,
    staleTime: 60_000,
  });

  const header       = statsQ.data?.header;
  const responsibles = (respQ.data?.responsibles ?? []).filter((u) => !isExcluded(u.full_name));

  const enrichedResponsibles = responsibles;

  const total             = header?.total_leads                    ?? 0;
  const totalCalls        = (header as { total_calls?: number })?.total_calls ?? 0;
  const jarayondaCount    = header?.in_process                     ?? 0;
  const sifatsizBekor     = header?.sifatsiz_bekor_count           ?? 0;
  const bekorBoldiCount   = header?.bekor_boldi_count              ?? 0;
  const sifatliLid        = header?.sifatli_lid_count              ?? 0;
  const konsultBelgilandi = header?.konsultatsiya_belgilandi_count  ?? 0;
  const konsultOtkazildi  = header?.konsultatsiya_otkazildi_count   ?? 0;
  const kelishuv          = (header as { kelishuv_count?: number })?.kelishuv_count ?? 0;
  const sotuvBoldi        = (header as { sotuv_count?: number })?.sotuv_count       ?? 0;

  const overallConvPct   = total > 0 ? (konsultOtkazildi  / total) * 100 : 0;

  const byUserFiltered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return s ? enrichedResponsibles.filter((u) => u.full_name.toLowerCase().includes(s)) : enrichedResponsibles;
  }, [enrichedResponsibles, search]);

  const colMaxes = useMemo(() => {
    const m: Partial<Record<RespColKey, number>> = {};
    for (const col of RESPONSIBLE_COLS)
      m[col.key] = Math.max(1, ...enrichedResponsibles.map((u) => (u as unknown as Record<string, number>)[col.key] ?? 0));
    return m;
  }, [enrichedResponsibles]);

  const totalsRow = useMemo(() => {
    const bs: Partial<Record<RespColKey, number>> = {};
    for (const u of enrichedResponsibles)
      for (const col of RESPONSIBLE_COLS)
        bs[col.key] = (bs[col.key] ?? 0) + ((u as unknown as Record<string, number>)[col.key] ?? 0);
    return bs;
  }, [enrichedResponsibles]);

  const isLoading = statsQ.isLoading;

  // ── Lid va Konversiya rows (sorted by total desc) ───────────────
  const convRows = useMemo(() => {
    // EXCLUDED_RESPONSIBLES is a list of people, so it only applies when the
    // rows are people — a campaign or source name must never be dropped by it.
    const raw = conversionQ.data?.conversion ?? [];
    const rows = convDim === "manager" ? raw.filter((r) => !isExcluded(r.name)) : [...raw];
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }, [conversionQ.data, convDim]);

  const convMax = useMemo(() => ({
    total:     Math.max(1, ...convRows.map((r) => r.total)),
    jarayonda: Math.max(1, ...convRows.map((r) => r.jarayonda)),
    sifatli:   Math.max(1, ...convRows.map((r) => r.sifatli_lid ?? 0)),
    sifatsiz:  Math.max(1, ...convRows.map((r) => r.sifatsiz_lid)),
    bekor:     Math.max(1, ...convRows.map((r) => r.bekor_boldi ?? 0)),
    otkazildi: Math.max(1, ...convRows.map((r) => r.tashrif_buyurdi)),
  }), [convRows]);

  const convTotals = useMemo(() => convRows.reduce(
    (acc, r) => ({
      total:     acc.total     + r.total,
      jarayonda: acc.jarayonda + r.jarayonda,
      sifatli:   acc.sifatli   + (r.sifatli_lid ?? 0),
      sifatsiz:  acc.sifatsiz  + r.sifatsiz_lid,
      bekor:     acc.bekor     + (r.bekor_boldi ?? 0),
      otkazildi: acc.otkazildi + r.tashrif_buyurdi,
    }),
    { total: 0, jarayonda: 0, sifatli: 0, sifatsiz: 0, bekor: 0, otkazildi: 0 }
  ), [convRows]);

  return (
    <>
      <Topbar
        title="Lidlar analitika"
        actions={
          <div style={{ display: "flex", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 2 }}>
            <button onClick={() => { setMode('default'); setApplied(getDefaultFilter()); }}
              style={{ border: "none", borderRadius: 6, fontSize: 11.5, fontWeight: 600, padding: "5px 12px", cursor: "pointer", background: mode === 'default' ? "#3b82f6" : "transparent", color: mode === 'default' ? "#fff" : "var(--text2)", transition: "all 0.2s" }}>
              Barcha lidlar
            </button>
            <button onClick={() => { setMode('bitrix24'); setApplied(getDefaultFilter()); }}
              style={{ border: "none", borderRadius: 6, fontSize: 11.5, fontWeight: 600, padding: "5px 12px", cursor: "pointer", background: mode === 'bitrix24' ? "#22c55e" : "transparent", color: mode === 'bitrix24' ? "#fff" : "var(--text2)", transition: "all 0.2s" }}>
              Bitrix24
            </button>
            <button onClick={() => { setMode('amocrm'); setApplied(getDefaultFilter()); }}
              style={{ border: "none", borderRadius: 6, fontSize: 11.5, fontWeight: 600, padding: "5px 12px", cursor: "pointer", background: mode === 'amocrm' ? "#D97706" : "transparent", color: mode === 'amocrm' ? "#fff" : "var(--text2)", transition: "all 0.2s" }}>
              AmoCRM
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-3 sm:px-[22px] py-3 sm:py-[18px]" style={{ background: "var(--bg)" }}>

        {/* ── Filter panel ── */}
        <div ref={filterRef} style={{ position: "sticky", top: 0, zIndex: 10, marginBottom: 20 }}>
          {/* Trigger button */}
          <button
            onClick={() => setFilterOpen((o) => !o)}
            style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              background: "var(--bg2)",
              border: `1px solid ${filterOpen ? "#2196F3" : activeCount > 0 || mode !== 'default' ? "rgba(33,150,243,0.5)" : "var(--border)"}`,
              borderRadius: filterOpen ? "10px 10px 0 0" : 10,
              padding: "10px 16px", color: "var(--text)", fontSize: 13, fontWeight: 500,
              cursor: "pointer", textAlign: "left",
            }}
          >
            <Search size={16} style={{ color: "var(--text3)", flexShrink: 0 }} />
            <span style={{ color: "var(--text3)", flex: 1 }}>
              {applied.start_date || applied.end_date
                ? `Filtr: ${applied.start_date ?? '…'} → ${applied.end_date ?? '…'}`
                : 'Qidirish va filtrlash…'}
            </span>
            {mode === 'amocrm' && (
              <span style={{ background: "rgba(217,119,6,0.15)", color: "#D97706", border: "1px solid rgba(217,119,6,0.4)", borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>AmoCRM</span>
            )}
            {mode === 'bitrix24' && (
              <span style={{ background: "rgba(33,150,243,0.15)", color: "#2196F3", border: "1px solid rgba(33,150,243,0.4)", borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>Bitrix24</span>
            )}
            {activeCount > 0 && (
              <span style={{
                background: "#2196F3", color: "#fff", borderRadius: 10,
                padding: "2px 9px", fontSize: 11, fontWeight: 700,
              }}>
                {activeCount} filtr
              </span>
            )}
            <ChevronDown size={16} style={{
              color: "#9E9E9E",
              transform: filterOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.2s",
            }} />
          </button>

          {/* Dropdown */}
          {filterOpen && (
            <div style={{
              position: "absolute", left: 0, right: 0, zIndex: 100,
              background: "var(--bg2)", border: "1px solid var(--border)", borderTop: "none",
              borderRadius: "0 0 12px 12px", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              overflow: "visible",
            }}>
              <div style={{ padding: "16px 20px" }}>
                {/* Davr — sana oralig'i + tezkor presetlar */}
                <div style={{ marginBottom: 14 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "var(--text3)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    <Calendar size={12} />{mode === 'amocrm' ? "Davr (amoCRM)" : "Davr"}
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <DateRangePicker
                      start={applied.start_date} end={applied.end_date}
                      onChange={(s, e) => setApplied((p) => ({ ...p, start_date: s, end_date: e }))}
                      onClear={() => setApplied((p) => ({ ...p, start_date: undefined, end_date: undefined }))}
                    />
                    {[
                      { label: "Bugun",      start: todayISO(),    end: todayISO() },
                      { label: "7 kun",      start: daysAgoISO(7), end: todayISO() },
                      { label: "30 kun",     start: daysAgoISO(30),end: todayISO() },
                      { label: "90 kun",     start: daysAgoISO(90),end: todayISO() },
                      { label: "Butun davr", start: "",             end: "" },
                    ].map((p) => {
                      const active = applied.start_date === (p.start || undefined) && applied.end_date === (p.end || undefined);
                      return (
                        <button key={p.label}
                          onClick={() => setApplied((prev) => ({ ...prev, start_date: p.start || undefined, end_date: p.end || undefined }))}
                          style={{
                            background: active ? "#2196F3" : "var(--bg3)",
                            border: `1px solid ${active ? "#2196F3" : "var(--border)"}`,
                            color: active ? "#fff" : "#9E9E9E",
                            borderRadius: 20, padding: "5px 14px",
                            fontSize: 12, fontWeight: active ? 600 : 400,
                            cursor: "pointer", transition: "all 0.15s",
                          }}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* MultiSelect filters row */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <MultiSelect
                    label="Mas'ul xodim" icon={<Users size={12} />}
                    options={(filterOpts?.responsibles ?? []).map(r => ({ value: String(r.id), label: r.full_name }))}
                    values={(applied.responsible_ids ?? []).map(String)}
                    onChange={(vals) => setApplied(p => ({ ...p, responsible_ids: vals.map(Number) }))}
                    loading={filterOptsQ.isLoading}
                  />
                  <MultiSelect
                    label="Bosqich" icon={<Filter size={12} />}
                    options={(filterOpts?.stages ?? []).map(s => ({ value: s.bitrix_id, label: s.name }))}
                    values={applied.stages ?? []}
                    onChange={(vals) => setApplied(p => ({ ...p, stages: vals.length ? vals : undefined }))}
                    loading={filterOptsQ.isLoading}
                  />
                  <MultiSelect
                    label="Manba" icon={<TrendingUp size={12} />}
                    options={mode === 'amocrm'
                      ? (amocrmSrcQ.data ?? []).map(s => ({ value: s, label: s }))
                      : (filterOpts?.sources ?? []).map(s => ({ value: s.id, label: s.name }))}
                    values={applied.sources ?? []}
                    onChange={(vals) => setApplied(p => ({ ...p, sources: vals.length ? vals : undefined }))}
                    loading={mode === 'amocrm' ? amocrmSrcQ.isLoading : filterOptsQ.isLoading}
                  />
                </div>
                {activeCount > 0 && (
                  <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end" }}>
                    <button onClick={() => setApplied(getDefaultFilter())}
                      style={{ background: "none", border: "none", color: "#9E9E9E", fontSize: 12, cursor: "pointer", padding: "6px 10px" }}>
                      Tozalash
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── KPI cards + Voronka ── */}
        {isLoading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
            {[0,1,2,3].map((i) => <div key={i} style={{ height: 200, borderRadius: 16, background: "var(--bg2)" }} />)}
          </div>
        ) : (
          <>
            {/* Row 1 — 4 equal KPI cards */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:12 }}>
              <GradCard gradient="linear-gradient(135deg,#0d1b4a,#1a3a7a)" lightGradient="linear-gradient(135deg,rgba(33,150,243,0.07),rgba(33,150,243,0.03))"
                        border="rgba(33,150,243,0.3)" lightBorder="rgba(33,150,243,0.25)"
                        shadow="0 4px 20px rgba(33,150,243,0.15)" icon={<Users size={20} style={{ color:"#2196F3" }} />}
                        title="Umumiy Lidlar" sparkColor="#2196F3" sparkVariant={0}>
                <div style={{ fontSize:36, fontWeight:800, color: isDark ? "#fff" : "var(--text)", lineHeight:1.1, marginBottom:3 }}>{fmtNum(total)}</div>
                <div style={{ fontSize:11, color: isDark ? "#9E9E9E" : "var(--text3)" }}>Umumiy Lid</div>
                {totalCalls > 0 && (
                  <div style={{ fontSize:11, color:"#2196F3", marginTop:4, fontWeight:600 }}>
                    + {fmtNum(totalCalls)} qo'ng'iroq
                  </div>
                )}
              </GradCard>
              <GradCard gradient="linear-gradient(135deg,#002a2a,#005555)" lightGradient="linear-gradient(135deg,rgba(0,188,212,0.07),rgba(0,188,212,0.03))"
                        border="rgba(0,188,212,0.3)" lightBorder="rgba(0,188,212,0.25)"
                        shadow="0 4px 20px rgba(0,188,212,0.15)" icon={<Star size={20} style={{ color:"#00BCD4" }} />}
                        title="Sifatli Lidlar" sparkColor="#00BCD4" sparkVariant={1}>
                <div style={{ fontSize:36, fontWeight:800, color:"#00BCD4", lineHeight:1.1, marginBottom:3 }}>{fmtNum(sifatliLid)}</div>
                <div style={{ fontSize:11, color: isDark ? "#9E9E9E" : "var(--text3)" }}>Sifatli Lid</div>
              </GradCard>
              <GradCard gradient="linear-gradient(135deg,#2a1500,#6e3d00)" lightGradient="linear-gradient(135deg,rgba(255,152,0,0.07),rgba(255,152,0,0.03))"
                        border="rgba(255,152,0,0.3)" lightBorder="rgba(255,152,0,0.25)"
                        shadow="0 4px 20px rgba(255,152,0,0.15)" icon={<ArrowLeftRight size={20} style={{ color:"#FF9800" }} />}
                        title="Jarayonda" sparkColor="#FF9800" sparkVariant={2}>
                <div style={{ fontSize:36, fontWeight:800, color:"#FF9800", lineHeight:1.1, marginBottom:3 }}>{fmtNum(jarayondaCount)}</div>
                <div style={{ fontSize:11, color: isDark ? "#9E9E9E" : "var(--text3)" }}>Jarayondagi lidlar</div>
              </GradCard>
              <GradCard gradient="linear-gradient(135deg,#0a2e0a,#1b5e20)" lightGradient="linear-gradient(135deg,rgba(76,175,80,0.07),rgba(76,175,80,0.03))"
                        border="rgba(76,175,80,0.3)" lightBorder="rgba(76,175,80,0.25)"
                        shadow="0 4px 20px rgba(76,175,80,0.15)" icon={<TrendingUp size={20} style={{ color:"#4CAF50" }} />}
                        title="Yakuniy Konversiya" sparkColor="#4CAF50" sparkVariant={3}>
                <div style={{ fontSize:36, fontWeight:800, color: isDark ? "#fff" : "var(--text)", lineHeight:1.1, marginBottom:3 }}>{overallConvPct.toFixed(1)}%</div>
                <div style={{ fontSize:11, color: isDark ? "#9E9E9E" : "var(--text3)" }}>Konsultatsiya o'tkazildi / umumiy lid</div>
              </GradCard>
            </div>

            {/* Row 2 — Voronka (3 cols) + Sifatsiz/Bekor (1 col) */}
            <div style={{ display:"grid", gridTemplateColumns:"3fr 1fr", gap:12, marginBottom:20 }}>
              {/* Voronka */}
              <div style={{ background: isDark ? "linear-gradient(135deg,#0a1628,#0d2240)" : "linear-gradient(135deg,rgba(33,150,243,0.06),rgba(0,188,212,0.04))", border:"1px solid var(--border)", borderRadius:16, padding:"20px 24px", display:"flex", flexDirection:"column" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
                  <Filter size={14} style={{ color:"var(--text3)" }} />
                  <span style={{ fontSize:13, fontWeight:700, color:"var(--text)" }}>To'liq Voronka</span>
                  <span style={{ fontSize:11, color:"var(--text3)", marginLeft:2 }}>Lid → Sotuv konversiyasi</span>
                </div>
                <div style={{ flex:1, display:"flex", alignItems:"center", gap:0 }}>
                  {([
                    { label:"Sifatli Lid",      count: sifatliLid,        color:"#00BCD4", pct: total > 0 ? (sifatliLid / total) * 100 : 0,                                                  pctLabel:"Umumiydan" },
                    { label:"K. Belgilandi",     count: konsultBelgilandi, color:"#9C27B0", pct: sifatliLid > 0 ? (konsultBelgilandi / sifatliLid) * 100 : 0,                                 pctLabel:"Sifatlidan" },
                    { label:"K. O'tkazildi",     count: konsultOtkazildi,  color:"#4CAF50", pct: konsultBelgilandi > 0 ? (konsultOtkazildi / konsultBelgilandi) * 100 : 0,                    pctLabel:"Belgilandidan" },
                    { label:"Kelishuv bo'ldi",   count: kelishuv,          color:"#FF9800", pct: konsultOtkazildi > 0 ? (kelishuv / konsultOtkazildi) * 100 : 0,                              pctLabel:"O'tkazildidan" },
                    { label:"Sotuv bo'ldi",      count: sotuvBoldi,        color:"#4CAF50", pct: kelishuv > 0 ? (sotuvBoldi / kelishuv) * 100 : 0,                                            pctLabel:"Kelishuvdan" },
                  ] as { label:string; count:number; color:string; pct:number; pctLabel:string }[]).map((s, i) => (
                    <div key={s.label} style={{ display:"flex", alignItems:"center", flex: i < 4 ? "1 1 0" : "none" }}>
                      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, flex:1, padding:"4px 8px" }}>
                        <div style={{ fontSize:11, fontWeight:600, color:"var(--text3)", textAlign:"center", whiteSpace:"nowrap" }}>{s.label}</div>
                        <div style={{ fontSize:32, fontWeight:800, color:s.color, lineHeight:1 }}>{fmtNum(s.count)}</div>
                        <div style={{ fontSize:11, color:"var(--text3)", textAlign:"center" }}>
                          <span style={{ color:s.color, fontWeight:700 }}>{s.pct.toFixed(0)}%</span> {s.pctLabel}
                        </div>
                      </div>
                      {i < 4 && (
                        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, flexShrink:0, padding:"0 4px" }}>
                          <div style={{ width:0, height:0, borderTop:"6px solid transparent", borderBottom:"6px solid transparent", borderLeft:`8px solid ${s.color}` }} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Jarayonda + Sifatsiz + Bekor bo'ldi — stacked */}
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {/* Konsultatsiyalar */}
                <div style={{ flex:1, background: isDark ? "linear-gradient(135deg,#1a0033,#3d1a6e)" : "linear-gradient(135deg,rgba(156,39,176,0.07),rgba(156,39,176,0.03))",
                              border: `1px solid ${isDark ? "rgba(156,39,176,0.3)" : "rgba(156,39,176,0.25)"}`,
                              boxShadow:"0 4px 20px rgba(156,39,176,0.12)", borderRadius:16,
                              padding:"16px 16px 0 16px", display:"flex", flexDirection:"column", overflow:"hidden" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:40, height:40, borderRadius:"50%", background:"rgba(156,39,176,0.2)", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <Calendar size={20} style={{ color:"#9C27B0" }} />
                    </div>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color: isDark ? "#fff" : "var(--text)" }}>Konsultatsiyalar</div>
                      <div style={{ display:"flex", alignItems:"baseline", gap:5, lineHeight:1.1, marginTop:2 }}>
                        <span style={{ fontSize:34, fontWeight:800, color: isDark ? "#fff" : "var(--text)" }}>{fmtNum(konsultBelgilandi)}</span>
                        <span style={{ fontSize:20, fontWeight:700, color: isDark ? "#9E9E9E" : "var(--text3)" }}>/</span>
                        <span style={{ fontSize:34, fontWeight:800, color:"#4CAF50" }}>{fmtNum(konsultOtkazildi)}</span>
                      </div>
                      <div style={{ fontSize:11, marginTop:2 }}>
                        <span style={{ color: isDark ? "#9E9E9E" : "var(--text3)" }}>Belgilandi</span>
                        <span style={{ color: isDark ? "#555" : "var(--text3)" }}> / </span>
                        <span style={{ color:"#4CAF50" }}>O'tkazildi</span>
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop:"auto", marginLeft:-16, marginRight:-16 }}>
                    <Sparkline color="#9C27B0" variant={2} />
                  </div>
                </div>
                {/* Sifatsiz */}
                <div style={{ flex:1, background: isDark ? "linear-gradient(135deg,#2a0000,#6e1a1a)" : "linear-gradient(135deg,rgba(244,67,54,0.07),rgba(244,67,54,0.03))",
                              border: `1px solid ${isDark ? "rgba(244,67,54,0.3)" : "rgba(244,67,54,0.25)"}`,
                              boxShadow:"0 4px 20px rgba(244,67,54,0.15)", borderRadius:16,
                              padding:"16px 16px 0 16px", display:"flex", flexDirection:"column", overflow:"hidden" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:40, height:40, borderRadius:"50%", background:"rgba(244,67,54,0.2)", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <XCircle size={20} style={{ color:"#F44336" }} />
                    </div>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color: isDark ? "#fff" : "var(--text)" }}>Sifatsiz</div>
                      <div style={{ fontSize:34, fontWeight:800, color:"#F44336", lineHeight:1.1, marginTop:2 }}>{fmtNum(sifatsizBekor)}</div>
                      <div style={{ fontSize:11, color: isDark ? "#9E9E9E" : "var(--text3)", marginTop:2 }}>Sifatsiz lidlar</div>
                    </div>
                  </div>
                  <div style={{ marginTop:"auto", marginLeft:-16, marginRight:-16 }}>
                    <Sparkline color="#F44336" variant={0} />
                  </div>
                </div>
                {/* Bekor bo'ldi */}
                <div style={{ flex:1, background: isDark ? "linear-gradient(135deg,#2a1a00,#6e4a00)" : "linear-gradient(135deg,rgba(255,193,7,0.07),rgba(255,193,7,0.03))",
                              border: `1px solid ${isDark ? "rgba(255,193,7,0.3)" : "rgba(255,193,7,0.25)"}`,
                              boxShadow:"0 4px 20px rgba(255,193,7,0.12)", borderRadius:16,
                              padding:"16px 16px 0 16px", display:"flex", flexDirection:"column", overflow:"hidden" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:40, height:40, borderRadius:"50%", background:"rgba(255,193,7,0.2)", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <XCircle size={20} style={{ color:"#FFC107" }} />
                    </div>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color: isDark ? "#fff" : "var(--text)" }}>Bekor bo'ldi</div>
                      <div style={{ fontSize:34, fontWeight:800, color:"#FFC107", lineHeight:1.1, marginTop:2 }}>{fmtNum(bekorBoldiCount)}</div>
                      <div style={{ fontSize:11, color: isDark ? "#9E9E9E" : "var(--text3)", marginTop:2 }}>Bekor bo'lgan lidlar</div>
                    </div>
                  </div>
                  <div style={{ marginTop:"auto", marginLeft:-16, marginRight:-16 }}>
                    <Sparkline color="#FFC107" variant={1} />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════
            Lid va Konversiya table
        ══════════════════════════════════════════════════════════ */}
        <div style={{ background:"var(--bg2)", borderRadius:12, overflow:"hidden", marginBottom:16 }}>
          <div style={{ padding:"16px 20px 12px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
            <span style={{ fontSize:18, fontWeight:700, color:"var(--text)" }}>Lid va Konversiya</span>
            <div style={{ display:"flex", background:"var(--bg3)", border:"1px solid var(--border)", borderRadius:8, padding:3, gap:2 }}>
              {CONV_DIMS.map((d) => (
                <button
                  key={d.key}
                  onClick={() => { setConvDim(d.key); setSelectedRespConv(null); }}
                  style={{
                    border:"none", borderRadius:6, fontSize:11.5, fontWeight:600,
                    padding:"5px 12px", cursor:"pointer", transition:"all 0.2s",
                    background: convDim === d.key ? "#2196F3" : "transparent",
                    color:      convDim === d.key ? "#fff"    : "var(--text2)",
                  }}
                >
                  {d.tab}
                </button>
              ))}
            </div>
          </div>

          {conversionQ.isLoading ? (
            <div style={{ padding:24, color:"#666", fontSize:13 }}>Yuklanmoqda…</div>
          ) : (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", tableLayout:"fixed" }}>
                <colgroup>
                  <col style={{ width:44 }} />
                  <col style={{ width:200 }} />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col style={{ width:80 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={TH("#555", 44)}>#</th>
                    <th style={TH("#9E9E9E", 200)}>
                      {CONV_DIMS.find((d) => d.key === convDim)?.label ?? "Menejer"}
                    </th>
                    <th style={TH("#2196F3")}>Jami Lid</th>
                    <th style={TH("#FF9800")}>Jarayonda</th>
                    <th style={TH("#00BCD4")}>Sifatli Lid</th>
                    <th style={TH("#F44336")}>Sifatsiz Lid</th>
                    <th style={TH("#FFC107")}>Bekor Bo'ldi</th>
                    <th style={TH("#4CAF50")}>Konsultatsiya O'tkazildi</th>
                    <th style={{ ...TH("#4CAF50", 80), textAlign:"center" }}>Konversiya</th>
                  </tr>
                </thead>
                <tbody>
                  {convRows.map((r, i) => {
                    const konv = (r.sifatli_lid ?? 0) > 0 ? (r.tashrif_buyurdi / (r.sifatli_lid ?? 0)) * 100 : 0;
                    const isSelected = selectedRespConv?.id === r.key;
                    const subLeads: ResponsibleLeadRow[] = isSelected ? (respLeadsConvQ.data ?? []) : [];
                    const STAGE_MAP_INLINE: Record<string, { label: string; color: string }> = {
                      NEW:               { label: "Yangi lid",          color: "#2196F3" },
                      IN_PROCESS:        { label: "Yangi lid",          color: "#2196F3" },
                      PROCESSED:         { label: "Propushenniy",       color: "#9E9E9E" },
                      UC_1KPATX:         { label: "Javob bermadi",      color: "#FF9800" },
                      NO_ANSWER:         { label: "Javob bermadi",      color: "#FF9800" },
                      UC_Q2U9EL:         { label: "Qayta aloqa",        color: "#00BCD4" },
                      CALLBACK:          { label: "Qayta aloqa",        color: "#00BCD4" },
                      UC_KXC3ZW:         { label: "O'ylab ko'radi",     color: "#E91E63" },
                      THINKING:          { label: "O'ylab ko'radi",     color: "#E91E63" },
                      UC_L28G68:         { label: "Tashrif belgilandi", color: "#9C27B0" },
                      CONSULTATION:      { label: "Tashrif belgilandi", color: "#9C27B0" },
                      UC_5G8244:         { label: "Kelmadi",            color: "#FF00FF" },
                      NOT_TRANSFERRED:   { label: "Kelmadi",            color: "#FF00FF" },
                      JUNK:              { label: "Sandiq",             color: "#42A5F5" },
                      ARCHIVE:           { label: "Sandiq",             color: "#42A5F5" },
                      UC_F8K4GI:         { label: "Sifatsiz",           color: "#F44336" },
                      UC_NAZK5J:         { label: "Bekor bo'ldi",       color: "#FFC107" },
                      RECYCLED:          { label: "Bekor bo'ldi",       color: "#FFC107" },
                      CONVERTED_CONSULT: { label: "Tashrif buyurdi",    color: "#4CAF50" },
                      CONVERTED:         { label: "Tashrif buyurdi",    color: "#4CAF50" },
                    };
                    return (
                      <>
                        <tr key={r.key}
                            style={{ background: isSelected ? "rgba(33,150,243,0.08)" : i % 2 === 0 ? "transparent" : "var(--bg)", cursor:"pointer" }}
                            onClick={() => setSelectedRespConv(isSelected ? null : { id: r.key, name: r.name || r.key })}
                            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg3)")}
                            onMouseLeave={(e) => (e.currentTarget.style.background = isSelected ? "rgba(33,150,243,0.08)" : i % 2 === 0 ? "transparent" : "var(--bg)")}>
                          <td style={{ ...TD, color:"#555", fontSize:13, fontWeight:600, width:44 }}>
                            {String(i + 1).padStart(2, "0")}
                          </td>
                          <td style={{ ...TD, width:200 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                              {/* Avatar only makes sense when the group IS a person */}
                              {convDim === "manager" && <AvatarCircle name={r.name || "?"} size={34} />}
                              <span
                                title={r.name}
                                style={{ fontSize:13, color: isSelected ? "#2196F3" : r.key === "—" ? "var(--text3)" : "var(--text)", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                              >
                                {r.name}
                              </span>
                            </div>
                          </td>
                          <td style={TD}>
                            <span style={{ fontSize:15, fontWeight:600, color:"var(--text)" }}>{fmtNum(r.total)}</span>
                            <MiniBar value={r.total} max={convMax.total} color="#2196F3" />
                          </td>
                          <td style={TD}>
                            <span style={{ fontSize:15, fontWeight:600, color:"var(--text)" }}>{fmtNum(r.jarayonda)}</span>
                            <MiniBar value={r.jarayonda} max={convMax.jarayonda} color="#FF9800" />
                          </td>
                          <td style={TD}>
                            <span style={{ fontSize:15, fontWeight:600, color:"var(--text)" }}>{fmtNum(r.sifatli_lid ?? 0)}</span>
                            <MiniBar value={r.sifatli_lid ?? 0} max={convMax.sifatli} color="#00BCD4" />
                          </td>
                          <td style={TD}>
                            <span style={{ fontSize:15, fontWeight:600, color:"var(--text)" }}>{fmtNum(r.sifatsiz_lid)}</span>
                            <MiniBar value={r.sifatsiz_lid} max={convMax.sifatsiz} color="#F44336" />
                          </td>
                          <td style={TD}>
                            <span style={{ fontSize:15, fontWeight:600, color:"var(--text)" }}>{fmtNum(r.bekor_boldi ?? 0)}</span>
                            <MiniBar value={r.bekor_boldi ?? 0} max={convMax.bekor} color="#FFC107" />
                          </td>
                          <td style={TD}>
                            <span style={{ fontSize:15, fontWeight:600, color:"var(--text)" }}>{fmtNum(r.tashrif_buyurdi)}</span>
                            <MiniBar value={r.tashrif_buyurdi} max={convMax.otkazildi} color="#4CAF50" />
                          </td>
                          <td style={{ ...TD, textAlign:"center" }}>
                            <ConversionDonut pct={konv} size={38} />
                          </td>
                        </tr>
                        {isSelected && (
                          <tr key={`sub-${r.key}`}>
                            <td colSpan={8} style={{ padding: 0, background: "rgba(33,150,243,0.04)", borderBottom: "1px solid var(--border)" }}>
                              {respLeadsConvQ.isLoading ? (
                                <div style={{ padding: "14px 20px", color: "#666", fontSize: 13 }}>Yuklanmoqda…</div>
                              ) : subLeads.length === 0 ? (
                                <div style={{ padding: "14px 20px", color: "#555", fontSize: 13 }}>Ma'lumot yo'q</div>
                              ) : (
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                  <thead>
                                    <tr style={{ background: "rgba(33,150,243,0.06)" }}>
                                      <th style={{ ...TH("#555", 40), paddingLeft: 32 }}>#</th>
                                      <th style={TH("#9E9E9E", 260)}>LID</th>
                                      <th style={TH("#2196F3", 90)}>SANA</th>
                                      <th style={TH("#9C27B0", 130)}>TASHRIF SANASI</th>
                                      <th style={TH("#FF9800", 190)}>BOSQICH</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {subLeads.map((lead, li) => {
                                      const stage = STAGE_MAP_INLINE[lead.stage_bid] ?? { label: lead.stage_bid, color: "#9E9E9E" };
                                      return (
                                        <tr key={lead.id} style={{ background: li % 2 === 0 ? "transparent" : "rgba(0,0,0,0.15)" }}>
                                          <td style={{ ...TD, color: "#555", fontSize: 12, paddingLeft: 32 }}>
                                            {String(li + 1).padStart(2, "0")}
                                          </td>
                                          <td style={{ ...TD, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            <a href={`https://mountain.bitrix24.kz/crm/lead/details/${lead.id}/`}
                                               target="_blank" rel="noopener noreferrer"
                                               style={{ fontSize: 12, color: "#2196F3", textDecoration: "underline" }}>
                                              {lead.title || `Lid #${lead.id}`}
                                            </a>
                                          </td>
                                          <td style={{ ...TD, fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap" }}>
                                            {lead.date_create ? new Date(lead.date_create).toLocaleDateString("uz-UZ", { day:"2-digit", month:"2-digit", year:"numeric" }) : "—"}
                                          </td>
                                          <td style={{ ...TD, fontSize: 12, color: lead.tashrif_sanasi ? "#9C27B0" : "#333", whiteSpace: "nowrap" }}>
                                            {lead.tashrif_sanasi ? new Date(lead.tashrif_sanasi).toLocaleDateString("uz-UZ", { day:"2-digit", month:"2-digit", year:"numeric" }) : "—"}
                                          </td>
                                          <td style={TD}>
                                            <span style={{
                                              display: "inline-block", padding: "3px 10px", borderRadius: 20,
                                              fontSize: 11, fontWeight: 600,
                                              background: `${stage.color}22`, border: `1px solid ${stage.color}55`, color: stage.color,
                                              whiteSpace: "nowrap",
                                            }}>
                                              {stage.label}
                                            </span>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    <tr style={{ background: "rgba(33,150,243,0.06)", borderTop: "1px solid var(--border2)" }}>
                                      <td style={{ ...TD, paddingLeft: 32, color: "#666" }} />
                                      <td style={{ ...TD, fontSize: 12, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>JAMI</td>
                                      <td colSpan={3} style={{ ...TD, fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{subLeads.length} ta lid</td>
                                    </tr>
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}

                  {/* JAMI row */}
                  <tr style={{ background:"var(--bg3)", borderTop:"1px solid var(--border2)" }}>
                    <td style={{ ...TD, color:"var(--text3)" }} />
                    <td style={{ ...TD, fontSize:13, fontWeight:700, color:"var(--text3)", textTransform:"uppercase", letterSpacing:"0.06em" }}>
                      JAMI
                    </td>
                    <td style={TD}>
                      <span style={{ fontSize:16, fontWeight:700, color:"var(--text)" }}>{fmtNum(convTotals.total)}</span>
                      <MiniBar value={1} max={1} color="#2196F3" />
                    </td>
                    <td style={TD}>
                      <span style={{ fontSize:16, fontWeight:700, color:"var(--text)" }}>{fmtNum(convTotals.jarayonda)}</span>
                      <MiniBar value={1} max={1} color="#FF9800" />
                    </td>
                    <td style={TD}>
                      <span style={{ fontSize:16, fontWeight:700, color:"var(--text)" }}>{fmtNum(convTotals.sifatli)}</span>
                      <MiniBar value={1} max={1} color="#00BCD4" />
                    </td>
                    <td style={TD}>
                      <span style={{ fontSize:16, fontWeight:700, color:"var(--text)" }}>{fmtNum(convTotals.sifatsiz)}</span>
                      <MiniBar value={1} max={1} color="#F44336" />
                    </td>
                    <td style={TD}>
                      <span style={{ fontSize:16, fontWeight:700, color:"var(--text)" }}>{fmtNum(convTotals.bekor)}</span>
                      <MiniBar value={1} max={1} color="#FFC107" />
                    </td>
                    <td style={TD}>
                      <span style={{ fontSize:16, fontWeight:700, color:"var(--text)" }}>{fmtNum(convTotals.otkazildi)}</span>
                      <MiniBar value={1} max={1} color="#4CAF50" />
                    </td>
                    <td style={{ ...TD, textAlign:"center" }}>
                      <ConversionDonut pct={convTotals.sifatli > 0 ? (convTotals.otkazildi / convTotals.sifatli) * 100 : 0} size={38} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════
            Lid mas'ullar kesimida table
        ══════════════════════════════════════════════════════════ */}
        <div style={{ background:"var(--bg2)", borderRadius:12, overflow:"hidden", marginBottom:24 }}>
          <div style={{ padding:"16px 20px 12px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:18, fontWeight:700, color:"var(--text)" }}>Lid mas'ullar kesimida</span>
            <span style={{ fontSize:12, color:"var(--text3)" }}>{byUserFiltered.length} ta xodim</span>
          </div>

          {respQ.isLoading && !responsibles.length ? (
            <div style={{ padding:24, color:"#666", fontSize:13 }}>Yuklanmoqda…</div>
          ) : (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", tableLayout:"auto" }}>
                <thead>
                  <tr>
                    <th style={{ ...TH("#555", 44), position:"sticky", left:0, zIndex:6 }}>#</th>
                    <th style={{ ...TH("#9E9E9E", 180), position:"sticky", left:44, zIndex:6 }}>Mas'ul</th>
                    {RESPONSIBLE_COLS.map((col) => (
                      <th key={col.key} style={TH(col.color)}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {byUserFiltered.map((u, i) => {
                    const isSel = selectedRespMasul?.id === u.responsible_id;
                    const subLeads: ResponsibleLeadRow[] = isSel ? (respLeadsMasulQ.data ?? []) : [];
                    const STAGE_MAP_M: Record<string, { label: string; color: string }> = {
                      NEW: { label: "Yangi lid", color: "#2196F3" },
                      IN_PROCESS: { label: "Yangi lid", color: "#2196F3" },
                      PROCESSED: { label: "Propushenniy", color: "#9E9E9E" },
                      UC_1KPATX: { label: "Javob bermadi", color: "#FF9800" },
                      NO_ANSWER: { label: "Javob bermadi", color: "#FF9800" },
                      UC_Q2U9EL: { label: "Qayta aloqa", color: "#00BCD4" },
                      CALLBACK: { label: "Qayta aloqa", color: "#00BCD4" },
                      UC_KXC3ZW: { label: "O'ylab ko'radi", color: "#E91E63" },
                      THINKING: { label: "O'ylab ko'radi", color: "#E91E63" },
                      UC_L28G68: { label: "Tashrif belgilandi", color: "#9C27B0" },
                      CONSULTATION: { label: "Tashrif belgilandi", color: "#9C27B0" },
                      UC_5G8244: { label: "Kelmadi", color: "#FF00FF" },
                      NOT_TRANSFERRED: { label: "Kelmadi", color: "#FF00FF" },
                      JUNK: { label: "Sandiq", color: "#42A5F5" },
                      ARCHIVE: { label: "Sandiq", color: "#42A5F5" },
                      UC_F8K4GI: { label: "Sifatsiz", color: "#F44336" },
                      UC_NAZK5J: { label: "Bekor bo'ldi", color: "#FFC107" },
                      RECYCLED: { label: "Bekor bo'ldi", color: "#FFC107" },
                      CONVERTED_CONSULT: { label: "Tashrif buyurdi", color: "#4CAF50" },
                      CONVERTED: { label: "Tashrif buyurdi", color: "#4CAF50" },
                    };
                    const colCount = 2 + RESPONSIBLE_COLS.length;
                    return (
                      <>
                        <tr key={u.responsible_id}
                            style={{ background: isSel ? "rgba(33,150,243,0.08)" : i % 2 === 0 ? "transparent" : "var(--bg)", cursor: "pointer" }}
                            onClick={() => setSelectedRespMasul(isSel ? null : { id: u.responsible_id, name: u.full_name || `User ${u.responsible_id}` })}
                            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg3)")}
                            onMouseLeave={(e) => (e.currentTarget.style.background = isSel ? "rgba(33,150,243,0.08)" : i % 2 === 0 ? "transparent" : "var(--bg)")}>
                          <td style={{ ...TD, color:"#555", fontSize:13, fontWeight:600, width:44, position:"sticky", left:0, background:"var(--bg2)" }}>
                            {String(i + 1).padStart(2, "0")}
                          </td>
                          <td style={{ ...TD, width:180, position:"sticky", left:44, background:"var(--bg2)", zIndex:2 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                              <AvatarCircle name={u.full_name || `U${u.responsible_id}`} size={32} />
                              <span style={{ fontSize:13, color: isSel ? "#2196F3" : "var(--text)", fontWeight:500, whiteSpace:"nowrap" }}>
                                {u.full_name || `User ${u.responsible_id}`}
                              </span>
                            </div>
                          </td>
                          {RESPONSIBLE_COLS.map((col) => {
                            const cnt = (u as unknown as Record<string, number>)[col.key] ?? 0;
                            const max = colMaxes[col.key] ?? 1;
                            return (
                              <td key={col.key} style={{ ...TD, minWidth:90 }}>
                                {cnt > 0 ? (
                                  <>
                                    <span style={{ fontSize:13, color:"var(--text)" }}>{fmtNum(cnt)}</span>
                                    <MiniBar value={cnt} max={max} color={col.color} height={3} />
                                  </>
                                ) : (
                                  <span style={{ fontSize:13, color:"var(--text3)" }}>—</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                        {isSel && (
                          <tr key={`sub-masul-${u.responsible_id}`}>
                            <td colSpan={colCount} style={{ padding: 0, background: "rgba(33,150,243,0.04)", borderBottom: "1px solid var(--border)" }}>
                              {respLeadsMasulQ.isLoading ? (
                                <div style={{ padding: "14px 20px", color: "#666", fontSize: 13 }}>Yuklanmoqda…</div>
                              ) : subLeads.length === 0 ? (
                                <div style={{ padding: "14px 20px", color: "#555", fontSize: 13 }}>Ma'lumot yo'q</div>
                              ) : (
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                  <thead>
                                    <tr style={{ background: "rgba(33,150,243,0.06)" }}>
                                      <th style={{ ...TH("#555", 40), paddingLeft: 32 }}>#</th>
                                      <th style={TH("#9E9E9E", 260)}>LID</th>
                                      <th style={TH("#2196F3", 90)}>SANA</th>
                                      <th style={TH("#9C27B0", 130)}>TASHRIF SANASI</th>
                                      <th style={TH("#FF9800", 190)}>BOSQICH</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {subLeads.map((lead, li) => {
                                      const stage = STAGE_MAP_M[lead.stage_bid] ?? { label: lead.stage_bid, color: "#9E9E9E" };
                                      return (
                                        <tr key={lead.id} style={{ background: li % 2 === 0 ? "transparent" : "rgba(0,0,0,0.15)" }}>
                                          <td style={{ ...TD, color: "#555", fontSize: 12, paddingLeft: 32 }}>
                                            {String(li + 1).padStart(2, "0")}
                                          </td>
                                          <td style={{ ...TD, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            <a href={`https://mountain.bitrix24.kz/crm/lead/details/${lead.id}/`}
                                               target="_blank" rel="noopener noreferrer"
                                               style={{ fontSize: 12, color: "#2196F3", textDecoration: "underline" }}>
                                              {lead.title || `Lid #${lead.id}`}
                                            </a>
                                          </td>
                                          <td style={{ ...TD, fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap" }}>
                                            {lead.date_create ? new Date(lead.date_create).toLocaleDateString("uz-UZ", { day:"2-digit", month:"2-digit", year:"numeric" }) : "—"}
                                          </td>
                                          <td style={{ ...TD, fontSize: 12, color: lead.tashrif_sanasi ? "#9C27B0" : "#333", whiteSpace: "nowrap" }}>
                                            {lead.tashrif_sanasi ? new Date(lead.tashrif_sanasi).toLocaleDateString("uz-UZ", { day:"2-digit", month:"2-digit", year:"numeric" }) : "—"}
                                          </td>
                                          <td style={TD}>
                                            <span style={{
                                              display: "inline-block", padding: "3px 10px", borderRadius: 20,
                                              fontSize: 11, fontWeight: 600,
                                              background: `${stage.color}22`, border: `1px solid ${stage.color}55`, color: stage.color,
                                              whiteSpace: "nowrap",
                                            }}>
                                              {stage.label}
                                            </span>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    <tr style={{ background: "rgba(33,150,243,0.06)", borderTop: "1px solid var(--border2)" }}>
                                      <td style={{ ...TD, paddingLeft: 32, color: "#666" }} />
                                      <td style={{ ...TD, fontSize: 12, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>JAMI</td>
                                      <td colSpan={3} style={{ ...TD, fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{subLeads.length} ta lid</td>
                                    </tr>
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}

                  {/* JAMI row */}
                  <tr style={{ background:"var(--bg3)", borderTop:"1px solid var(--border2)" }}>
                    <td style={{ ...TD, position:"sticky", left:0, background:"var(--bg3)" }} />
                    <td style={{ ...TD, fontSize:13, fontWeight:700, color:"var(--text3)", textTransform:"uppercase", letterSpacing:"0.06em", position:"sticky", left:44, background:"var(--bg3)", zIndex:2 }}>
                      JAMI
                    </td>
                    {RESPONSIBLE_COLS.map((col) => (
                      <td key={col.key} style={TD}>
                        <span style={{ fontSize:13, fontWeight:700, color:"var(--text)" }}>{fmtNum(totalsRow[col.key] ?? 0)}</span>
                        <MiniBar value={1} max={1} color={col.color} height={3} />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

        </div>

        {/* ══════════════════════════════════════════════════════════
            Vazifalar kesimida table
        ══════════════════════════════════════════════════════════ */}
        {(() => {
          const taskRows = (tasksQ.data?.tasks ?? []).map((r) => ({
            ...r,
            total:          parseInt(String(r.total),          10) || 0,
            in_progress:    parseInt(String(r.in_progress),    10) || 0,
            completed:      parseInt(String(r.completed),      10) || 0,
            overdue:        parseInt(String(r.overdue),        10) || 0,
            completed_late: parseInt(String(r.completed_late), 10) || 0,
          }));
          const taskMax = {
            total:          Math.max(1, ...taskRows.map((r) => r.total)),
            in_progress:    Math.max(1, ...taskRows.map((r) => r.in_progress)),
            completed:      Math.max(1, ...taskRows.map((r) => r.completed)),
            overdue:        Math.max(1, ...taskRows.map((r) => r.overdue)),
            completed_late: Math.max(1, ...taskRows.map((r) => r.completed_late)),
          };
          const taskTotals = taskRows.reduce(
            (acc, r) => ({
              total:          acc.total          + r.total,
              in_progress:    acc.in_progress    + r.in_progress,
              completed:      acc.completed      + r.completed,
              overdue:        acc.overdue        + r.overdue,
              completed_late: acc.completed_late + r.completed_late,
            }),
            { total: 0, in_progress: 0, completed: 0, overdue: 0, completed_late: 0 }
          );
          return (
            <div style={{ background: "var(--bg2)", borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
              <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>Vazifalar kesimida</span>
                <span style={{ fontSize: 12, color: "var(--text3)" }}>{taskRows.length} ta xodim</span>
              </div>

              {tasksQ.isLoading ? (
                <div style={{ padding: 24, color: "#666", fontSize: 13 }}>Yuklanmoqda…</div>
              ) : taskRows.length === 0 ? (
                <div style={{ padding: 24, color: "#555", fontSize: 13 }}>Vazifalar topilmadi</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                    <colgroup>
                      <col style={{ width: 44 }} />
                      <col style={{ width: 200 }} />
                      <col />
                      <col />
                      <col />
                      <col />
                      <col />
                      <col style={{ width: 90 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={TH("#555", 44)}>#</th>
                        <th style={TH("#9E9E9E", 200)}>Mas'ul</th>
                        <th style={TH("#9E9E9E")}>Jami Vazifalar</th>
                        <th style={TH("#FF9800")}>Jarayondagi</th>
                        <th style={TH("#4CAF50")}>Tugatilgan</th>
                        <th style={TH("#F44336")}>Muddati O'tgan</th>
                        <th style={TH("#FF5722")}>Muddati O'tib Bajarilgan</th>
                        <th style={{ ...TH("#2196F3", 90), textAlign: "center" }}>Bajarilish</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskRows.map((r, i) => {
                        const pct = r.total > 0 ? (r.completed / r.total) * 100 : 0;
                        return (
                          <tr key={r.responsible_id}
                              style={{ background: i % 2 === 0 ? "transparent" : "var(--bg)" }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg3)")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "var(--bg)")}>
                            <td style={{ ...TD, color: "#555", fontSize: 13, fontWeight: 600, width: 44 }}>
                              {String(i + 1).padStart(2, "0")}
                            </td>
                            <td style={{ ...TD, width: 200 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <AvatarCircle name={r.full_name || "?"} size={34} />
                                <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {r.full_name}
                                </span>
                              </div>
                            </td>
                            <td style={TD}>
                              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{fmtNum(r.total)}</span>
                              <MiniBar value={r.total} max={taskMax.total} color="#9E9E9E" />
                            </td>
                            <td style={TD}>
                              {r.in_progress > 0 ? (
                                <>
                                  <span style={{ fontSize: 14, color: "var(--text)" }}>{fmtNum(r.in_progress)}</span>
                                  <MiniBar value={r.in_progress} max={taskMax.in_progress} color="#FF9800" />
                                </>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={TD}>
                              {r.completed > 0 ? (
                                <>
                                  <span style={{ fontSize: 14, color: "var(--text)" }}>{fmtNum(r.completed)}</span>
                                  <MiniBar value={r.completed} max={taskMax.completed} color="#4CAF50" />
                                </>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={TD}>
                              {r.overdue > 0 ? (
                                <>
                                  <span style={{ fontSize: 14, color: "#F44336" }}>{fmtNum(r.overdue)}</span>
                                  <MiniBar value={r.overdue} max={taskMax.overdue} color="#F44336" />
                                </>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={TD}>
                              {r.completed_late > 0 ? (
                                <>
                                  <span style={{ fontSize: 14, color: "#FF5722" }}>{fmtNum(r.completed_late)}</span>
                                  <MiniBar value={r.completed_late} max={taskMax.completed_late} color="#FF5722" />
                                </>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={{ ...TD, textAlign: "center" }}>
                              <ConversionDonut pct={pct} size={38} />
                            </td>
                          </tr>
                        );
                      })}

                      {/* JAMI row */}
                      <tr style={{ background: "var(--bg3)", borderTop: "1px solid var(--border2)" }}>
                        <td style={{ ...TD, color: "var(--text3)" }} />
                        <td style={{ ...TD, fontSize: 13, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          JAMI
                        </td>
                        <td style={TD}>
                          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{fmtNum(taskTotals.total)}</span>
                          <MiniBar value={1} max={1} color="#9E9E9E" />
                        </td>
                        <td style={TD}>
                          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{fmtNum(taskTotals.in_progress)}</span>
                          <MiniBar value={1} max={1} color="#FF9800" />
                        </td>
                        <td style={TD}>
                          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{fmtNum(taskTotals.completed)}</span>
                          <MiniBar value={1} max={1} color="#4CAF50" />
                        </td>
                        <td style={TD}>
                          <span style={{ fontSize: 16, fontWeight: 700, color: taskTotals.overdue > 0 ? "#F44336" : "var(--text)" }}>
                            {fmtNum(taskTotals.overdue)}
                          </span>
                          <MiniBar value={1} max={1} color="#F44336" />
                        </td>
                        <td style={TD}>
                          <span style={{ fontSize: 16, fontWeight: 700, color: taskTotals.completed_late > 0 ? "#FF5722" : "var(--text)" }}>
                            {fmtNum(taskTotals.completed_late)}
                          </span>
                          <MiniBar value={1} max={1} color="#FF5722" />
                        </td>
                        <td style={{ ...TD, textAlign: "center" }}>
                          <ConversionDonut pct={taskTotals.total > 0 ? (taskTotals.completed / taskTotals.total) * 100 : 0} size={38} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}

        {/* ══════════════════════════════════════════════════════════
            Bekor bo'lish va Sifatsiz sabablari (side-by-side)
        ══════════════════════════════════════════════════════════ */}
        {(() => {
          const cancelItems = (cancelQ.data?.items ?? []).map((r) => ({
            ...r,
            total: parseInt(String(r.total), 10) || 0,
          }));
          const junkItems = (junkQ.data?.items ?? []).map((r) => ({
            ...r,
            total: parseInt(String(r.total), 10) || 0,
          }));
          const cancelMax   = Math.max(1, ...cancelItems.map((r) => r.total));
          const junkMax     = Math.max(1, ...junkItems.map((r) => r.total));
          const cancelTotal = cancelItems.reduce((s, r) => s + r.total, 0);
          const junkTotal   = junkItems.reduce((s, r) => s + r.total, 0);

          const renderTable = (
            title: string,
            items: { reason: string; total: number }[],
            max: number,
            grandTotal: number,
            barColor: string,
            loading: boolean,
            stageId: string,
          ) => (
            <div style={{ background: "var(--bg2)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{
                padding: "14px 20px 12px",
                borderBottom: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{title}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: barColor }}>{fmtNum(grandTotal)}</span>
                  <a href={`https://mountain.bitrix24.kz/crm/lead/list/?set_filter=Y&STATUS_ID%5B0%5D=${stageId}`}
                     target="_blank" rel="noopener noreferrer"
                     style={{ fontSize: 11, color: "#2196F3", background: "rgba(33,150,243,0.1)", border: "1px solid rgba(33,150,243,0.3)", borderRadius: 6, padding: "3px 8px", textDecoration: "none", whiteSpace: "nowrap" }}>
                    Bitrix24 ↗
                  </a>
                </div>
              </div>
              {loading ? (
                <div style={{ padding: 24, color: "var(--text3)", fontSize: 13 }}>Yuklanmoqda…</div>
              ) : items.length === 0 ? (
                <div style={{ padding: 24, color: "var(--text3)", fontSize: 13 }}>Ma'lumot yo'q</div>
              ) : (
                <div style={{ padding: "6px 0 10px" }}>
                  {items.map((r, i) => (
                    <div key={i} style={{ padding: "7px 20px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                        <span style={{ fontSize: 12, color: "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                          {r.reason}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                            {fmtNum(r.total)}
                          </span>
                          <a href={`https://mountain.bitrix24.kz/crm/lead/list/?set_filter=Y&STATUS_ID%5B0%5D=${stageId}`}
                             target="_blank" rel="noopener noreferrer"
                             style={{ fontSize: 10, color: "#2196F3", background: "rgba(33,150,243,0.08)", border: "1px solid rgba(33,150,243,0.25)", borderRadius: 4, padding: "2px 6px", textDecoration: "none" }}>
                            ↗
                          </a>
                        </div>
                      </div>
                      <div style={{ height: 4, borderRadius: 2, background: "var(--bg4)", overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: `${(r.total / max) * 100}%`,
                          background: barColor,
                          borderRadius: 2,
                          transition: "width 0.3s",
                        }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );

          return (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
              {renderTable("Bekor bo'lish sabablari", cancelItems, cancelMax, cancelTotal, "#FFC107", cancelQ.isLoading, "UC_NAZK5J")}
              {renderTable("Sifatsiz sabablari",       junkItems,   junkMax,   junkTotal,   "#F44336", junkQ.isLoading,   "UC_F8K4GI")}
            </div>
          );
        })()}

        {/* ══════════════════════════════════════════════════════════
            UTM bo'yicha — single table, 6-level breadcrumb navigation
        ══════════════════════════════════════════════════════════ */}
        {(() => {
          const UTM_COL_LABELS   = ["UTM MANBA", "UTM MEDIUM", "KAMPANIYA", "AD SET (CONTENT)", "REKLAMA (TERM)", "MAS'UL"];
          const UTM_COUNT_LABELS = ["manba", "medium", "kampaniya", "ad set", "reklama", "mas'ul"];

          const utmRowsAll: Record<number, any[]> = {
            0: utmStatsQ.data ?? [],
            1: utmMediumQ.data ?? [],
            2: utmCampaignQ.data ?? [],
            3: utmContentQ.data ?? [],
            4: utmTermQ.data ?? [],
            5: utmRespQ.data ?? [],
          };
          const utmLoadingAll: Record<number, boolean> = {
            0: utmStatsQ.isLoading,
            1: utmMediumQ.isLoading,
            2: utmCampaignQ.isLoading,
            3: utmContentQ.isLoading,
            4: utmTermQ.isLoading,
            5: utmRespQ.isLoading,
          };
          const utmNameKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "full_name"];

          const rows    = utmRowsAll[utmLevel];
          const loading = utmLoadingAll[utmLevel];
          const nameKey = utmNameKeys[utmLevel];

          const maxes: Record<string, number> = {};
          for (const c of UTM_COLS_DEF)
            maxes[c.key] = Math.max(1, ...rows.map((r: any) => Number(r[c.key]) || 0));
          const totals = rows.reduce((acc: Record<string, number>, r: any) => {
            for (const c of UTM_COLS_DEF) acc[c.key] = (acc[c.key] || 0) + (Number(r[c.key]) || 0);
            return acc;
          }, {} as Record<string, number>);

          const breadcrumbVals: (string | undefined)[] = [
            undefined, utmPath.source, utmPath.medium, utmPath.campaign, utmPath.content, utmPath.term,
          ];

          const goTo = (targetLevel: number) => {
            if (targetLevel === 0) setUtmPath({});
            else if (targetLevel === 1) setUtmPath({ source: utmPath.source });
            else if (targetLevel === 2) setUtmPath({ source: utmPath.source, medium: utmPath.medium });
            else if (targetLevel === 3) setUtmPath({ source: utmPath.source, medium: utmPath.medium, campaign: utmPath.campaign });
            else if (targetLevel === 4) setUtmPath({ source: utmPath.source, medium: utmPath.medium, campaign: utmPath.campaign, content: utmPath.content });
          };

          const handleRowClick = (row: any) => {
            const rawVal = row[nameKey];
            const val = rawVal === 'Nomalum' ? '' : (rawVal ?? '');
            if (utmLevel === 0) setUtmPath({ source: row.utm_source });
            else if (utmLevel === 1) setUtmPath({ ...utmPath, medium: val });
            else if (utmLevel === 2) setUtmPath({ ...utmPath, campaign: val });
            else if (utmLevel === 3) setUtmPath({ ...utmPath, content: val });
            else if (utmLevel === 4) setUtmPath({ ...utmPath, term: val });
          };

          return (
            <div style={{ background: "var(--bg2)", borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
              {/* Breadcrumb header */}
              <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                {Array.from({ length: utmLevel + 1 }, (_, lv) => (
                  <span key={lv} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {lv > 0 && <span style={{ color: "#444", fontSize: 13, padding: "0 2px" }}>/</span>}
                    <span
                      style={{
                        fontSize: lv === utmLevel ? 15 : 13,
                        fontWeight: lv === utmLevel ? 700 : 500,
                        color: lv < utmLevel ? "#2196F3" : "var(--text)",
                        cursor: lv < utmLevel ? "pointer" : "default",
                        whiteSpace: "nowrap",
                        textDecoration: lv < utmLevel ? "underline" : "none",
                      }}
                      onClick={() => lv < utmLevel && goTo(lv)}
                    >
                      {lv === 0 ? "UTM bo'yicha" : (breadcrumbVals[lv] || '(bo\'sh)')}
                    </span>
                  </span>
                ))}
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#555", flexShrink: 0 }}>
                  {loading ? "..." : `${rows.length} ta ${UTM_COUNT_LABELS[utmLevel]}`}
                </span>
              </div>

              {/* Table */}
              {loading ? (
                <div style={{ padding: 24, color: "#666", fontSize: 13 }}>Yuklanmoqda…</div>
              ) : rows.length === 0 ? (
                <div style={{ padding: 24, color: "#555", fontSize: 13 }}>Ma'lumot yo'q</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
                    <thead>
                      <tr>
                        <th style={TH("#9E9E9E", 220)}>{UTM_COL_LABELS[utmLevel]}</th>
                        {UTM_COLS_DEF.map(c => <th key={c.key} style={TH(c.color)}>{c.label}</th>)}
                        <th style={{ ...TH("#4CAF50", 80), textAlign: "center" }}>KONVERSIYA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r: any, i: number) => {
                        const rawName  = String(r[nameKey] ?? '—');
                        const displayName = utmLevel === 0
                          ? (UTM_SOURCE_DISPLAY_NAMES[rawName] ?? rawName)
                          : rawName;
                        const isClickable = utmLevel < 5;
                        const konv = (Number(r.umumiy_lidlar) || 0) > 0
                          ? ((Number(r.konsultatsiya_otkazildi) || 0) / (Number(r.umumiy_lidlar) || 1)) * 100 : 0;
                        const subCount = Number(r.campaign_count || r.responsible_count || 0);
                        const subLabel = ["kampaniya", "kampaniya", "mas'ul", "mas'ul", "mas'ul", ""][utmLevel];
                        return (
                          <tr key={rawName + i}
                              style={{ background: i % 2 === 0 ? "transparent" : "var(--bg)", cursor: isClickable ? "pointer" : "default" }}
                              onClick={() => isClickable && handleRowClick(r)}
                              onMouseEnter={e => { if (isClickable) e.currentTarget.style.background = "var(--bg3)"; }}
                              onMouseLeave={e => { if (isClickable) e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "var(--bg)"; }}>
                            <td style={{ ...TD, fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {isClickable && <ChevronDown size={13} style={{ color: "#9E9E9E", flexShrink: 0 }} />}
                                <span style={{ color: isClickable ? "#2196F3" : "var(--text)" }}>{displayName || "(bo'sh)"}</span>
                                {subCount > 0 && (
                                  <span style={{ fontSize: 10, background: "rgba(33,150,243,0.1)", color: "#2196F3", borderRadius: 8, padding: "1px 6px", flexShrink: 0 }}>
                                    {subCount} {subLabel}
                                  </span>
                                )}
                              </div>
                            </td>
                            {UTM_COLS_DEF.map(c => {
                              const val = Number(r[c.key]) || 0;
                              return (
                                <td key={c.key} style={TD}>
                                  {val > 0 ? (
                                    <><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtNum(val)}</span><MiniBar value={val} max={maxes[c.key]} color={c.color} /></>
                                  ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                                </td>
                              );
                            })}
                            <td style={{ ...TD, textAlign: "center" }}><ConversionDonut pct={konv} size={38} /></td>
                          </tr>
                        );
                      })}
                      <tr style={{ background: "var(--bg3)", borderTop: "1px solid var(--border2)" }}>
                        <td style={{ ...TD, fontSize: 13, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>JAMI</td>
                        {UTM_COLS_DEF.map(c => (
                          <td key={c.key} style={TD}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{fmtNum(totals[c.key] || 0)}</span>
                            <MiniBar value={1} max={1} color={c.color} />
                          </td>
                        ))}
                        <td style={{ ...TD, textAlign: "center" }}>
                          <ConversionDonut pct={(totals.umumiy_lidlar || 0) > 0 ? ((totals.konsultatsiya_otkazildi || 0) / (totals.umumiy_lidlar || 0)) * 100 : 0} size={38} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}

        {/* ══════════════════════════════════════════════════════════
            Manba bo'yicha table
        ══════════════════════════════════════════════════════════ */}
        {(() => {
          const srcRows: SourceStatsRow[] = sourceQ.data ?? [];
          const srcMaxes = {
            umumiy:   Math.max(1, ...srcRows.map(r => r.umumiy_lidlar)),
            sifatli:  Math.max(1, ...srcRows.map(r => r.sifatli_lid)),
            konsB:    Math.max(1, ...srcRows.map(r => r.konsultatsiya_belgilandi)),
            konsO:    Math.max(1, ...srcRows.map(r => r.konsultatsiya_otkazildi)),
            sifatsiz: Math.max(1, ...srcRows.map(r => r.sifatsiz)),
            bekor:    Math.max(1, ...srcRows.map(r => r.bekor_boldi)),
          };
          const srcTotals = srcRows.reduce(
            (acc, r) => ({
              umumiy:   acc.umumiy   + r.umumiy_lidlar,
              sifatli:  acc.sifatli  + r.sifatli_lid,
              konsB:    acc.konsB    + r.konsultatsiya_belgilandi,
              konsO:    acc.konsO    + r.konsultatsiya_otkazildi,
              sifatsiz: acc.sifatsiz + r.sifatsiz,
              bekor:    acc.bekor    + r.bekor_boldi,
            }),
            { umumiy: 0, sifatli: 0, konsB: 0, konsO: 0, sifatsiz: 0, bekor: 0 }
          );
          return (
            <div style={{ background: "var(--bg2)", borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>Manba bo'yicha</span>
                <span style={{ fontSize: 12, color: "var(--text3)" }}>{srcRows.length} ta manba</span>
              </div>
              {sourceQ.isLoading ? (
                <div style={{ padding: 24, color: "#666", fontSize: 13 }}>Yuklanmoqda…</div>
              ) : srcRows.length === 0 ? (
                <div style={{ padding: 24, color: "#555", fontSize: 13 }}>Ma'lumot yo'q</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
                    <thead>
                      <tr>
                        <th style={TH("#9E9E9E", 180)}>MANBA</th>
                        <th style={TH("#2196F3")}>UMUMIY LIDLAR</th>
                        <th style={TH("#00BCD4")}>SIFATLI LID</th>
                        <th style={TH("#9C27B0")}>KONS. BELGILANDI</th>
                        <th style={TH("#4CAF50")}>KONS. O'TKAZILDI</th>
                        <th style={TH("#F44336")}>SIFATSIZ</th>
                        <th style={TH("#FFC107")}>BEKOR BO'LDI</th>
                        <th style={{ ...TH("#4CAF50", 80), textAlign: "center" }}>KONVERSIYA</th>
                        <th style={{ ...TH("#00BCD4", 80), textAlign: "center" }}>SIFATLI KON.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {srcRows.map((r, i) => {
                        const konv      = r.umumiy_lidlar > 0 ? (r.konsultatsiya_otkazildi / r.umumiy_lidlar) * 100 : 0;
                        const sifatliKonv = r.umumiy_lidlar > 0 ? (r.sifatli_lid / r.umumiy_lidlar) * 100 : 0;
                        return (
                          <tr key={r.source_id}
                              style={{ background: i % 2 === 0 ? "transparent" : "var(--bg)" }}
                              onMouseEnter={e => (e.currentTarget.style.background = "var(--bg3)")}
                              onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "var(--bg)")}>
                            <td style={{ ...TD, fontWeight: 600, color: "var(--text)", fontSize: 13, whiteSpace: "nowrap" }}>
                              {r.source_name}
                            </td>
                            <td style={TD}>
                              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtNum(r.umumiy_lidlar)}</span>
                              <MiniBar value={r.umumiy_lidlar} max={srcMaxes.umumiy} color="#2196F3" />
                            </td>
                            <td style={TD}>
                              {r.sifatli_lid > 0 ? (
                                <><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtNum(r.sifatli_lid)}</span><MiniBar value={r.sifatli_lid} max={srcMaxes.sifatli} color="#00BCD4" /></>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={TD}>
                              {r.konsultatsiya_belgilandi > 0 ? (
                                <><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtNum(r.konsultatsiya_belgilandi)}</span><MiniBar value={r.konsultatsiya_belgilandi} max={srcMaxes.konsB} color="#9C27B0" /></>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={TD}>
                              {r.konsultatsiya_otkazildi > 0 ? (
                                <><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtNum(r.konsultatsiya_otkazildi)}</span><MiniBar value={r.konsultatsiya_otkazildi} max={srcMaxes.konsO} color="#4CAF50" /></>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={TD}>
                              {r.sifatsiz > 0 ? (
                                <><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtNum(r.sifatsiz)}</span><MiniBar value={r.sifatsiz} max={srcMaxes.sifatsiz} color="#F44336" /></>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={TD}>
                              {r.bekor_boldi > 0 ? (
                                <><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtNum(r.bekor_boldi)}</span><MiniBar value={r.bekor_boldi} max={srcMaxes.bekor} color="#FFC107" /></>
                              ) : <span style={{ fontSize: 13, color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={{ ...TD, textAlign: "center" }}>
                              <ConversionDonut pct={konv} size={38} />
                            </td>
                            <td style={{ ...TD, textAlign: "center" }}>
                              <ConversionDonut pct={sifatliKonv} size={38} />
                            </td>
                          </tr>
                        );
                      })}
                      {/* JAMI row */}
                      <tr style={{ background: "var(--bg3)", borderTop: "1px solid var(--border2)" }}>
                        <td style={{ ...TD, fontSize: 13, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>JAMI</td>
                        <td style={TD}><span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtNum(srcTotals.umumiy)}</span><MiniBar value={1} max={1} color="#2196F3" /></td>
                        <td style={TD}><span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtNum(srcTotals.sifatli)}</span><MiniBar value={1} max={1} color="#00BCD4" /></td>
                        <td style={TD}><span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtNum(srcTotals.konsB)}</span><MiniBar value={1} max={1} color="#9C27B0" /></td>
                        <td style={TD}><span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtNum(srcTotals.konsO)}</span><MiniBar value={1} max={1} color="#4CAF50" /></td>
                        <td style={TD}><span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtNum(srcTotals.sifatsiz)}</span><MiniBar value={1} max={1} color="#F44336" /></td>
                        <td style={TD}><span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtNum(srcTotals.bekor)}</span><MiniBar value={1} max={1} color="#FFC107" /></td>
                        <td style={{ ...TD, textAlign: "center" }}>
                          <ConversionDonut pct={srcTotals.umumiy > 0 ? (srcTotals.konsO / srcTotals.umumiy) * 100 : 0} size={38} />
                        </td>
                        <td style={{ ...TD, textAlign: "center" }}>
                          <ConversionDonut pct={srcTotals.umumiy > 0 ? (srcTotals.sifatli / srcTotals.umumiy) * 100 : 0} size={38} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}

        {statsQ.error && (
          <div className="p-3 bg-red-bg border border-red-bd text-red rounded-lg text-[12.5px]">
            Xatolik: {(statsQ.error as Error).message}
          </div>
        )}
      </div>
    </>
  );
}
