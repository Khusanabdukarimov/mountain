import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Topbar } from "@/components/Topbar";
import { Button } from "@/components/Button";
import { Avatar } from "@/components/Avatar";
import { apiGet, authedFetch, API_URL_CRM } from "@/lib/api/client";
import { useToast } from "@/components/Toast";

// ── Types ────────────────────────────────────────────────────────────────────

type Responsible = {
  id: number;
  full_name: string;
  email: string | null;
  work_position: string | null;
  taqsimot_pct: number | null;
};

type StatRow = {
  id: number;
  full_name: string;
  target_pct: number;
  today_count: number;
  actual_pct: number | null;
  deficit_pct: number | null;
};

// ── API helpers ───────────────────────────────────────────────────────────────

function fetchTaqsimot() {
  return apiGet<{ responsibles: Responsible[] }>("/api/dashboard/taqsimot", {}, API_URL_CRM);
}

function fetchStats() {
  return apiGet<{ stats: StatRow[]; date: string }>("/api/dashboard/taqsimot-stats", {}, API_URL_CRM);
}

async function saveTaqsimot(id: number, pct: number) {
  const res = await authedFetch(`/api/dashboard/taqsimot/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taqsimot_pct: pct }),
  }, API_URL_CRM);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<{ ok: boolean; total_pct: number; warning: string | null }>;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TaqsimotPage() {
  const qc    = useQueryClient();
  const toast = useToast();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["taqsimot"],
    queryFn: fetchTaqsimot,
  });

  const statsQ = useQuery({
    queryKey: ["taqsimot-stats"],
    queryFn: fetchStats,
    refetchInterval: 60_000,
  });

  // Only sales roles participate in lead distribution — show Hunter / Closer
  // (and Hunter + Closer) only; hide support/PM/office staff (09:00–18:00, PM, etc.).
  const rows = (data?.responsibles ?? []).filter((r) => {
    const pos = (r.work_position ?? "").toLowerCase();
    return pos.includes("hunter") || pos.includes("closer");
  });
  const total = rows.reduce((s, r) => s + parseFloat(String(r.taqsimot_pct ?? 0)), 0);
  const totalRounded = Math.round(total * 10) / 10;

  async function handleSave(id: number, pct: number) {
    try {
      const result = await saveTaqsimot(id, pct);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["taqsimot"] }),
        qc.invalidateQueries({ queryKey: ["taqsimot-stats"] }),
      ]);
      if (result.warning) {
        toast.error("Diqqat", result.warning);
      }
    } catch (e) {
      toast.error("Saqlashda xato", (e as Error).message);
    }
  }

  return (
    <>
      <Topbar
        title="Taqsimot"
        sub="Xodimlar bo'yicha lid taqsimoti"
        actions={
          <Button onClick={() => { refetch(); statsQ.refetch(); }}>
            <RefreshCw className="w-3.5 h-3.5" /> Yangilash
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto px-3 sm:px-[22px] py-3 sm:py-[18px] bg-bg space-y-5">

        {/* ── Settings table ─────────────────────────────────────────── */}
        <div className="bg-bg2 border border-border rounded-xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <div className="text-[12px] font-semibold text-text">Taqsimot sozlamalari</div>
            <div className="text-[11px] text-text3 mt-0.5">
              Foizni o'zgartirish uchun katakni bosing
            </div>
          </div>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-border bg-bg3">
                <th className="text-left px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px]">
                  Xodim
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px]">
                  Ish vaqti
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px] w-36">
                  Taqsimot %
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-b border-border animate-pulse">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-bg3" />
                          <div>
                            <div className="h-3 w-28 bg-bg3 rounded mb-1" />
                            <div className="h-2 w-20 bg-bg3 rounded" />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3"><div className="h-3 w-16 bg-bg3 rounded" /></td>
                      <td className="px-4 py-3"><div className="h-3 w-10 bg-bg3 rounded" /></td>
                    </tr>
                  ))
                : rows.map((r) => (
                    <TaqsimotRow key={r.id} row={r} onSave={handleSave} />
                  ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-bg3">
                <td className="px-4 py-2.5 font-semibold text-text" colSpan={2}>
                  Jami
                </td>
                <td className="px-4 py-2.5 font-semibold mono">
                  {totalRounded === 100 ? (
                    <span className="text-green-500">{totalRounded}% ✓</span>
                  ) : (
                    <span className="text-red-400">
                      Jami: {totalRounded}% (100% bo'lishi kerak)
                    </span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── Today's monitoring ─────────────────────────────────────── */}
        <div className="bg-bg2 border border-border rounded-xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <div className="text-[12px] font-semibold text-text">Bugungi taqsimot</div>
              <div className="text-[11px] text-text3 mt-0.5">
                Haqiqiy vs maqsad foiz (bugun kelgan lidlar)
              </div>
            </div>
            {statsQ.data?.date && (
              <span className="text-[10px] text-text3 mono">
                {new Date(statsQ.data.date).toLocaleTimeString("uz-UZ", {
                  hour: "2-digit", minute: "2-digit",
                })}
              </span>
            )}
          </div>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-border bg-bg3">
                <th className="text-left px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px]">
                  Xodim
                </th>
                <th className="text-right px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px]">
                  Maqsad %
                </th>
                <th className="text-right px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px]">
                  Bugungi lidlar
                </th>
                <th className="text-right px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px]">
                  Haqiqiy %
                </th>
                <th className="text-right px-4 py-2.5 font-medium text-text3 uppercase tracking-wider text-[10.5px]">
                  Farq
                </th>
              </tr>
            </thead>
            <tbody>
              {statsQ.isLoading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b border-border animate-pulse">
                      {Array.from({ length: 5 }).map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-3 w-12 bg-bg3 rounded mx-auto" />
                        </td>
                      ))}
                    </tr>
                  ))
                : (statsQ.data?.stats ?? []).map((s) => {
                    const diff    = s.deficit_pct ?? 0;
                    const absDiff = Math.abs(diff);
                    const diffColor =
                      absDiff < 5  ? "text-green-500" :
                      absDiff < 10 ? "text-amber-400" :
                      "text-red-400";
                    const diffSign = diff > 0 ? "+" : "";

                    return (
                      <tr key={s.id} className="border-b border-border hover:bg-bg3/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={s.full_name} />
                            <span className="font-medium text-text">{s.full_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right mono text-text2">
                          {s.target_pct}%
                        </td>
                        <td className="px-4 py-3 text-right mono font-semibold text-text">
                          {s.today_count}
                        </td>
                        <td className="px-4 py-3 text-right mono text-text2">
                          {s.actual_pct !== null ? `${s.actual_pct}%` : "—"}
                        </td>
                        <td className={`px-4 py-3 text-right mono font-medium ${diffColor}`}>
                          {s.actual_pct !== null
                            ? `${diffSign}${diff}%`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
              {!statsQ.isLoading && (statsQ.data?.stats ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-text3 text-[12px]">
                    Bugun hali lid kelmagan yoki taqsimot sozlanmagan
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>
    </>
  );
}

// ── Editable % cell ───────────────────────────────────────────────────────────

function TaqsimotRow({
  row,
  onSave,
}: {
  row: Responsible;
  onSave: (id: number, pct: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState("");
  const [flash,   setFlash]   = useState(false);
  const inputRef              = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(String(parseFloat(String(row.taqsimot_pct ?? "")) || ""));
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing, row.taqsimot_pct]);

  async function commit() {
    const n = parseFloat(draft);
    if (isNaN(n) || n < 0 || n > 100) {
      setEditing(false);
      return;
    }
    setEditing(false);
    await onSave(row.id, n);
    setFlash(true);
    setTimeout(() => setFlash(false), 700);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter")  commit();
    if (e.key === "Escape") setEditing(false);
  }

  const pct    = row.taqsimot_pct !== null && row.taqsimot_pct !== undefined
    ? parseFloat(String(row.taqsimot_pct))
    : null;
  const hasVal = pct !== null && pct > 0;
  const schedule = row.work_position ?? "09:00–18:00";

  return (
    <tr className={`border-b border-border transition-colors ${flash ? "bg-green-500/10" : "hover:bg-bg3/50"}`}>
      {/* XODIM */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={row.full_name} />
          <div>
            <div className="font-medium text-text">{row.full_name}</div>
            <div className="text-[10px] text-text3">{row.email ?? "—"}</div>
          </div>
        </div>
      </td>

      {/* ISH VAQTI */}
      <td className="px-4 py-3">
        <span className="mono text-text2 text-[11px]">{schedule}</span>
      </td>

      {/* TAQSIMOT % */}
      <td className="px-4 py-3 w-36">
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={commit}
              className="w-20 px-2 py-1 rounded border border-blue bg-bg text-text text-[12px] mono focus:outline-none focus:shadow-[0_0_0_3px_rgba(34,102,245,0.18)]"
            />
            <span className="text-text3 text-[11px]">%</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`mono text-[12.5px] px-2 py-1 rounded hover:bg-blue/10 hover:text-blue transition-colors cursor-pointer min-w-[44px] text-left ${
              hasVal ? "text-text font-medium" : "text-text3"
            }`}
          >
            {hasVal ? `${pct}%` : "—"}
          </button>
        )}
      </td>
    </tr>
  );
}
