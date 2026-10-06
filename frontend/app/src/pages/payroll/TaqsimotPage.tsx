import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, RefreshCw } from "lucide-react";
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
  taqsimot_enabled: boolean;
};

type StatRow = {
  id: number;
  full_name: string;
  target_pct: number;
  today_count: number;
  actual_pct: number | null;
  deficit_pct: number | null;
};

type CampaignResponsible = { id: number; full_name: string; work_position: string | null; pct: number; attached: boolean };
type CampaignSetting = { campaign_name: string; active: boolean; responsibles: CampaignResponsible[] };
type CampaignSummary = { campaign_name: string; active: boolean };
type CampaignMembership = { responsible_id: number; campaign_name: string; pct: number };

// ── API helpers ───────────────────────────────────────────────────────────────

function fetchTaqsimot() {
  return apiGet<{ responsibles: Responsible[] }>("/api/dashboard/taqsimot", {}, API_URL_CRM);
}

function fetchStats() {
  return apiGet<{ stats: StatRow[]; date: string }>("/api/dashboard/taqsimot-stats", {}, API_URL_CRM);
}

function fetchCampaignSetting(name: string) {
  return apiGet<CampaignSetting>(`/api/dashboard/taqsimot-campaign?campaign_name=${encodeURIComponent(name)}`, {}, API_URL_CRM);
}

function fetchCampaignStats(name: string) {
  return apiGet<{ stats: StatRow[]; date: string }>(`/api/dashboard/taqsimot-campaign-stats?campaign_name=${encodeURIComponent(name)}`, {}, API_URL_CRM);
}

async function saveCampaignRequest(path: string, body: object, method = "PUT") {
  const res = await authedFetch(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, API_URL_CRM);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `${res.status} ${res.statusText}`);
  }
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

async function addTaqsimotResponsible(id: number, pct: number) {
  const res = await authedFetch(`/api/dashboard/taqsimot/${id}/add`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taqsimot_pct: pct }),
  }, API_URL_CRM);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `${res.status} ${res.statusText}`);
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TaqsimotPage() {
  const qc    = useQueryClient();
  const toast = useToast();
  const [view, setView] = useState("general");
  const [adding, setAdding] = useState(false);
  const [newCampaign, setNewCampaign] = useState("");
  const [addResponsibleOpen, setAddResponsibleOpen] = useState(false);
  const [rowAddingCampaign, setRowAddingCampaign] = useState<number | null>(null);
  const campaignName = view === "general" ? "" : view;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["taqsimot"],
    queryFn: fetchTaqsimot,
  });

  const statsQ = useQuery({
    queryKey: ["taqsimot-stats"],
    queryFn: fetchStats,
    refetchInterval: 60_000,
  });
  const campaignListQ = useQuery({
    queryKey: ["taqsimot-campaigns"],
    queryFn: () => apiGet<{ campaigns: CampaignSummary[] }>("/api/dashboard/taqsimot-campaigns", {}, API_URL_CRM),
  });
  const membershipsQ = useQuery({
    queryKey: ["taqsimot-campaign-memberships"],
    queryFn: () => apiGet<{ memberships: CampaignMembership[] }>("/api/dashboard/taqsimot-campaign-memberships", {}, API_URL_CRM),
  });
  const campaignOptionsQ = useQuery({
    queryKey: ["taqsimot-campaign-options"],
    queryFn: () => apiGet<{ campaigns: string[] }>("/api/dashboard/taqsimot-campaign-options", {}, API_URL_CRM),
    enabled: adding || rowAddingCampaign !== null,
  });
  const campaignQ = useQuery({ queryKey: ["taqsimot-campaign", campaignName], queryFn: () => fetchCampaignSetting(campaignName), enabled: !!campaignName });
  const candidatesQ = useQuery({
    queryKey: ["taqsimot-candidates", campaignName],
    queryFn: () => apiGet<{ responsibles: Responsible[] }>(
      `/api/dashboard/taqsimot-candidates${campaignName ? `?campaign_name=${encodeURIComponent(campaignName)}` : ""}`,
      {}, API_URL_CRM),
    enabled: addResponsibleOpen,
  });
  const campaignStatsQ = useQuery({
    queryKey: ["taqsimot-campaign-stats", campaignName], queryFn: () => fetchCampaignStats(campaignName),
    enabled: !!campaignName, refetchInterval: 60_000,
  });

  const rows = data?.responsibles ?? [];
  const total = rows.reduce((s, r) => s + parseFloat(String(r.taqsimot_pct ?? 0)), 0);
  const totalRounded = Math.round(total * 10) / 10;
  const campaignTotal = Math.round((campaignQ.data?.responsibles ?? []).reduce((sum, r) => sum + r.pct, 0) * 10) / 10;

  async function refreshDistribution() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["taqsimot-campaigns"] }),
      qc.invalidateQueries({ queryKey: ["taqsimot-campaign-memberships"] }),
      qc.invalidateQueries({ queryKey: ["taqsimot-campaign"] }),
      qc.invalidateQueries({ queryKey: ["taqsimot-campaign-stats"] }),
      qc.invalidateQueries({ queryKey: ["taqsimot-stats"] }),
    ]);
  }

  async function saveCampaignPct(id: number, pct: number) {
    try {
      await saveCampaignRequest(`/api/dashboard/taqsimot-campaign/${id}`, { campaign_name: campaignName, pct });
      await refreshDistribution();
    } catch (e) { toast.error("Saqlashda xato", (e as Error).message); }
  }

  async function setCampaignActive(active: boolean) {
    try {
      await saveCampaignRequest("/api/dashboard/taqsimot-campaign", { campaign_name: campaignName, active });
      await refreshDistribution();
      toast.success("Saqlandi", active ? "Campaign oqimi yoqildi" : "Campaign oqimi o'chirildi");
    } catch (e) { toast.error("Saqlashda xato", (e as Error).message); }
  }

  async function addCampaign() {
    if (!newCampaign) return;
    try {
      await saveCampaignRequest("/api/dashboard/taqsimot-campaigns", { campaign_name: newCampaign }, "POST");
      await qc.invalidateQueries({ queryKey: ["taqsimot-campaigns"] });
      setView(newCampaign);
      setNewCampaign("");
      setAdding(false);
      toast.success("Qo‘shildi", "Endi operatorlar foizini sozlang");
    } catch (e) { toast.error("Qo‘shishda xato", (e as Error).message); }
  }

  async function addCampaignToOperator(id: number, name: string) {
    if (!name) return;
    try {
      if (!(campaignListQ.data?.campaigns ?? []).some(c => c.campaign_name === name)) {
        await saveCampaignRequest("/api/dashboard/taqsimot-campaigns", { campaign_name: name }, "POST");
      }
      await saveCampaignRequest("/api/dashboard/taqsimot-campaign-members", {
        campaign_name: name, responsible_id: id, pct: 0,
      }, "POST");
      await refreshDistribution();
      setRowAddingCampaign(null);
      toast.success("Qo‘shildi", "Campaign operatorga biriktirildi. Foizni campaign sahifasida kiriting.");
    } catch (e) { toast.error("Qo‘shishda xato", (e as Error).message); }
  }

  async function addResponsible(id: number, pct: number) {
    try {
      if (view === "general") await addTaqsimotResponsible(id, pct);
      else await saveCampaignRequest("/api/dashboard/taqsimot-campaign-members", {
        campaign_name: campaignName, responsible_id: id, pct,
      }, "POST");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["taqsimot"] }),
        qc.invalidateQueries({ queryKey: ["taqsimot-candidates"] }),
        refreshDistribution(),
      ]);
      setAddResponsibleOpen(false);
      toast.success("Qo‘shildi", view === "general" ? "Mas’ul umumiy oqimga qo‘shildi" : "Mas’ul shu campaignga qo‘shildi");
    } catch (e) { toast.error("Qo‘shishda xato", (e as Error).message); }
  }

  async function handleSave(id: number, pct: number) {
    try {
      const result = await saveTaqsimot(id, pct);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["taqsimot"] }),
        qc.invalidateQueries({ queryKey: ["taqsimot-stats"] }),
        qc.invalidateQueries({ queryKey: ["taqsimot-campaign"] }),
        qc.invalidateQueries({ queryKey: ["taqsimot-campaign-stats"] }),
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
          <>
            <Button variant="primary" onClick={() => setAddResponsibleOpen(true)}>
              <Plus className="w-3.5 h-3.5" /> Mas'ul qo'shish
            </Button>
            <Button onClick={() => { refetch(); statsQ.refetch(); campaignQ.refetch(); campaignStatsQ.refetch(); }}>
              <RefreshCw className="w-3.5 h-3.5" /> Yangilash
            </Button>
          </>
        }
      />

      {addResponsibleOpen && <AddResponsibleDialog
        key={view}
        responsibles={candidatesQ.data?.responsibles ?? []}
        loading={candidatesQ.isLoading}
        remaining={Math.max(0, 100 - (view === "general" ? totalRounded : campaignTotal))}
        stream={view === "general" ? "umumiy lead" : campaignName}
        onClose={() => setAddResponsibleOpen(false)}
        onSave={addResponsible}
      />}

      <div className="flex-1 overflow-y-auto px-3 sm:px-[22px] py-3 sm:py-[18px] bg-bg space-y-5">

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setView("general")}
            className={`px-3 py-2 rounded-lg border text-[12px] ${view === "general" ? "bg-blue-600 text-white border-blue-600" : "bg-bg2 text-text2 border-border hover:text-text"}`}>
            Umumiy lead
          </button>
          {(campaignListQ.data?.campaigns ?? []).map((c) => (
            <button key={c.campaign_name} type="button" onClick={() => setView(c.campaign_name)} title={c.campaign_name}
              className={`px-3 py-2 rounded-lg border text-[12px] max-w-[300px] truncate ${view === c.campaign_name ? "bg-blue-600 text-white border-blue-600" : "bg-bg2 text-text2 border-border hover:text-text"}`}>
              {c.campaign_name}{c.active ? " · Faol" : ""}
            </button>
          ))}
          <button type="button" onClick={() => setAdding(!adding)}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border bg-bg2 text-text2 hover:text-text text-[12px]">
            <Plus className="w-3.5 h-3.5" /> Campaign qo‘shish
          </button>
        </div>

        {adding && <div className="bg-bg2 border border-border rounded-xl p-4 flex flex-wrap gap-2 items-center">
          <select value={newCampaign} onChange={(e) => setNewCampaign(e.target.value)}
            className="min-w-[250px] max-w-full flex-1 bg-bg3 border border-border rounded-lg px-3 py-2 text-[12px] text-text">
            <option value="">Campaign tanlang</option>
            {(campaignOptionsQ.data?.campaigns ?? []).filter(name => !(campaignListQ.data?.campaigns ?? []).some(c => c.campaign_name === name))
              .map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <Button onClick={addCampaign} disabled={!newCampaign}>Qo‘shish</Button>
          {campaignOptionsQ.isLoading && <span className="text-[11px] text-text3">Yuklanmoqda...</span>}
          {campaignOptionsQ.isError && <span className="text-[11px] text-red-400">Campaignlar yuklanmadi</span>}
        </div>}

        {view !== "general" &&
        <div className="bg-bg2 border border-border rounded-xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
            <div>
              <div className="text-[12px] font-semibold text-text">Campaign bo'yicha alohida taqsimot</div>
              <div className="text-[11px] text-text3 mt-0.5 break-all">{campaignQ.data?.campaign_name ?? campaignName}</div>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-text shrink-0">
              <input type="checkbox" checked={campaignQ.data?.active ?? false}
                disabled={!campaignQ.data || (!campaignQ.data.active && campaignTotal !== 100)}
                onChange={(e) => setCampaignActive(e.target.checked)} />
              Faol
            </label>
          </div>
          <div className="px-4 py-2.5 text-[11px] text-text3">
            Bir mas'ulni bir nechta campaignga qo'shish mumkin. Har bir campaignning foizi alohida 100% bo'ladi; umumiy lead foiziga ta'sir qilmaydi.
          </div>
          <table className="w-full text-[12.5px]">
            <thead><tr className="border-b border-border bg-bg3">
              <th className="text-left px-4 py-2.5 text-text3">Xodim</th>
              <th className="text-left px-4 py-2.5 text-text3 w-[40%]">Campaignlar</th>
              <th className="text-left px-4 py-2.5 text-text3 w-36">Taqsimot %</th>
            </tr></thead>
            <tbody>
              {(campaignQ.data?.responsibles ?? []).map((r) => (
                <CampaignPctRow key={r.id} row={r} onSave={saveCampaignPct}
                  memberships={(membershipsQ.data?.memberships ?? []).filter(m => Number(m.responsible_id) === r.id)}
                  availableCampaigns={Array.from(new Set([
                    ...(campaignListQ.data?.campaigns ?? []).map(c => c.campaign_name),
                    ...(campaignOptionsQ.data?.campaigns ?? []),
                  ]))}
                  adding={rowAddingCampaign === r.id}
                  optionsLoading={campaignOptionsQ.isLoading}
                  onToggleAdd={() => setRowAddingCampaign(rowAddingCampaign === r.id ? null : r.id)}
                  onAddCampaign={(name) => addCampaignToOperator(r.id, name)} />
              ))}
              {campaignQ.data?.responsibles.length === 0 && <tr><td colSpan={3} className="px-4 py-5 text-center text-[12px] text-text3">
                Hali mas'ul qo'shilmagan. Yuqoridagi “Mas'ul qo'shish” tugmasini bosing.
              </td></tr>}
            </tbody>
            <tfoot><tr className="border-t-2 border-border bg-bg3">
              <td colSpan={2} className="px-4 py-2.5 font-semibold text-text">Jami</td>
              <td className={`px-4 py-2.5 font-semibold ${campaignTotal === 100 ? "text-green-500" : "text-red-400"}`}>
                {campaignTotal}% {campaignTotal === 100 ? "✓" : "(100% bo'lishi kerak)"}
              </td>
            </tr></tfoot>
          </table>
          {campaignQ.data?.active && (
            <div className="border-t border-border px-4 py-3">
              <div className="text-[12px] font-semibold text-text mb-2">Bugungi campaign leadlari</div>
              <div className="flex flex-wrap gap-4 text-[11px] text-text2">
                {(campaignStatsQ.data?.stats ?? []).map((s) => (
                  <span key={s.id}>{s.full_name}: <strong className="text-text">{s.today_count}</strong> / {s.target_pct}%</span>
                ))}
              </div>
            </div>
          )}
        </div>}

        {view === "general" && <>
        {/* ── Settings table ─────────────────────────────────────────── */}
        <div className="bg-bg2 border border-border rounded-xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <div className="text-[12px] font-semibold text-text">Umumiy lead taqsimoti</div>
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
                  Rol
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
              <div className="text-[12px] font-semibold text-text">Bugungi umumiy lead taqsimoti</div>
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
        </>}
      </div>
    </>
  );
}

// ── Editable % cell ───────────────────────────────────────────────────────────

function AddResponsibleDialog({ responsibles, loading, remaining, stream, onClose, onSave }: {
  responsibles: Responsible[];
  loading: boolean;
  remaining: number;
  stream: string;
  onClose: () => void;
  onSave: (id: number, pct: number) => Promise<void>;
}) {
  const [responsibleId, setResponsibleId] = useState(0);
  const [pct, setPct] = useState("0");
  const [saving, setSaving] = useState(false);
  const value = Number(pct);
  const selectedId = responsibleId || responsibles[0]?.id || 0;
  const valid = selectedId > 0 && pct !== "" && Number.isFinite(value) && value >= 0 && value <= remaining;

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    try { await onSave(selectedId, value); } finally { setSaving(false); }
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-[2px] z-[300]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[301] bg-bg2 border border-border rounded-xl shadow-xl w-[calc(100%-24px)] max-w-lg max-h-[88vh] overflow-y-auto p-5">
        <Dialog.Title className="text-[15px] font-semibold text-text">Mas'ul qo'shish</Dialog.Title>
        <Dialog.Description className="text-[12px] text-text3 mt-1 mb-4">
          {stream} oqimiga mas'ul qo'shing. Qolgan ulush: {remaining}%.
        </Dialog.Description>
        {loading ? <div className="py-6 text-[12px] text-text3">Yuklanmoqda...</div> : responsibles.length ?
          <div className="space-y-3">
            <label className="block text-[11px] text-text3">Mas'ul xodim
              <select value={selectedId} onChange={(e) => setResponsibleId(Number(e.target.value))}
                className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-[12px] text-text">
                {responsibles.map((r) => <option key={r.id} value={r.id}>{r.full_name} — {r.work_position || "Lavozim ko'rsatilmagan"}</option>)}
              </select>
            </label>
            <label className="block text-[11px] text-text3">Taqsimot ulushi (%)
              <input type="number" min={0} max={remaining} step={0.1} value={pct} onChange={(e) => setPct(e.target.value)}
                className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-[12px] text-text" />
            </label>
            {!valid && <div className="text-[11px] text-red-400">Foiz qolgan ulushdan oshmasligi kerak.</div>}
          </div> : <div className="py-6 text-center text-[12px] text-text3">Qo'shish uchun faol mas'ul qolmagan.</div>}
        <div className="flex justify-end gap-2 mt-4">
          <Button onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button variant="primary" onClick={submit} disabled={!valid || saving}>{saving ? "Saqlanmoqda..." : "Saqlash"}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

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
  const role = row.work_position ?? "—";

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

      {/* ROL */}
      <td className="px-4 py-3">
        <span className="mono text-text2 text-[11px]">{role}</span>
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

function CampaignPctRow({ row, onSave, memberships, availableCampaigns, adding, optionsLoading, onToggleAdd, onAddCampaign }: {
  row: CampaignResponsible;
  onSave: (id: number, pct: number) => Promise<void>;
  memberships: CampaignMembership[];
  availableCampaigns: string[];
  adding: boolean;
  optionsLoading: boolean;
  onToggleAdd: () => void;
  onAddCampaign: (name: string) => void;
}) {
  const [draft, setDraft] = useState(String(row.pct));
  useEffect(() => setDraft(String(row.pct)), [row.pct]);
  const choices = availableCampaigns.filter(name => !memberships.some(m => m.campaign_name === name));

  function commit() {
    const pct = Number(draft);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setDraft(String(row.pct));
      return;
    }
    if (row.attached && pct !== row.pct) onSave(row.id, pct);
  }

  return (
    <tr className="border-b border-border">
      <td className="px-4 py-2.5 text-text">{row.full_name}</td>
      <td className="px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {memberships.map(m => <span key={m.campaign_name} title={`${m.campaign_name} — ${m.pct}%`}
            className="inline-block max-w-[220px] truncate rounded bg-blue/10 px-2 py-1 text-[11px] text-blue">
            {m.campaign_name} · {m.pct}%
          </span>)}
          <button type="button" onClick={onToggleAdd}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text2 hover:text-blue">
            <Plus className="w-3 h-3" /> Campaign qo‘shish
          </button>
        </div>
        {adding && <select value="" onChange={(e) => onAddCampaign(e.target.value)}
          className="mt-2 w-full max-w-[350px] rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-text">
          <option value="">{optionsLoading ? "Campaignlar yuklanmoqda..." : "Campaign tanlang"}</option>
          {choices.map(name => <option key={name} value={name}>{name}</option>)}
        </select>}
      </td>
      <td className="px-4 py-2.5">
        <input type="number" min={0} max={100} step={0.5} value={draft} disabled={!row.attached}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          title={row.attached ? "Ushbu campaign uchun foiz" : "Avval campaignni operatorga qo‘shing"}
          className="w-20 px-2 py-1 rounded border border-border bg-bg text-text text-[12px] mono disabled:opacity-40" /> %
      </td>
    </tr>
  );
}
