import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

const UZ_MONTHS = [
  "Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
  "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr",
];
const UZ_WEEKDAYS = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];

const toIso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const todayIso = () => {
  const t = new Date();
  return toIso(t.getFullYear(), t.getMonth(), t.getDate());
};

type Props = {
  start?: string;
  end?: string;
  /** Fired when a complete range is picked (second click in the calendar). */
  onChange: (start: string, end: string) => void;
  /** Fired by the "Tozalash" link in the popover footer. */
  onClear?: () => void;
  placeholder?: string;
  width?: number | string;
};

export function DateRangePicker({ start, end, onChange, onClear, placeholder = "Sana tanlang", width = 230 }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const base = start ? new Date(start) : new Date();
    return Number.isNaN(base.getTime())
      ? { y: new Date().getFullYear(), m: new Date().getMonth() }
      : { y: base.getFullYear(), m: base.getMonth() };
  });
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPendingStart(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const openCalendar = () => {
    if (!open && start) {
      const d = new Date(start);
      if (!Number.isNaN(d.getTime())) setView({ y: d.getFullYear(), m: d.getMonth() });
    }
    setOpen(o => !o);
    setPendingStart(null);
  };

  const pick = (day: string) => {
    if (!pendingStart) {
      setPendingStart(day);
      return;
    }
    const [s, e] = pendingStart <= day ? [pendingStart, day] : [day, pendingStart];
    onChange(s, e);
    setPendingStart(null);
    setOpen(false);
  };

  // Range shown in the grid: while picking, preview pendingStart→hover; otherwise the applied range.
  const [rangeS, rangeE] = pendingStart
    ? (hoverDay && hoverDay !== pendingStart
        ? (pendingStart <= hoverDay ? [pendingStart, hoverDay] : [hoverDay, pendingStart])
        : [pendingStart, pendingStart])
    : [start, end];

  const prevMonth = () => setView(v => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
  const nextMonth = () => setView(v => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));

  const firstOffset = (new Date(view.y, view.m, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const today = todayIso();

  const navBtn: React.CSSProperties = {
    width: 26, height: 26, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
    background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", padding: 0,
  };

  return (
    <div ref={ref} style={{ position: "relative", width }}>
      <button
        type="button"
        onClick={openCalendar}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          background: "var(--bg)", border: `1px solid ${open ? "#3b82f6" : "var(--border)"}`,
          borderRadius: 8, color: start || end ? "var(--text)" : "var(--text3)",
          fontSize: 12, padding: "8px 10px", cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {start || end ? `${start ?? "…"} – ${end ?? "…"}` : placeholder}
        </span>
        <Calendar size={13} style={{ color: "var(--text3)", flexShrink: 0 }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 700, width: 264,
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12,
          boxShadow: "0 8px 32px rgba(0,0,0,0.45)", padding: 12, boxSizing: "border-box",
        }}>
          {/* Month header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <button type="button" onClick={prevMonth} style={navBtn} aria-label="Oldingi oy">
              <ChevronLeft size={14} />
            </button>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
              {UZ_MONTHS[view.m]} {view.y}
            </span>
            <button type="button" onClick={nextMonth} style={navBtn} aria-label="Keyingi oy">
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Weekday header */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}>
            {UZ_WEEKDAYS.map(w => (
              <div key={w} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 600, color: "var(--text3)", padding: "2px 0" }}>
                {w}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }} onMouseLeave={() => setHoverDay(null)}>
            {Array.from({ length: firstOffset }, (_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = toIso(view.y, view.m, i + 1);
              const isEndpoint = day === rangeS || day === rangeE;
              const inRange = !!rangeS && !!rangeE && day > rangeS && day < rangeE;
              const isToday = day === today;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => pick(day)}
                  onMouseEnter={() => setHoverDay(day)}
                  style={{
                    height: 30, borderRadius: 8, fontSize: 12, cursor: "pointer", padding: 0,
                    border: "none",
                    background: isEndpoint ? "#3b82f6" : inRange ? "rgba(59,130,246,0.16)" : "transparent",
                    color: isEndpoint ? "#fff" : inRange ? "var(--text)" : "var(--text2)",
                    fontWeight: isEndpoint ? 700 : 400,
                    boxShadow: isToday && !isEndpoint ? "inset 0 0 0 1px rgba(59,130,246,0.6)" : "none",
                  }}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
            <span style={{ fontSize: 11, color: "#3b82f6", fontWeight: 600 }}>
              {rangeS ? `${rangeS} → ${rangeE ?? "…"}` : "—"}
            </span>
            <button
              type="button"
              onClick={() => { setPendingStart(null); onClear?.(); }}
              style={{ background: "none", border: "none", color: "var(--text3)", fontSize: 11.5, cursor: "pointer", padding: "2px 4px" }}
            >
              Tozalash
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
