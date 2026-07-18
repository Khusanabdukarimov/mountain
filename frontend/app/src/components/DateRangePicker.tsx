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
  // Which picker is showing: day grid → month grid → year grid (click the header to zoom out)
  const [pickMode, setPickMode] = useState<"days" | "months" | "years">("days");
  // Editable text mirrors of the range — lets the user type YYYY-MM-DD directly.
  const [fromText, setFromText] = useState(start ?? "");
  const [toText, setToText] = useState(end ?? "");
  const ref = useRef<HTMLDivElement>(null);

  // Keep the typed inputs in sync when the applied range changes elsewhere (presets, clicks).
  useEffect(() => { setFromText(start ?? ""); }, [start]);
  useEffect(() => { setToText(end ?? ""); }, [end]);

  const isValidIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());

  // Keep only digits and auto-insert the dashes: "20260701" → "2026-07-01".
  // Non-numeric characters are dropped, so the field can only ever hold a date shape.
  const maskDate = (raw: string) => {
    const d = raw.replace(/\D/g, "").slice(0, 8); // YYYYMMDD
    let out = d.slice(0, 4);
    if (d.length > 4) out += "-" + d.slice(4, 6);
    if (d.length > 6) out += "-" + d.slice(6, 8);
    return out;
  };

  // Commit a typed field. Keeps start ≤ end; jumps the calendar to the edited date.
  const commitFrom = () => {
    if (!isValidIso(fromText)) { setFromText(start ?? ""); return; }
    const s = fromText;
    const e = end && end >= s ? end : s;
    onChange(s, e);
    setPendingStart(null);
    const d = new Date(s);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };
  const commitTo = () => {
    if (!isValidIso(toText)) { setToText(end ?? ""); return; }
    const e = toText;
    const s = start && start <= e ? start : e;
    onChange(s, e);
    setPendingStart(null);
    const d = new Date(e);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

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
    setPickMode("days");
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

  // Header arrows step by month / year / 12-year block depending on the active picker.
  const goPrev = () => {
    if (pickMode === "days") setView(v => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
    else if (pickMode === "months") setView(v => ({ ...v, y: v.y - 1 }));
    else setView(v => ({ ...v, y: v.y - 12 }));
  };
  const goNext = () => {
    if (pickMode === "days") setView(v => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));
    else if (pickMode === "months") setView(v => ({ ...v, y: v.y + 1 }));
    else setView(v => ({ ...v, y: v.y + 12 }));
  };
  const yearWindowStart = view.y - (((view.y % 12) + 12) % 12); // first year of the current 12-year block

  const firstOffset = (new Date(view.y, view.m, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const today = todayIso();

  const gridCellBtn = (active: boolean): React.CSSProperties => ({
    height: 54, borderRadius: 9, fontSize: 13, cursor: "pointer", border: "none",
    background: active ? "#3b82f6" : "var(--bg3)",
    color: active ? "#fff" : "var(--text2)", fontWeight: active ? 700 : 500,
  });

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
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 700, width: 340,
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14,
          boxShadow: "0 8px 32px rgba(0,0,0,0.45)", padding: 16, boxSizing: "border-box",
        }}>
          {/* Typed range — edit the dates directly (YYYY-MM-DD) */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Dan</div>
              <input
                value={fromText}
                onChange={e => setFromText(maskDate(e.target.value))}
                onBlur={commitFrom}
                onKeyDown={e => { if (e.key === "Enter") { commitFrom(); (e.target as HTMLInputElement).blur(); } }}
                placeholder="YYYY-MM-DD"
                inputMode="numeric"
                maxLength={10}
                style={{
                  width: "100%", boxSizing: "border-box", background: "var(--bg)",
                  border: `1px solid ${fromText.length === 10 && !isValidIso(fromText) ? "#ef4444" : "var(--border)"}`,
                  borderRadius: 8, color: "var(--text)", fontSize: 13, padding: "8px 10px", outline: "none",
                }}
              />
            </div>
            <span style={{ color: "var(--text3)", fontSize: 14, paddingBottom: 9 }}>→</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Gacha</div>
              <input
                value={toText}
                onChange={e => setToText(maskDate(e.target.value))}
                onBlur={commitTo}
                onKeyDown={e => { if (e.key === "Enter") { commitTo(); (e.target as HTMLInputElement).blur(); } }}
                placeholder="YYYY-MM-DD"
                inputMode="numeric"
                maxLength={10}
                style={{
                  width: "100%", boxSizing: "border-box", background: "var(--bg)",
                  border: `1px solid ${toText.length === 10 && !isValidIso(toText) ? "#ef4444" : "var(--border)"}`,
                  borderRadius: 8, color: "var(--text)", fontSize: 13, padding: "8px 10px", outline: "none",
                }}
              />
            </div>
          </div>

          {/* Header — click the label to zoom out: days → months → years */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <button type="button" onClick={goPrev} style={navBtn} aria-label="Oldingi">
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => setPickMode(m => (m === "days" ? "months" : m === "months" ? "years" : "days"))}
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "4px 12px", borderRadius: 8,
                fontSize: 13, fontWeight: 700, color: "var(--text)",
              }}
              title="Oy / yilni tanlash"
            >
              {pickMode === "days"
                ? `${UZ_MONTHS[view.m]} ${view.y}`
                : pickMode === "months"
                  ? `${view.y}`
                  : `${yearWindowStart} – ${yearWindowStart + 11}`}
            </button>
            <button type="button" onClick={goNext} style={navBtn} aria-label="Keyingi">
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Day picker */}
          {pickMode === "days" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 6 }}>
                {UZ_WEEKDAYS.map(w => (
                  <div key={w} style={{ textAlign: "center", fontSize: 11.5, fontWeight: 600, color: "var(--text3)", padding: "3px 0" }}>
                    {w}
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }} onMouseLeave={() => setHoverDay(null)}>
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
                        height: 40, borderRadius: 9, fontSize: 13.5, cursor: "pointer", padding: 0,
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
            </>
          )}

          {/* Month picker */}
          {pickMode === "months" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {UZ_MONTHS.map((mo, mi) => (
                <button
                  key={mo}
                  type="button"
                  onClick={() => { setView(v => ({ ...v, m: mi })); setPickMode("days"); }}
                  style={gridCellBtn(mi === view.m)}
                >
                  {mo}
                </button>
              ))}
            </div>
          )}

          {/* Year picker */}
          {pickMode === "years" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {Array.from({ length: 12 }, (_, i) => yearWindowStart + i).map(yr => (
                <button
                  key={yr}
                  type="button"
                  onClick={() => { setView(v => ({ ...v, y: yr })); setPickMode("months"); }}
                  style={gridCellBtn(yr === view.y)}
                >
                  {yr}
                </button>
              ))}
            </div>
          )}

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
