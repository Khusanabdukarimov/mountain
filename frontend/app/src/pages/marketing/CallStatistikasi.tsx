import { Fragment, useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Phone, PhoneOutgoing, PhoneIncoming, CheckCircle, XCircle,
  Clock, PhoneMissed, Timer, ChevronDown, ChevronUp,
  Download, PhoneOff, Search, Calendar,
} from "lucide-react";
import { DateRangePicker } from "@/components/DateRangePicker";
import { Topbar } from "@/components/Topbar";
import {
  getPyCallStats, getCallList, getCallFilterOptions,
  type CallDashboardFilter,
  type PyCallStatsResult, type PyResponsibleCallStats,
} from "@/lib/api/leads";

// ── Helpers ───────────────────────────────────────────────────────
const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO  = () => localISO(new Date());
const daysAgoISO = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localISO(d); };
const startOfMonthISO = () => { const d = new Date(); d.setDate(1); return localISO(d); };

function fmtDur(secs: number): string {
  if (!secs) return "00:00:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function fmtDurMin(secs: number): string {
  if (!secs) return "0 min";
  const m = Math.floor(secs / 60);
  const frac = Math.round((secs % 60) / 6);
  return frac > 0 ? `${m},${frac} min` : `${m} min`;
}

function fmtPct(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}


type CallFilterState = {
  start_date: string;
  end_date: string;
  responsible_id: string;
  phone: string;
  source: string;
  call_kind: string;
  status: string;
  duration_from: string;
  duration_to: string;
  stage: string;
};

const CALL_STAGE_LABELS: Record<string, string> = {
  'NEW': 'Yangi lid', 'IN_PROCESS': 'Yangi lid',
  'PROCESSED': 'Propushenniy',
  'UC_1KPATX': 'Javob bermadi', 'NO_ANSWER': 'Javob bermadi',
  'UC_Q2U9EL': 'Qayta aloqa', 'CALLBACK': 'Qayta aloqa',
  'UC_KXC3ZW': "O'ylab ko'radi", 'THINKING': "O'ylab ko'radi",
  'UC_L28G68': 'Tashrif belgilandi', 'CONSULTATION': 'Tashrif belgilandi',
  'UC_5G8244': 'Kelmadi', 'NOT_TRANSFERRED': 'Kelmadi',
  'JUNK': 'Sandiq', 'ARCHIVE': 'Sandiq',
  'UC_F8K4GI': 'Sifatsiz',
  'UC_NAZK5J': "Bekor bo'ldi", 'RECYCLED': "Bekor bo'ldi",
  'CONVERTED_CONSULT': 'Tashrif buyurdi', 'CONVERTED': 'Tashrif buyurdi',
  'C1:NEW': 'Konsultatsiya', 'C1:IN_PROCESS': 'Jarayonda',
  'C1:PREPARATION': 'Taklif tayyorlash', 'C1:PRESENTATION': 'Taqdimot',
  'C1:CLIENT_APPROVED': 'Mijoz manzur ko\'rdi', 'C1:CONTRACT_SENT': 'Shartnoma yuborildi',
  'C1:AGREEMENT': 'Kelishuv', 'C1:FINAL_INVOICE': 'To\'lov',
  'C1:PARTIAL_PAYMENT': 'Qisman to\'lov', 'C1:WORK_STARTED': 'Ish boshlandi',
  'WON': 'Sotuv bo\'ldi', 'C1:WON': 'Sotuv bo\'ldi',
  'LOSE': 'Muvaffaqiyatsiz', 'C1:LOSE': 'Muvaffaqiyatsiz',
};

const callStageOptionGroups = [
  { group: null, options: [{ value: "all", label: "Barchasi" }] },
  {
    group: "📋 Lid bosqichlari",
    options: [
      { value: "NEW",              label: "Yangi lid" },
      { value: "PROCESSED",        label: "Propushenniy" },
      { value: "UC_1KPATX",        label: "Javob bermadi" },
      { value: "UC_Q2U9EL",        label: "Qayta aloqa" },
      { value: "UC_KXC3ZW",        label: "O'ylab ko'radi" },
      { value: "UC_L28G68",        label: "Tashrif belgilandi" },
      { value: "UC_5G8244",        label: "Kelmadi" },
      { value: "UC_F8K4GI",        label: "Sifatsiz" },
      { value: "UC_NAZK5J",        label: "Bekor bo'ldi" },
      { value: "CONVERTED_CONSULT",label: "Tashrif buyurdi" },
    ],
  },
  {
    group: "🤝 Sdelka bosqichlari",
    options: [
      { value: "C1:NEW",           label: "Konsultatsiya" },
      { value: "C1:IN_PROCESS",    label: "Jarayonda" },
      { value: "C1:PREPARATION",   label: "Taklif tayyorlash" },
      { value: "C1:PRESENTATION",  label: "Taqdimot" },
      { value: "C1:CLIENT_APPROVED", label: "Mijoz manzur ko'rdi" },
      { value: "C1:CONTRACT_SENT", label: "Shartnoma yuborildi" },
      { value: "C1:AGREEMENT",     label: "Kelishuv" },
      { value: "C1:FINAL_INVOICE", label: "To'lov" },
      { value: "C1:WORK_STARTED",  label: "Ish boshlandi" },
      { value: "WON",              label: "Sotuv bo'ldi" },
      { value: "LOSE",             label: "Muvaffaqiyatsiz" },
    ],
  },
];

const callStatusOptions = [
  { value: "all", label: "Barchasi" },
  { value: "success", label: "Muvaffaqiyatli" },
  { value: "failed", label: "Muvaffaqiyatsiz" },
  { value: "missed", label: "Propushenniy" },
  { value: "ndz", label: "NDZ" },
  { value: "recalled", label: "Qayta chiqilgan" },
  { value: "unrecalled", label: "Qayta chiqilmagan" },
];

const callKindOptions = [
  { value: "all", label: "Barchasi" },
  { value: "inbound", label: "Kiruvchi" },
  { value: "outbound", label: "Chiquvchi" },
  { value: "callback", label: "Callback" },
];

function defaultCallFilters(): CallFilterState {
  const now = new Date();
  return {
    start_date: localISO(new Date(now.getFullYear(), now.getMonth(), 1)),
    end_date: todayISO(),
    responsible_id: "all",
    phone: "",
    source: "all",
    call_kind: "all",
    status: "all",
    duration_from: "",
    duration_to: "",
    stage: "all",
  };
}

function parseFilterNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
}

function toApiFilter(filter: CallFilterState): CallDashboardFilter {
  const responsibleId = filter.responsible_id !== "all" ? Number(filter.responsible_id) : undefined;
  return {
    start_date: filter.start_date,
    end_date: filter.end_date,
    responsible_id: Number.isFinite(responsibleId) ? responsibleId : undefined,
    phone: filter.phone.trim() || undefined,
    source: filter.source !== "all" ? filter.source : undefined,
    call_kind: filter.call_kind !== "all" ? filter.call_kind : undefined,
    status: filter.status !== "all" ? filter.status : undefined,
    duration_from: parseFilterNumber(filter.duration_from),
    duration_to: parseFilterNumber(filter.duration_to),
    stage: filter.stage !== "all" ? filter.stage : undefined,
  };
}

function activeFilterCount(filter: CallFilterState) {
  return [
    filter.responsible_id !== "all",
    Boolean(filter.phone.trim()),
    filter.source !== "all",
    filter.call_kind !== "all",
    filter.status !== "all",
    Boolean(filter.duration_from.trim()),
    Boolean(filter.duration_to.trim()),
    filter.stage !== "all",
  ].filter(Boolean).length;
}


// ── Metric Card ───────────────────────────────────────────────────
function Card({ label, value, sub, icon, iconBg, badge, badgeColor, valueColor, accentColor }: {
  label: string; value: React.ReactNode; sub?: string;
  icon: React.ReactNode; iconBg: string;
  badge?: string; badgeColor?: string; valueColor?: string; accentColor?: string;
}) {
  const accent = accentColor || "#2196F3";
  return (
    <div style={{ position: "relative", minHeight: 112, background: `linear-gradient(145deg, ${accent}12 0%, var(--bg) 42%, var(--bg) 100%)`, border: `1px solid ${accent}33`, borderRadius: 14, padding: "18px 20px 18px", display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={{ fontSize: 12.5, color: accent, fontWeight: 700, lineHeight: 1.3 }}>{label}</span>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: iconBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, alignSelf: "flex-start" }}>
        <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: valueColor || "var(--text)" }}>{value}</div>
        {badge && (
          <span style={{ fontSize: 11, fontWeight: 700, color: badgeColor, background: `${badgeColor}18`, border: `1.5px solid ${badgeColor}35`, borderRadius: 6, padding: "2px 8px", lineHeight: 1.7, marginBottom: 2 }}>{badge}</span>
        )}
      </div>
      {sub && (
        <div style={{ position: "absolute", right: 14, bottom: 12, fontSize: 11.5, color: accent, display: "inline-flex", alignItems: "center", gap: 4, background: `${accent}14`, border: `1px solid ${accent}30`, borderRadius: 6, padding: "3px 8px" }}>
          <Clock size={11} />{sub}
        </div>
      )}
    </div>
  );
}

// ── Date presets ─────────────────────────────────────────────────
const CALL_PRESETS = [
  { label: "Bugun",  f: todayISO(),        t: todayISO() },
  { label: "7 kun",  f: daysAgoISO(7),     t: todayISO() },
  { label: "30 kun", f: daysAgoISO(30),    t: todayISO() },
  { label: "Bu oy",  f: startOfMonthISO(), t: todayISO() },
  { label: "Barchasi", f: daysAgoISO(365), t: todayISO() },
];


// ── Delta badge ───────────────────────────────────────────────────

// ── Call list sub-table ───────────────────────────────────────────
const CALL_TYPE_LABEL: Record<number, { label: string; color: string }> = {
  1: { label: "Chiquvchi", color: "#2196F3" },
  2: { label: "Kiruvchi",  color: "#4CAF50" },
  3: { label: "Kiruvchi",  color: "#4CAF50" },
  4: { label: "Callback",  color: "#607D8B" },
};

function CallSubTable({ responsibleId, filter }: { responsibleId: number; filter: CallDashboardFilter }) {
  const q = useQuery({ queryKey: ["call-list", responsibleId, filter], queryFn: () => getCallList(responsibleId, filter) });
  if (q.isLoading) return <div style={{ padding: 24, textAlign: "center", color: "var(--text2)", fontSize: 13 }}>Yuklanmoqda...</div>;
  const calls = q.data ?? [];
  if (!calls.length) return <div style={{ padding: 24, textAlign: "center", color: "var(--text2)", fontSize: 13 }}>Qo'ng'iroqlar topilmadi</div>;
  return (
    <div style={{ maxHeight: "min(64vh, 640px)", overflow: "auto", overscrollBehavior: "contain", borderTop: "1px solid var(--border)" }}>
      <table style={{ width: "100%", minWidth: 1180, borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ background: "rgba(33,150,243,0.05)" }}>
            {["#","Telefon","Turi","Davomiylik","Sana va vaqt","Status","Lead","Bosqich"].map((h) => (
              <th key={h} style={{ position: "sticky", top: 0, zIndex: 1, padding: "8px 14px", textAlign: "left", fontWeight: 600, color: "var(--text2)", background: "var(--bg2)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => {
            const ct = c.call_type ? CALL_TYPE_LABEL[c.call_type] : null;
            const ok = c.status_code === 200 || (c.duration ?? 0) >= 10;
            const stageLabel = c.stage_bitrix_id ? (CALL_STAGE_LABELS[c.stage_bitrix_id] ?? c.stage_name ?? c.stage_bitrix_id) : (c.stage_name ?? null);
            return (
              <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 14px", color: "var(--text2)" }}>{i + 1}</td>
                <td style={{ padding: "8px 14px", fontFamily: "monospace" }}>{c.phone_number || "—"}</td>
                <td style={{ padding: "8px 14px" }}>{ct ? <span style={{ fontSize: 11, fontWeight: 600, color: ct.color, background: `${ct.color}15`, border: `1px solid ${ct.color}30`, borderRadius: 5, padding: "2px 8px" }}>{ct.label}</span> : "—"}</td>
                <td style={{ padding: "8px 14px", fontFamily: "monospace" }}>{fmtDur(c.duration ?? 0)}</td>
                <td style={{ padding: "8px 14px", color: "var(--text2)", whiteSpace: "nowrap" }}>{c.call_start ? new Date(c.call_start).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                <td style={{ padding: "8px 14px" }}><span style={{ fontSize: 11, fontWeight: 600, color: ok ? "#4CAF50" : "#F44336", background: ok ? "#4CAF5015" : "#F4433615", border: `1px solid ${ok ? "#4CAF5030" : "#F4433630"}`, borderRadius: 5, padding: "2px 8px" }}>{ok ? "Muvaffaqiyatli" : "Muvaffaqiyatsiz"}</span></td>
                <td style={{ padding: "8px 14px" }}>{c.lead_id ? <a href={`https://mountain.bitrix24.kz/crm/lead/details/${c.lead_id}/`} target="_blank" rel="noreferrer" style={{ color: "#2196F3", textDecoration: "none", fontSize: 12 }}>{c.lead_title || `#${c.lead_id}`}</a> : "—"}</td>
                <td style={{ padding: "8px 14px" }}>{stageLabel ? <span style={{ fontSize: 11, fontWeight: 600, color: "#9C27B0", background: "rgba(156,39,176,0.10)", border: "1px solid rgba(156,39,176,0.25)", borderRadius: 5, padding: "2px 8px", whiteSpace: "nowrap" }}>{stageLabel}</span> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────
export default function CallStatistikasi() {
  const [filters, setFilters]       = useState<CallFilterState>(() => defaultCallFilters());
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedResp, setSelectedResp] = useState<{ id: number; name: string } | null>(null);
  const pageScrollRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const apiFilter = toApiFilter(filters);
  const activeFilters = activeFilterCount(filters);

  const update = (patch: Partial<CallFilterState>) => setFilters(s => ({ ...s, ...patch }));

  const statsQ = useQuery({
    queryKey: ["py-call-stats", apiFilter],
    queryFn:  () => getPyCallStats(apiFilter),
  });

  const filterOptionsQ = useQuery({
    queryKey: ["call-filter-options"],
    queryFn: getCallFilterOptions,
  });

  const data: PyCallStatsResult | undefined = statsQ.data;
  const rows: PyResponsibleCallStats[]      = data?.responsibles ?? [];
  const failedCalls = data?.failed_calls ?? 0;
  const ndzCalls = data?.ndz_calls ?? 0;
  const selectedRow = selectedResp ? rows.find((u, idx) => (u.responsible_id ?? idx) === selectedResp.id) : null;

  useEffect(() => {
    if (!selectedResp) return;
    const t = window.setTimeout(() => {
      const scroller = pageScrollRef.current;
      const detail = detailRef.current;
      if (!scroller || !detail) return;
      scroller.scrollTo({ top: Math.max(0, detail.offsetTop - 16), behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(t);
  }, [selectedResp?.id]);

  const TH  = (extra?: React.CSSProperties): React.CSSProperties => ({ padding: "10px 14px", textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--text2)", textTransform: "uppercase", letterSpacing: "0.05em", background: "var(--bg2)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", ...extra });
  const TD  = (extra?: React.CSSProperties): React.CSSProperties => ({ padding: "11px 14px", verticalAlign: "middle", borderBottom: "1px solid var(--border)", textAlign: "center", ...extra });

  const selStyle = { width: "100%", padding: "8px 10px", fontSize: 12, background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 8 };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg2)" }}>
      <Topbar title="Call statistikasi" />

      <div ref={pageScrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: "18px 24px 96px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ── Inline filter panel ── */}
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, overflow: filterOpen ? "visible" : "hidden", position: "sticky", top: 0, zIndex: 10 }}>
          <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
            onClick={() => setFilterOpen(o => !o)}>
            <Search size={14} style={{ color: "var(--text3)" }} />
            <span style={{ fontSize: 12.5, color: "var(--text3)", flex: 1 }}>
              {`Filtr: ${filters.start_date} → ${filters.end_date}${activeFilters > 0 ? ` · ${activeFilters} ta qo'shimcha` : ""}`}
            </span>
            {activeFilters > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 20, background: "#3b82f6", color: "#fff" }}>{activeFilters} filtr</span>
            )}
            <ChevronDown size={14} style={{ color: "var(--text3)", transform: filterOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
          </div>

          {filterOpen && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "16px 20px" }}>
              {/* Davr — sana oralig'i + tezkor presetlar */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "var(--text3)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <Calendar size={12} /> Davr
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <DateRangePicker
                    start={filters.start_date} end={filters.end_date}
                    onChange={(s, e) => update({ start_date: s, end_date: e })}
                    onClear={() => {
                      const d = defaultCallFilters();
                      update({ start_date: d.start_date, end_date: d.end_date });
                    }}
                  />
                  {CALL_PRESETS.map(p => {
                    const active = filters.start_date === p.f && filters.end_date === p.t;
                    return (
                      <button key={p.label} onClick={() => update({ start_date: p.f, end_date: p.t })}
                        style={{ padding: "5px 14px", borderRadius: 20, fontSize: 12, cursor: "pointer", background: active ? "#3b82f6" : "var(--bg3)", border: `1px solid ${active ? "#3b82f6" : "var(--border)"}`, color: active ? "#fff" : "var(--text2)", fontWeight: active ? 600 : 400 }}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Other filters row */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                <div style={{ flex: "1 1 160px", minWidth: 140 }}>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Mas'ul xodim</div>
                  <select value={filters.responsible_id} onChange={e => update({ responsible_id: e.target.value })} style={selStyle}>
                    <option value="all">{filterOptionsQ.isLoading ? "Yuklanmoqda..." : "Barchasi"}</option>
                    {(filterOptionsQ.data?.responsibles ?? []).map(r => <option key={r.id} value={r.id}>{r.full_name}</option>)}
                  </select>
                </div>
                <div style={{ flex: "1 1 140px", minWidth: 130 }}>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Holat</div>
                  <select value={filters.status} onChange={e => update({ status: e.target.value })} style={selStyle}>
                    {callStatusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div style={{ flex: "1 1 140px", minWidth: 130 }}>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Manba</div>
                  <select value={filters.source} onChange={e => update({ source: e.target.value })} style={selStyle}>
                    <option value="all">Barchasi</option>
                    {(filterOptionsQ.data?.sources ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div style={{ flex: "1 1 140px", minWidth: 130 }}>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Qo'ng'iroq turi</div>
                  <select value={filters.call_kind} onChange={e => update({ call_kind: e.target.value })} style={selStyle}>
                    {callKindOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div style={{ flex: "1 1 160px", minWidth: 140 }}>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Bosqich</div>
                  <select value={filters.stage} onChange={e => update({ stage: e.target.value })} style={selStyle}>
                    {callStageOptionGroups.map(g =>
                      g.group
                        ? <optgroup key={g.group} label={g.group}>
                            {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </optgroup>
                        : g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)
                    )}
                  </select>
                </div>
                <div style={{ flex: "1 1 200px", minWidth: 180 }}>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Klient telefon</div>
                  <input value={filters.phone} onChange={e => update({ phone: e.target.value })} placeholder="Telefon klienta" style={selStyle} />
                </div>
              </div>

              {/* Duration */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Davomiylik (sek)</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <input type="number" min={0} value={filters.duration_from} onChange={e => update({ duration_from: e.target.value })} placeholder="dan 0" style={selStyle} />
                  <input type="number" min={0} value={filters.duration_to} onChange={e => update({ duration_to: e.target.value })} placeholder="gacha ∞" style={selStyle} />
                </div>
              </div>

              {activeFilters > 0 && (
                <div style={{ paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => { setFilters(defaultCallFilters()); setSelectedResp(null); }} style={{ background: "none", border: "none", color: "#9E9E9E", fontSize: 12, cursor: "pointer", padding: "6px 10px" }}>Tozalash</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Row 1 ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          <Card label="Qo'ng'iroq jami" accentColor="#2196F3"
            value={<>{data?.total_calls ?? 0} <span style={{ fontSize: 16, fontWeight: 500, color: "var(--text2)" }}>ta</span></>}
            sub={fmtDur(data?.total_duration ?? 0)}
            icon={<Phone size={19} color="#2196F3" />} iconBg="rgba(33,150,243,0.12)" />
          <Card label="Chiquvchi qo'ng'iroq" accentColor="#2196F3"
            value={<>{data?.outbound_calls ?? 0} <span style={{ fontSize: 16, fontWeight: 500, color: "var(--text2)" }}>ta</span></>}
            sub={fmtDur(rows.reduce((s, r) => s + r.outbound_duration, 0))}
            icon={<PhoneOutgoing size={19} color="#2196F3" />} iconBg="rgba(33,150,243,0.12)" />
          <Card label="Kiruvchi qo'ng'iroq" accentColor="#4CAF50"
            value={<>{data?.inbound_calls ?? 0} <span style={{ fontSize: 16, fontWeight: 500, color: "var(--text2)" }}>ta</span></>}
            sub={fmtDur(rows.reduce((s, r) => s + r.inbound_duration, 0))}
            icon={<PhoneIncoming size={19} color="#4CAF50" />} iconBg="rgba(76,175,80,0.12)" />
          <Card label="Muvaffaqiyatli" accentColor="#4CAF50"
            value={<span style={{ color: "#4CAF50" }}>{data?.success_calls ?? 0}</span>}
            icon={<CheckCircle size={19} color="#4CAF50" />} iconBg="rgba(76,175,80,0.12)"
            badge={`${Math.round(data?.success_pct ?? 0)}%`} badgeColor="#4CAF50" />
          <Card label="Muvaffaqiyatsiz" accentColor="#F44336"
            value={<span style={{ color: "#F44336" }}>{failedCalls}</span>}
            icon={<XCircle size={19} color="#F44336" />} iconBg="rgba(244,67,54,0.10)"
            badge={failedCalls > 0 ? fmtPct(data?.failed_pct ?? 0) : undefined} badgeColor="#F44336" />
        </div>

        {/* ── Row 2 ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          <Card label="O'rtacha davomiyligi" accentColor="#9C27B0"
            value={fmtDurMin(data?.avg_duration ?? 0)}
            icon={<Timer size={19} color="#9C27B0" />} iconBg="rgba(156,39,176,0.10)" />
          <Card label="NDZ (javob berilmagan)" accentColor="#607D8B"
            value={<>{ndzCalls} <span style={{ fontSize: 16, fontWeight: 500, color: "var(--text2)" }}>ta</span></>}
            icon={<PhoneOff size={19} color="#607D8B" />} iconBg="rgba(96,125,139,0.10)" />
          <Card label="Propushenniy" accentColor="#FF9800"
            value={<span style={{ color: "#FF9800" }}>{data?.missed_inbound ?? 0} <span style={{ fontSize: 16, fontWeight: 500 }}>ta</span></span>}
            icon={<PhoneMissed size={19} color="#FF9800" />} iconBg="rgba(255,152,0,0.10)" />
          <Card label="Reaksiya vaqti" accentColor="#607D8B"
            value={<span style={{ fontSize: 22 }}>{fmtDur(data?.reaksiya_vaqti ?? 0)}</span>}
            icon={<Clock size={19} color="#607D8B" />} iconBg="rgba(96,125,139,0.10)" />
          <Card label="Ne perezvonili" accentColor="#F44336"
            value={<>{data?.ne_perezvonili ?? 0} <span style={{ fontSize: 16, fontWeight: 500, color: "var(--text2)" }}>ta</span></>}
            icon={<PhoneMissed size={19} color="#F44336" />} iconBg="rgba(244,67,54,0.10)" />
        </div>

        {/* ── Main stats table ── */}
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Xodimlar bo'yicha hisobot</div>
            </div>
            <button title="Export" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg2)", color: "var(--text2)", cursor: "pointer" }}><Download size={15} /></button>
          </div>

          {statsQ.isLoading ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--text2)" }}>Yuklanmoqda...</div>
          ) : statsQ.isError ? (
            <div style={{ padding: 48, textAlign: "center", color: "#F44336", fontSize: 13 }}>Xatolik: {String((statsQ.error as Error)?.message ?? "noma'lum xato")}</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--text2)" }}>Ma'lumot topilmadi</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={TH({ textAlign: "left", minWidth: 200 })} rowSpan={2}>OPERATORLAR</th>
                    <th style={TH({ color: "#2196F3", borderLeft: "2px solid rgba(33,150,243,0.2)" })} colSpan={3}>QO'NG'IROQLAR SONI</th>
                    <th style={TH({ color: "#4CAF50", borderLeft: "2px solid rgba(76,175,80,0.2)" })} colSpan={3}>UNIKAL QO'NG'IROQLAR</th>
                    <th style={TH({ color: "#9C27B0", borderLeft: "2px solid rgba(156,39,176,0.2)" })} colSpan={3}>DAVOMIYLIK</th>
                    <th style={TH({ color: "#FF9800", borderLeft: "2px solid rgba(255,152,0,0.24)" })} colSpan={3}>PROPUSHENNIY</th>
                  </tr>
                  <tr>
                    <th style={TH({ borderLeft: "2px solid rgba(33,150,243,0.2)" })}>Kiruvchi</th>
                    <th style={TH()}>Chiquvchi</th>
                    <th style={TH()}>Umumiy</th>
                    <th style={TH({ borderLeft: "2px solid rgba(76,175,80,0.2)" })}>Kiruvchi</th>
                    <th style={TH()}>Chiquvchi</th>
                    <th style={TH()}>Umumiy</th>
                    <th style={TH({ borderLeft: "2px solid rgba(156,39,176,0.2)" })}>Kiruvchi</th>
                    <th style={TH()}>Isxodyashie</th>
                    <th style={TH()}>Jami</th>
                    <th style={TH({ borderLeft: "2px solid rgba(255,152,0,0.24)" })}>Umumiy</th>
                    <th style={TH()}>Qayta chiqilgan</th>
                    <th style={TH()}>Chiqilmagan</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u, idx) => {
                    const uid    = u.responsible_id ?? idx;
                    const isSel  = selectedResp?.id === uid;
                    return (
                      <Fragment key={uid}>
                        <tr key={uid} style={{ background: isSel ? "rgba(33,150,243,0.06)" : "var(--bg)", cursor: "pointer" }}
                          onClick={() => setSelectedResp(isSel ? null : { id: uid, name: u.full_name })}>
                          <td style={TD({ textAlign: "left" })}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{u.full_name}</div>
                              </div>
                              {isSel ? <ChevronUp size={14} color="#2196F3" /> : <ChevronDown size={14} color="var(--text2)" />}
                            </div>
                          </td>
                          <td style={TD({ borderLeft: "2px solid rgba(33,150,243,0.10)" })}>{u.inbound_calls}</td>
                          <td style={TD()}>{u.outbound_calls}</td>
                          <td style={TD({ fontWeight: 700 })}>{u.total_calls}</td>
                          <td style={TD({ borderLeft: "2px solid rgba(76,175,80,0.10)" })}>{u.unique_inbound}</td>
                          <td style={TD()}>{u.unique_outbound}</td>
                          <td style={TD({ fontWeight: 700 })}>{u.unique_total}</td>
                          <td style={TD({ borderLeft: "2px solid rgba(156,39,176,0.10)", fontFamily: "monospace", fontSize: 12 })}>{fmtDur(u.inbound_duration)}</td>
                          <td style={TD({ fontFamily: "monospace", fontSize: 12 })}>{fmtDur(u.outbound_duration)}</td>
                          <td style={TD({ fontWeight: 700, fontFamily: "monospace", fontSize: 12 })}>{fmtDur(u.total_duration)}</td>
                          <td style={TD({ borderLeft: "2px solid rgba(255,152,0,0.12)", color: "#FF9800", fontWeight: 700 })}>{u.missed_inbound}</td>
                          <td style={TD({ color: "#4CAF50", fontWeight: 700 })}>{u.missed_recalled}</td>
                          <td style={TD({ color: "#F44336", fontWeight: 700 })}>{u.missed_unrecalled}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selectedRow?.responsible_id != null && (
          <div ref={detailRef} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", scrollMarginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--border)", background: "rgba(33,150,243,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {selectedRow.full_name} — qo'ng'iroqlar ro'yxati
                  </div>
                </div>
              </div>
              <button onClick={() => setSelectedResp(null)} style={{ border: "1px solid var(--border)", background: "var(--bg2)", color: "var(--text2)", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}>
                Yopish
              </button>
            </div>
            <CallSubTable responsibleId={selectedRow.responsible_id} filter={apiFilter} />
          </div>
        )}


      </div>
    </div>
  );
}
