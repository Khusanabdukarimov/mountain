import { useState, useMemo, useRef, useEffect } from 'react';
import {
  ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Search, Plus, Trash2, Scale, CheckCircle2, BarChart3, Pencil, X } from 'lucide-react';
import { Topbar } from '@/components/Topbar';
import {
  getRejaPlans, updateRejaPlan, deleteRejaPlan, createRejaPlan,
  getRejaDistribution, saveRejaDistribution, getRejaProgress, listAllResponsibles,
  type RejaPlan, type RejaEmployee,
} from '@/lib/api/reja';


// ── Helpers ───────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Yanvar','Fevral','Mart','Aprel','May','Iyun',
  'Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr',
];

const CURRENCY = 'USD';
const CURRENCY_SIGN = '$';

function fmtMoney(n: number): string {
  if (!n && n !== 0) return '0';
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}
// keep old name as alias so all call-sites work without rename
const fmtUZS = fmtMoney;

function parseNum(s: string): number {
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.max(0, n);
}


// Parses year/month directly from the first 7 characters of the date string
// (handles both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS.sssZ" without timezone shifts)
function parsePeriodYM(periodStart: string): { year: number; month: number } {
  const [y, m] = periodStart.slice(0, 7).split('-');
  return { year: parseInt(y, 10), month: parseInt(m, 10) };
}

function periodLabel(plan: RejaPlan): string {
  const { year, month } = parsePeriodYM(plan.period_start);
  if (plan.period_type === 'monthly') return `${MONTH_NAMES[month - 1]} ${year}`;
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year} – ${q}-kvartal`;
}


const AVATAR_COLORS = [
  '#2196F3','#E91E63','#9C27B0','#00BCD4','#FF9800',
  '#4CAF50','#FF5722','#3F51B5','#009688','#795548',
];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : (p[0]?.[0] ?? '?').toUpperCase();
}

// ── Create plan modal ──────────────────────────────────────────────

// ── Distribution view ──────────────────────────────────────────────

function DistributionView({ planId, onDeleted }: { planId: number; onDeleted: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['reja/distribution', planId],
    queryFn:  () => getRejaDistribution(planId),
  });

  const plan      = data?.plan;
  const employees = data?.employees ?? [];

  const [targets,          setTargets]          = useState<Record<number, string>>({});
  const [search,           setSearch]           = useState('');
  const [dirty,            setDirty]            = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [totalInput,       setTotalInput]       = useState('');
  const [nameInput,        setNameInput]        = useState('');
  const [addOpen,          setAddOpen]          = useState(false);
  const [pendingEmployees, setPendingEmployees] = useState<RejaEmployee[]>([]);
  const [removedIds,       setRemovedIds]       = useState<Set<number>>(new Set());
  const addRef = useRef<HTMLDivElement>(null);

  const allRespQ = useQuery({
    queryKey: ['responsibles-list'],
    queryFn:  listAllResponsibles,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!addOpen) return;
    const h = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAddOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [addOpen]);

  useEffect(() => {
    if (!data) return;
    const map: Record<number, string> = {};
    for (const e of data.employees) map[e.responsible_id] = e.target > 0 ? String(Math.round(parseFloat(String(e.target)))) : '';
    setTargets(map);
    setTotalInput(String(Math.round(parseFloat(String(data.plan.total_target)))));
    setNameInput(data.plan.name ?? '');
    setDirty(false);
  }, [data]);

  const totalTarget  = plan?.total_target ?? 0;
  const distributed  = useMemo(
    () => employees.reduce((s, e) => s + parseNum(targets[e.responsible_id] ?? ''), 0),
    [targets, employees],
  );
  const remaining    = totalTarget - distributed;
  const totalActual  = useMemo(
    () => employees.reduce((s, e) => s + (e.actual_sales ?? 0), 0),
    [employees],
  );

  // Employees in the plan (target >= 0 means they have a reja_targets record)
  const inPlanEmployees = useMemo(
    () => employees.filter(e => !removedIds.has(e.responsible_id)),
    [employees, removedIds],
  );
  // Employees with actual target > 0 — shown in view mode
  const assignedEmployees = useMemo(
    () => inPlanEmployees.filter(e => parseFloat(String(e.target)) > 0),
    [inPlanEmployees],
  );
  const hasAnyTarget = assignedEmployees.length > 0;

  // edit mode → everyone in plan + pending; view mode → only target > 0
  const filtered = useMemo(() => {
    const base = [...inPlanEmployees, ...pendingEmployees.filter(p => !inPlanEmployees.some(e => e.responsible_id === p.responsible_id))];
    if (!search.trim()) return base;
    const q = search.toLowerCase();
    return base.filter(e => e.full_name.toLowerCase().includes(q) || (e.work_position ?? '').toLowerCase().includes(q));
  }, [showAll, inPlanEmployees, assignedEmployees, pendingEmployees, removedIds, search, hasAnyTarget]);

  // IDs already visible in the table — used to exclude them from "Xodim qo'shish" dropdown
  const employeeIds = useMemo(
    () => new Set(filtered.map(e => e.responsible_id)),
    [filtered],
  );

  // All active responsibles NOT yet in this plan (or removed from it)
  const unassigned = useMemo(
    () => (allRespQ.data ?? []).filter(r => !employeeIds.has(r.id)),
    [allRespQ.data, employeeIds],
  );


  const saveMutation = useMutation({
    mutationFn: () => saveRejaDistribution(planId, filtered.map(e => ({
      responsible_id: e.responsible_id,
      target: removedIds.has(e.responsible_id) ? -1 : parseNum(targets[e.responsible_id] ?? ''),
    })).filter(e => e.target >= 0)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reja/distribution', planId] });
      qc.invalidateQueries({ queryKey: ['reja/plans'] });
      qc.invalidateQueries({ queryKey: ['reja/progress', planId] });
      setPendingEmployees([]);
      // removedIds is intentionally NOT cleared here — keep deleted employees
      // out of the table and in the "Xodim qo'shish" dropdown until pencil closes
      setDirty(false);
    },
  });

  const updateTotalMutation = useMutation({
    mutationFn: (v: number) => updateRejaPlan(planId, { total_target: v }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reja/distribution', planId] }); qc.invalidateQueries({ queryKey: ['reja/plans'] }); },
  });

  const updateNameMutation = useMutation({
    mutationFn: (name: string) => updateRejaPlan(planId, { name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reja/plans'] }); },
  });


  const deleteMutation = useMutation({
    mutationFn: () => deleteRejaPlan(planId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reja/plans'] }); onDeleted(); },
  });

  function distributeEqually() {
    // Only distribute among employees currently visible in the table (excludes removed ones)
    const active = filtered.filter(e => e.active);
    if (!active.length || !totalTarget) return;
    const share     = Math.floor(totalTarget / active.length);
    const remainder = totalTarget - share * active.length;
    const map: Record<number, string> = {};
    active.forEach((e, i) => { map[e.responsible_id] = String(i === 0 ? share + remainder : share); });
    setTargets(prev => ({ ...prev, ...map }));
    setDirty(true);
  }

  function setTarget(id: number, val: string) { setTargets(prev => ({ ...prev, [id]: val })); setDirty(true); }

  if (isLoading) return <div style={{ padding: 56, textAlign: 'center', color: 'var(--text3)' }}>Yuklanmoqda…</div>;

  const overflowed  = remaining < 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 24px 96px' }}>

      {/* Top row: stats + quick action */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, alignItems: 'stretch' }}>

        {/* Stats card */}
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '28px 32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Maqsadlarni taqsimlash</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
              {/* Start date picker — end date auto = last day of that month */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Boshlanish</div>
                <input
                  type="date"
                  value={plan?.period_start.slice(0, 10) ?? ''}
                  onChange={e => {
                    const v = e.target.value;
                    if (!v) return;
                    const [y, m] = v.split('-').map(Number);
                    const end = localISO(new Date(y, m, 0));
                    updateRejaPlan(planId, { period_start: v, period_end: end }).then(() => {
                      qc.invalidateQueries({ queryKey: ['reja/distribution', planId] });
                      qc.invalidateQueries({ queryKey: ['reja/plans'] });
                    });
                  }}
                  style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13, fontWeight: 600, outline: 'none', cursor: 'pointer' }}
                />
              </div>
              {/* Name input */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reja nomi</div>
                <input
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onBlur={() => { if (nameInput !== (plan?.name ?? '')) updateNameMutation.mutate(nameInput); }}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  placeholder="Masalan: Marketing"
                  style={{ width: 200, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13, fontWeight: 600, outline: 'none', transition: 'border 0.15s' }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#2563eb')}
                  onBlurCapture={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                />
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)' }}>
            {[
              { label: 'Umumiy maqsad', raw: totalTarget, editable: true },
              { label: 'Taqsimlangan',  raw: distributed,  color: distributed > 0 ? '#2563eb' : undefined },
              { label: 'Bajarildi',     raw: totalActual,  color: totalActual > 0 ? '#16a34a' : undefined },
              { label: 'Qoldiq',        raw: Math.abs(remaining), color: overflowed ? '#ef4444' : undefined },
            ].map((item, i) => (
              <div key={i} style={{ paddingLeft: i > 0 ? 24 : 0, borderLeft: i > 0 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>{item.label}</div>

                {item.editable ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text3)' }}>{CURRENCY_SIGN}</span>
                      <input
                        value={totalInput}
                        onChange={e => setTotalInput(e.target.value)}
                        onBlur={() => { if (parseNum(totalInput) !== totalTarget) updateTotalMutation.mutate(parseNum(totalInput)); }}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        style={{ width: 130, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 20, fontWeight: 700, outline: 'none', transition: 'border 0.15s' }}
                        onFocus={e => (e.currentTarget.style.borderColor = '#2563eb')}
                        onBlurCapture={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Maydondan chiqib saqlang</div>
                  </div>
                ) : (
                  <div>
                    <span style={{ fontSize: 22, fontWeight: 700, color: item.color ?? 'var(--text)' }}>
                      {CURRENCY_SIGN}{fmtUZS(item.raw)}
                    </span>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text3)', marginTop: 2 }}>{CURRENCY}</div>
                    {overflowed && item.label === 'Qoldiq' && (
                      <div style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>Ortiqcha: {CURRENCY_SIGN}{fmtUZS(-remaining)}</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Tezkor taqsimot */}
        <div style={{ background: 'linear-gradient(135deg, #1d3a8a 0%, #1d4ed8 100%)', borderRadius: 14, padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 26 }}>✨</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>Tezkor Taqsimot</div>
          <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.72)', lineHeight: 1.6 }}>
            Barcha faol xodimlar orasida maqsadni teng miqdorda taqsimlang.
          </div>
          <button
            type="button"
            onClick={distributeEqually}
            style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 16px', borderRadius: 9, border: 0, background: '#fff', color: '#1d3a8a', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >
            <Scale size={15} /> Teng taqsimlash
          </button>
        </div>
      </div>

      {/* Employee table */}
      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
              {showAll ? 'Barcha xodimlar' : `Tayinlangan xodimlar (${assignedEmployees.length})`}
            </div>
            {/* Xodim qo'shish — dropdown of unassigned */}
            <div ref={addRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setAddOpen(v => !v)}
                style={{ fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <Plus size={12} /> Xodim qo'shish
              </button>
              {addOpen && (
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200, minWidth: 220, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', maxHeight: 260, overflowY: 'auto' }}>
                  {unassigned.length === 0 ? (
                    <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text3)' }}>Barcha xodimlar tayinlangan</div>
                  ) : unassigned.map(r => (
                    <div
                      key={r.id}
                      onClick={() => {
                        setPendingEmployees(prev => [...prev, { responsible_id: r.id, full_name: r.full_name, work_position: null, active: true, photo_url: null, target: 0, actual_sales: 0, deal_count: 0 }]);
                        setTarget(r.id, '');
                        setRemovedIds(prev => { const s = new Set(prev); s.delete(r.id); return s; });
                        setAddOpen(false);
                      }}
                      style={{ padding: '9px 14px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: avatarColor(r.full_name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#fff' }}>
                        {initials(r.full_name)}
                      </div>
                      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{r.full_name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
              <input
                placeholder="Qidiruv…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ paddingLeft: 30, paddingRight: 12, height: 34, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)', color: 'var(--text)', fontSize: 12.5, outline: 'none', width: 180 }}
              />
            </div>
            {dirty && (
              <button
                onClick={() => { saveMutation.mutate(); setPendingEmployees([]); }}
                disabled={saveMutation.isPending}
                style={{ height: 34, padding: '0 14px', borderRadius: 8, border: 0, background: '#1d4ed8', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <CheckCircle2 size={13} />
                {saveMutation.isPending ? 'Saqlanmoqda…' : 'Saqlash'}
              </button>
            )}
            <button
              onClick={() => setShowAll(v => !v)}
              title={showAll ? "Tahrirlashni yopish" : "Tahrirlash"}
              style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${showAll ? '#2563eb' : 'var(--border)'}`, background: showAll ? 'rgba(37,99,235,0.12)' : 'transparent', color: showAll ? '#2563eb' : 'var(--text2)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
            >
              {showAll ? <X size={14} /> : <Pencil size={14} />}
            </button>
            <button
              onClick={() => { if (confirm("Rejani o'chirishni tasdiqlaysizmi?")) deleteMutation.mutate(); }}
              style={{ width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#ef4444', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Column headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 160px 170px 130px 100px', padding: '10px 24px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
          {[
            { label: 'XODIM ISMI',             color: 'var(--text3)' },
            { label: 'ROLI',                    color: 'var(--text3)' },
            { label: `REJA (${CURRENCY})`,      color: '#2563eb'      },
            { label: `FAKTIK SOTUV (${CURRENCY})`, color: '#16a34a'  },
            { label: 'QOLDI',                   color: 'var(--text3)' },
            { label: 'STATUS',                  color: 'var(--text3)' },
          ].map(h => (
            <div key={h.label} style={{ fontSize: 10, fontWeight: 700, color: h.color, letterSpacing: '0.07em', textTransform: 'uppercase' }}>{h.label}</div>
          ))}
        </div>

        {/* Rows */}
        {filtered.map((emp, i) => {
          const target      = parseNum(targets[emp.responsible_id] ?? '');
          const actual      = emp.actual_sales ?? 0;
          const qoldi       = target - actual;
          const pct         = totalTarget > 0 ? (target / totalTarget) * 100 : 0;
          const achievedPct = target > 0 ? Math.min(Math.round(actual / target * 100), 999) : 0;
          const isLast      = i === filtered.length - 1;

          return (
            <div
              key={emp.responsible_id}
              style={{
                display: 'grid', gridTemplateColumns: '1fr 130px 160px 170px 130px 100px',
                padding: '18px 24px', alignItems: 'center',
                borderBottom: isLast ? 'none' : '1px solid var(--border)',
              }}
            >
              {/* Avatar + name + deal count + to'lov links */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                <div style={{
                  width: 46, height: 46, borderRadius: 10, flexShrink: 0,
                  background: avatarColor(emp.full_name),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 800, color: '#fff', letterSpacing: '0.03em',
                }}>
                  {initials(emp.full_name)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {emp.full_name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                    {emp.deal_count > 0
                      ? <span style={{ color: '#16a34a' }}>{emp.deal_count} ta sotuv</span>
                      : '0 ta sotuv'}
                  </div>
                </div>
              </div>

              {/* Role */}
              <div style={{ fontSize: 13, color: 'var(--text2)' }}>
                {emp.work_position || '—'}
              </div>

              {/* Reja — editable in showAll mode, display otherwise */}
              <div>
                {showAll ? (
                  <div style={{ position: 'relative' }}>
                    <input
                      type="text" inputMode="numeric"
                      value={targets[emp.responsible_id] ?? ''}
                      onChange={e => {
                        const v = e.target.value.replace(/[^0-9]/g, '');
                        setTarget(emp.responsible_id, v);
                      }}
                      placeholder="0"
                      style={{ width: '100%', padding: '8px 22px 8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                    />
                    <span style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text3)', pointerEvents: 'none' }}>{CURRENCY_SIGN}</span>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                      {target > 0 ? `${CURRENCY_SIGN}${fmtUZS(target)}` : '—'}
                    </div>
                    {pct > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{pct.toFixed(1)}% of total</div>
                    )}
                  </>
                )}
              </div>

              {/* Faktik sotuv */}
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: actual > 0 ? '#16a34a' : 'var(--text3)' }}>
                  {actual > 0 ? `${CURRENCY_SIGN}${fmtUZS(actual)}` : '—'}
                </div>
                {actual > 0 && target > 0 && (
                  <div style={{ marginTop: 5, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', width: 80 }}>
                    <div style={{ height: '100%', width: `${Math.min(achievedPct, 100)}%`, background: achievedPct >= 100 ? '#16a34a' : achievedPct >= 60 ? '#f59e0b' : '#ef4444', borderRadius: 2 }} />
                  </div>
                )}
              </div>

              {/* Qoldi */}
              <div>
                {target > 0 ? (
                  <div style={{ fontSize: 14, fontWeight: 600, color: qoldi <= 0 ? '#16a34a' : 'var(--text)' }}>
                    {qoldi <= 0 ? `+${CURRENCY_SIGN}${fmtUZS(-qoldi)}` : `${CURRENCY_SIGN}${fmtUZS(qoldi)}`}
                  </div>
                ) : (
                  <span style={{ fontSize: 13, color: 'var(--text3)' }}>—</span>
                )}
              </div>

              {/* Status — dot + text + remove */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: emp.active ? '#16a34a' : '#d97706', flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 500, color: emp.active ? '#16a34a' : '#d97706', flex: 1 }}>
                  {emp.active ? 'Active' : 'On leave'}
                </span>
                {showAll && (
                  <button
                    type="button"
                    title="Olib tashlash"
                    onClick={() => {
                      setRemovedIds(prev => new Set([...prev, emp.responsible_id]));
                      setDirty(true);
                    }}
                    style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.7, flexShrink: 0 }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center' }}>
            {!hasAnyTarget ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text2)' }}>Hech kim tayinlanmagan</div>
                <div style={{ fontSize: 13, color: 'var(--text3)' }}>
                  "Teng taqsimlash" yoki "+ Xodim qo'shish" tugmasini bosing
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text3)' }}>Xodim topilmadi</div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg2)' }}>
          {/* Avatar stack + count */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {assignedEmployees.slice(0, 4).map((e, i) => (
              <div key={e.responsible_id} style={{ width: 28, height: 28, borderRadius: '50%', marginLeft: i > 0 ? -8 : 0, background: avatarColor(e.full_name), border: '2px solid var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#fff', position: 'relative', zIndex: 4 - i }}>
                {initials(e.full_name)}
              </div>
            ))}
            {assignedEmployees.length > 4 && (
              <div style={{ width: 28, height: 28, borderRadius: '50%', marginLeft: -8, background: 'var(--bg3)', border: '2px solid var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text2)' }}>
                +{assignedEmployees.length - 4}
              </div>
            )}
            <span style={{ marginLeft: 14, fontSize: 13, color: 'var(--text2)' }}>
              <strong>{assignedEmployees.length}</strong> ta xodimga maqsad tayinlangan
            </span>
          </div>

          {/* Save button */}
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !dirty}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', borderRadius: 9, border: 0, fontSize: 13, fontWeight: 700, cursor: dirty ? 'pointer' : 'default', transition: 'all 0.15s', background: dirty ? '#1d4ed8' : 'var(--bg3)', color: dirty ? '#fff' : 'var(--text3)' }}
          >
            <CheckCircle2 size={15} />
            {saveMutation.isPending ? 'Saqlanmoqda…' : 'Maqsadlarni tasdiqlash'}
          </button>
        </div>
      </div>

    </div>
  );
}

// ── Progress view ──────────────────────────────────────────────────

function ProgressView({ planId }: { planId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['reja/progress', planId],
    queryFn:  () => getRejaProgress(planId),
  });

  if (isLoading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>Yuklanmoqda…</div>;
  if (!data) return null;

  const { subperiods, employees } = data;
  if (!employees.length) return null;

  const maxTarget = Math.max(...employees.map(e => e.target), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 24px 96px' }}>

      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', paddingTop: 4 }}>Bajarilish jadvali</div>

      {/* Per-employee table with sub-periods */}
      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)' }}>
                <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', position: 'sticky', left: 0, background: 'var(--bg2)', zIndex: 2, minWidth: 180 }}>Xodim</th>
                <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', minWidth: 130 }}>Reja</th>
                {subperiods.map(sp => (
                  <th key={sp.index} style={{ padding: '11px 14px', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', minWidth: 110 }}>{sp.label}</th>
                ))}
                <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', minWidth: 130 }}>Bajarildi</th>
                <th style={{ padding: '11px 14px', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', minWidth: 70 }}>%</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp, i) => (
                <tr key={emp.responsible_id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)' }}>
                  {/* Name */}
                  <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', position: 'sticky', left: 0, background: 'var(--bg)', zIndex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 30, height: 30, borderRadius: '50%', background: avatarColor(emp.full_name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                        {initials(emp.full_name)}
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{emp.full_name}</span>
                    </div>
                  </td>

                  {/* Total target + bar */}
                  <td style={{ padding: '12px 14px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{CURRENCY_SIGN}{fmtUZS(emp.target)}</div>
                    <div style={{ height: 3, marginTop: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min((emp.target / maxTarget) * 100, 100)}%`, background: '#2563eb', borderRadius: 2 }} />
                    </div>
                  </td>

                  {/* Sub-period columns */}
                  {emp.subperiods.map(sp => {
                    const met      = sp.actual >= sp.target * 0.9;
                    const exceeded = sp.actual > sp.target;
                    const barColor = sp.isPast
                      ? exceeded ? '#16a34a' : met ? '#f59e0b' : '#ef4444'
                      : '#2563eb';
                    const barW = sp.target > 0 ? Math.min((sp.actual / sp.target) * 100, 100) : 0;

                    return (
                      <td key={sp.index} style={{
                        padding: '10px 14px', textAlign: 'center',
                        borderBottom: '1px solid var(--border)',
                        borderLeft: sp.isCurrent ? '2px solid rgba(37,99,235,0.35)' : '1px solid var(--border)',
                        borderRight: sp.isCurrent ? '2px solid rgba(37,99,235,0.35)' : 'none',
                        background: sp.isCurrent ? 'rgba(37,99,235,0.04)' : 'transparent',
                      }}>
                        {/* Recalculated target (small, grey) */}
                        <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 3 }}>{CURRENCY_SIGN}{fmtUZS(sp.target)}</div>
                        {/* Actual (bold, coloured for past) */}
                        <div style={{ fontSize: 13, fontWeight: 700, color: sp.isPast ? (exceeded ? '#16a34a' : met ? '#d97706' : '#ef4444') : sp.actual > 0 ? '#2563eb' : 'var(--text3)' }}>
                          {sp.actual > 0 ? `${CURRENCY_SIGN}${fmtUZS(sp.actual)}` : '—'}
                        </div>
                        {/* Mini bar */}
                        <div style={{ height: 3, marginTop: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${barW}%`, background: barColor, borderRadius: 2 }} />
                        </div>
                      </td>
                    );
                  })}

                  {/* Total actual */}
                  <td style={{ padding: '12px 14px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: emp.total_actual > 0 ? '#16a34a' : 'var(--text3)' }}>
                      {CURRENCY_SIGN}{fmtUZS(emp.total_actual)}
                    </div>
                  </td>

                  {/* % badge */}
                  <td style={{ padding: '12px 14px', textAlign: 'center', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 8px', borderRadius: 5, background: emp.pct >= 100 ? '#dcfce7' : emp.pct >= 70 ? '#fef9c3' : 'rgba(239,68,68,0.1)', color: emp.pct >= 100 ? '#166534' : emp.pct >= 70 ? '#854d0e' : '#ef4444' }}>
                      {emp.pct}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.6 }}>
        * Har bir tugallangan davr uchun asl natija hisobga olinadi. Qolgan davrlar uchun maqsad = (jami reja − o'tgan davrlar summasi) / qolgan davrlar soni.
      </div>

      {/* ── Summary row: Donut · Top-5 · Dynamics chart ─────────── */}
      <SummaryRow employees={employees} subperiods={subperiods} summary={(() => {
        const actual = (data.summary as any).crm_total_actual ?? data.summary.total_actual;
        const target = data.summary.total_target;
        return { ...data.summary, total_actual: actual, pct: target > 0 ? Math.min(Math.round(actual / target * 100), 999) : 0 };
      })()} />
    </div>
  );
}

// ── SummaryRow ─────────────────────────────────────────────────────

type SummaryRowProps = {
  employees:  import('@/lib/api/reja').RejaProgressEmployee[];
  subperiods: { index: number; label: string; start: string; end: string }[];
  summary:    { total_target: number; total_actual: number; pct: number; prev_actual: number; growth_pct: number | null };
};

// ── Gauge helpers ─────────────────────────────────────────────────
const G_CX = 150, G_CY = 152, G_R = 104;
// Arc spans 210°: from 195° (left-bottom) → top → -15° (right-bottom)
const G_START = 195 * Math.PI / 180;
const G_END   = -15  * Math.PI / 180;
const G_SPAN  = G_START - G_END; // 210° in radians ≈ 3.665

function gaugeXY(angle: number, r = G_R): [number, number] {
  return [G_CX + r * Math.cos(angle), G_CY - r * Math.sin(angle)];
}
function gaugeArc(r: number): string {
  // Single full 210° arc path (start → end) — used for both bg and gradient
  const [sx, sy] = gaugeXY(G_START, r);
  const [ex, ey] = gaugeXY(G_END,   r);
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}
function gaugeAngle(pct: number): number {
  return G_START - (Math.min(Math.max(pct, 0), 115) / 100) * G_SPAN;
}

function SummaryRow({ employees, subperiods, summary }: SummaryRowProps) {

  // ── Line chart data (cumulative %, 0-100 scale) ──────────────────
  // Using percentage of total target avoids the Fakt line being invisible
  // when actual << reja on an absolute dollar scale.
  const lineData = useMemo(() => {
    const totalReja = employees.reduce((s, e) => s + e.target, 0) || 1;
    let cumReja = 0, cumFakt = 0;
    return subperiods.map(sp => {
      const spReja = employees.reduce((s, e) => s + (e.subperiods.find(w => w.index === sp.index)?.target ?? 0), 0);
      const spFakt = employees.reduce((s, e) => s + (e.subperiods.find(w => w.index === sp.index)?.actual ?? 0), 0);
      cumReja += spReja;
      cumFakt += spFakt;
      return {
        name: sp.label,
        Reja: Math.round((cumReja / totalReja) * 100),
        Fakt: Math.round((cumFakt / totalReja) * 100),
      };
    });
  }, [subperiods, employees]);

  const CARD = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>

      {/* 1 ── MAQSADLAR gauge (reference design) ──────────────── */}
      <div style={{ background: '#0d1224', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, overflow: 'hidden' }}>

        {/* Header — icon + MAQSADLAR + subtitle, no divider */}
        <div style={{ padding: '20px 22px 0', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,#4f46e5,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 4px 16px rgba(124,58,237,0.4)' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', letterSpacing: '0.06em', lineHeight: 1.1 }}>Maqsad ko'rsatgichi</div>
          </div>
        </div>

        {/* Gauge SVG */}
        <div style={{ padding: '4px 14px 0' }}>
          {(() => {
            const pct         = summary.pct;
            const pctFontSize = pct >= 1000 ? 26 : pct >= 100 ? 34 : 40;
            const arcLen      = G_R * G_SPAN;
            const dashLen     = (Math.min(pct, 115) / 100) * arcLen;
            const clampedAngle = Math.min(Math.max(gaugeAngle(pct), G_END), G_START);
            const [nx, ny]    = gaugeXY(clampedAngle, G_R * 0.80);
            const [gx, gy]    = gaugeXY(clampedAngle, G_R);
            const TICKS = [0, 25, 50, 75, 100].map(t => ({
              t, angle: gaugeAngle(t),
              dollar: Math.round(summary.total_target * t / 100),
            }));
            return (
              <svg viewBox="0 0 300 200" style={{ width: '100%', display: 'block' }}>
                <defs>
                  <linearGradient id="gGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%"   stopColor="#cc1f1f" />
                    <stop offset="30%"  stopColor="#e84020" />
                    <stop offset="58%"  stopColor="#f97316" />
                    <stop offset="82%"  stopColor="#fbbf24" />
                    <stop offset="100%" stopColor="#f59e0b" />
                  </linearGradient>
                  {/* Bloom layer: blurred copy of the arc for glow effect */}
                  <filter id="arcBloom" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="6" result="blur"/>
                  </filter>
                  <filter id="dotGlow" x="-100%" y="-100%" width="300%" height="300%">
                    <feGaussianBlur stdDeviation="4" result="b"/>
                    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
                  </filter>
                </defs>

                {/* Background track */}
                <path d={gaugeArc(G_R)} fill="none"
                      stroke="rgba(255,255,255,0.06)" strokeWidth="26" strokeLinecap="round" />

                {/* Bloom glow behind arc */}
                {pct > 0 && (
                  <path d={gaugeArc(G_R)} fill="none"
                        stroke="url(#gGrad)" strokeWidth="26" strokeLinecap="round"
                        strokeDasharray={`${dashLen.toFixed(1)} ${(arcLen * 3).toFixed(1)}`}
                        filter="url(#arcBloom)" opacity="0.55" />
                )}

                {/* Main arc */}
                {pct > 0 && (
                  <path d={gaugeArc(G_R)} fill="none"
                        stroke="url(#gGrad)" strokeWidth="26" strokeLinecap="round"
                        strokeDasharray={`${dashLen.toFixed(1)} ${(arcLen * 3).toFixed(1)}`} />
                )}

                {/* Tick marks + labels */}
                {TICKS.map(({ t, angle, dollar }) => {
                  const [ox, oy] = gaugeXY(angle, G_R + 11);
                  const [ix, iy] = gaugeXY(angle, G_R - 11);
                  const [lx, ly] = gaugeXY(angle, G_R + 28);
                  return (
                    <g key={t}>
                      <line x1={ox.toFixed(1)} y1={oy.toFixed(1)} x2={ix.toFixed(1)} y2={iy.toFixed(1)}
                            stroke="rgba(255,255,255,0.5)" strokeWidth="2" />
                      <text x={lx.toFixed(1)} y={ly.toFixed(1)} textAnchor="middle"
                            dominantBaseline="central" fontSize="8.5" fontWeight="700"
                            fill="rgba(220,220,220,0.8)">
                        {t === 0 ? '0' : `${t}%`}
                      </text>
                      {t > 0 && (
                        <text x={lx.toFixed(1)} y={(ly + 11).toFixed(1)} textAnchor="middle"
                              dominantBaseline="central" fontSize="7.5"
                              fill="rgba(160,160,160,0.5)">
                          {fmtMoney(dollar)}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Glow dot at needle tip */}
                {pct > 0 && (
                  <>
                    <circle cx={gx.toFixed(2)} cy={gy.toFixed(2)} r="12" fill="rgba(251,191,36,0.18)" />
                    <circle cx={gx.toFixed(2)} cy={gy.toFixed(2)} r="6"  fill="#fbbf24" filter="url(#dotGlow)" />
                  </>
                )}

                {/* Needle */}
                <line x1={G_CX} y1={G_CY} x2={nx.toFixed(2)} y2={ny.toFixed(2)}
                      stroke="#818cf8" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx={G_CX} cy={G_CY} r="4" fill="#a5b4fc" />

                {/* Center text — percentage only */}
                <text x={G_CX} y={G_CY - 20} textAnchor="middle" fontSize={pctFontSize} fontWeight="800" fill="white">
                  {pct}%
                </text>
              </svg>
            );
          })()}
        </div>

        {/* Stat card 1 — Maqsad + Bajarilgan */}
        <div style={{ margin: '6px 14px 8px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, display: 'flex' }}>
          <div style={{ flex: 1, padding: '12px 16px', borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#4f46e5,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 2 }}>Maqsad</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>
                {fmtMoney(summary.total_target)}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>USD</div>
            </div>
          </div>
          <div style={{ flex: 1, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(124,58,237,0.25)', border: '1px solid rgba(124,58,237,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 2 }}>Bajarilgan</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#c084fc' }}>
                {fmtMoney(summary.total_actual)}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>USD</div>
            </div>
          </div>
        </div>

        {/* Stat card 2 — O'sish + O'tgan oyga nisbatan */}
        {(() => {
          const diff    = summary.total_actual - summary.prev_actual;
          const hasPrev = summary.prev_actual > 0;
          const gPct    = summary.growth_pct;
          const up      = diff >= 0;
          const clr     = up ? '#22c55e' : '#ef4444';
          const sign    = up ? '+' : '';
          return (
            <div style={{ margin: '0 14px 16px', background: up ? 'rgba(21,128,61,0.12)' : 'rgba(239,68,68,0.08)', border: `1px solid ${up ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)'}`, borderRadius: 14, display: 'flex', alignItems: 'center' }}>
              <div style={{ flex: 1, padding: '12px 16px', borderRight: `1px solid ${up ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: up ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={clr} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    {up
                      ? <><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></>
                      : <><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></>}
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 2 }}>O'sish</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: clr }}>
                    {hasPrev && gPct !== null ? `${sign}${gPct}%` : '—'}
                  </div>
                </div>
              </div>
              <div style={{ flex: 1, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 2 }}>O'tgan oyga nisbatan</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: hasPrev ? clr : 'rgba(255,255,255,0.3)' }}>
                    {hasPrev ? `${sign}$${fmtMoney(Math.abs(diff))}` : '—'}
                  </div>
                  {hasPrev && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>USD</div>}
                </div>
                <svg width="28" height="24" viewBox="0 0 28 24" fill="none">
                  <rect x="0"  y="16" width="5" height="8"  rx="1.5" fill={up ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.4)'}/>
                  <rect x="8"  y="10" width="5" height="14" rx="1.5" fill={up ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.6)'}/>
                  <rect x="16" y="4"  width="5" height="20" rx="1.5" fill={clr}/>
                  {up && <polyline points="2.5,14 10.5,8 18.5,2 24,0" stroke={clr} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>}
                </svg>
              </div>
            </div>
          );
        })()}
      </div>

      {/* 2 ── Top 5 xodimlar ───────────────────────────────────── */}
      <div style={{ ...CARD, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
          Chempionlar
        </div>
        <div style={{ flex: 1, padding: '12px 20px', display: 'flex', flexDirection: 'column', justifyContent: 'space-evenly' }}>
          {[...employees]
            .sort((a, b) => b.total_actual - a.total_actual)
            .slice(0, 5)
            .map((emp, i) => {
              const barColor = emp.pct >= 100 ? '#16a34a' : emp.pct >= 70 ? '#f59e0b' : '#ef4444';
              return (
                <div key={emp.responsible_id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 18, fontSize: 12, fontWeight: 700, color: i === 0 ? '#f59e0b' : 'var(--text3)', flexShrink: 0 }}>{i + 1}</span>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: avatarColor(emp.full_name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                    {initials(emp.full_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.full_name}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 8 }}>
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{CURRENCY_SIGN}{fmtMoney(emp.total_actual)}<span style={{ fontWeight: 400 }}> / {CURRENCY_SIGN}{fmtMoney(emp.target)}</span></span>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: emp.pct >= 100 ? '#dcfce7' : emp.pct >= 70 ? '#fef9c3' : 'rgba(239,68,68,0.1)', color: barColor }}>{emp.pct}%</span>
                      </div>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(emp.pct, 100)}%`, background: barColor, borderRadius: 2, transition: 'width 0.3s' }} />
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* 3 ── Rejani bajarilish dinamikasi ─────────────────────── */}
      <div style={{ ...CARD, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Rejani bajarilish dinamikasi</span>
        </div>
        <div style={{ flex: 1, padding: '12px 8px 8px', minHeight: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lineData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--text3)' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${v}%`} domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text3)' }} axisLine={false} tickLine={false} width={36} />
              <Tooltip formatter={(v) => `${Number(v)}%`} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Legend iconType="line" wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
              <Line type="monotone" dataKey="Reja" stroke="#93c5fd" strokeDasharray="5 4" strokeWidth={2} dot={{ r: 3, fill: '#93c5fd' }} />
              <Line type="monotone" dataKey="Fakt" stroke="#1d4ed8" strokeWidth={2.5} dot={{ r: 3, fill: '#1d4ed8' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

    </div>
  );
}

// ── Page root ──────────────────────────────────────────────────────

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function RejaPage() {
  const now = new Date();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [selectedPlan, setSelectedPlan] = useState<RejaPlan | null>(null);
  const [selYear,  setSelYear]  = useState(now.getFullYear());
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1); // 1-12
  const [nameFilter, setNameFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState('');
  const [, setNewPlanId] = useState<number | null>(null);

  const plansQ = useQuery({ queryKey: ['reja/plans'], queryFn: getRejaPlans });
  const plans  = plansQ.data ?? [];

  const uniqueNames = useMemo(() => {
    const names = plans.map(p => p.name).filter((n): n is string => !!n && n.trim() !== '');
    return [...new Set(names)].sort();
  }, [plans]);

  const availableMonths = useMemo(() => {
    const src = nameFilter ? plans.filter(p => p.name === nameFilter) : plans;
    const seen = new Map<string, string>();
    for (const p of src) {
      const key = p.period_start.slice(0, 7);
      if (!seen.has(key)) seen.set(key, periodLabel(p));
    }
    return [...seen.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [plans, nameFilter]);


  const createMutation = useMutation({
    mutationFn: ({ year, month }: { year: number; month: number }) => {
      const start = localISO(new Date(year, month - 1, 1));
      const end   = localISO(new Date(year, month, 0));
      return createRejaPlan({ period_type: 'monthly', period_start: start, period_end: end, total_target: 0 });
    },
    onSuccess: (plan) => {
      qc.invalidateQueries({ queryKey: ['reja/plans'] });
      const { year, month } = parsePeriodYM(plan.period_start);
      setSelectedPlan(plan);
      setSelYear(year);
      setSelMonth(month);
      setNewPlanId(plan.id);
      didAutoSelect.current = true;
    },
  });

  // Auto-select on first load: prefer plan matching today's month, else first plan.
  // useRef guard ensures this runs exactly once even if plans refetch.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || !plans.length) return;
    didAutoSelect.current = true;
    const paramYear  = parseInt(searchParams.get('year')  ?? '');
    const paramMonth = parseInt(searchParams.get('month') ?? '');
    const prefix = (paramYear && paramMonth)
      ? `${paramYear}-${String(paramMonth).padStart(2, '0')}`
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const match = plans.find(p => p.period_start.startsWith(prefix));
    setSelectedPlan(match ?? plans[0]);
  }, [plans]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-way sync: whenever selectedPlan changes, keep left selectors in sync.
  useEffect(() => {
    if (!selectedPlan) return;
    const { year, month } = parsePeriodYM(selectedPlan.period_start);
    setSelYear(year);
    setSelMonth(month);
  }, [selectedPlan?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When filters change, auto-select the matching plan
  useEffect(() => {
    if (!plans.length) return;
    const match = plans.find(p =>
      (!nameFilter || p.name === nameFilter) &&
      (!monthFilter || p.period_start.startsWith(monthFilter))
    );
    if (match) setSelectedPlan(match);
  }, [nameFilter, monthFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // When nameFilter changes, reset monthFilter if it's no longer valid
  useEffect(() => {
    if (!monthFilter) return;
    const still = availableMonths.some(([key]) => key === monthFilter);
    if (!still) setMonthFilter('');
  }, [nameFilter]); // eslint-disable-line react-hooks/exhaustive-deps


  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', background: 'var(--bg2)' }}>
      <Topbar
        title="Savdo Boshqaruvi"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Filter 1: Reja nomi */}
            <select
              value={nameFilter}
              onChange={e => setNameFilter(e.target.value)}
              style={{ height: 36, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: nameFilter ? 'var(--text)' : 'var(--text3)', fontSize: 13, fontWeight: nameFilter ? 600 : 400, outline: 'none', cursor: 'pointer' }}
            >
              <option value="">Barcha rejalar</option>
              {uniqueNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>

            {/* Filter 2: Oy */}
            <select
              value={monthFilter}
              onChange={e => setMonthFilter(e.target.value)}
              style={{ height: 36, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: monthFilter ? 'var(--text)' : 'var(--text3)', fontSize: 13, fontWeight: monthFilter ? 600 : 400, outline: 'none', cursor: 'pointer' }}
            >
              <option value="">Barcha oylar</option>
              {availableMonths.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>

            <button
              onClick={() => createMutation.mutate({ year: now.getFullYear(), month: now.getMonth() + 1 })}
              disabled={createMutation.isPending}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: 0, background: '#1d4ed8', color: '#fff', fontSize: 13, fontWeight: 600, cursor: createMutation.isPending ? 'default' : 'pointer', opacity: createMutation.isPending ? 0.7 : 1 }}
            >
              <Plus size={14} /> {createMutation.isPending ? 'Yaratilmoqda…' : 'Yangi reja'}
            </button>
          </div>
        }
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
{!selectedPlan ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '50%', gap: 16, color: 'var(--text3)' }}>
            <BarChart3 size={48} strokeWidth={1} />
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text2)' }}>{MONTH_NAMES[selMonth - 1]} {selYear} uchun reja mavjud emas</div>
            <button
              onClick={() => createMutation.mutate({ year: selYear, month: selMonth })}
              disabled={createMutation.isPending}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 22px', borderRadius: 9, border: 0, background: '#1d4ed8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: createMutation.isPending ? 'default' : 'pointer', opacity: createMutation.isPending ? 0.7 : 1 }}
            >
              <Plus size={15} /> {createMutation.isPending ? 'Yaratilmoqda…' : 'Reja yaratish'}
            </button>
          </div>
        ) : (
          <>
            <DistributionView key={selectedPlan.id} planId={selectedPlan.id} onDeleted={() => { didAutoSelect.current = false; setSelectedPlan(null); setNewPlanId(null); }} />
            <ProgressView planId={selectedPlan.id} />
          </>
        )}
      </div>
    </div>
  );
}
