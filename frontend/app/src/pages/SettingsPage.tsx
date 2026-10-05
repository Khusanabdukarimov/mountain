import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/Topbar';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { getConfig } from '@/lib/api/config';
import {
  getCampaignAssignments,
  assignCampaign,
  unassignCampaign,
  getTargetologs,
  createTargetolog,
  type CampaignAssignment,
} from '@/lib/api/meta';
import { X, Plus, AlertCircle } from 'lucide-react';

const TARGETOLOG_COLORS = ['#2196F3', '#9C27B0', '#00A884', '#FF9800', '#E91E63', '#607D8B'];

export default function SettingsPage() {
  const cfgQ = useQuery({ queryKey: ['app/config'], queryFn: getConfig, staleTime: Infinity });

  return (
    <>
      <Topbar
        title="Sozlamalar"
        sub="Tizim parametrlari · Bitrix integratsiyasi"
      />
      <div className="flex-1 overflow-y-auto px-3 sm:px-[22px] py-3 sm:py-[18px] bg-bg space-y-4">
        {/* ── Tizim ma'lumoti ─────────────────────────────────── */}
        <Section title="Tizim ma'lumoti" subtitle="Server tomondan keladi (read-only)">
          {cfgQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-48" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Item label="Bitrix24 portal" value={cfgQ.data?.bitrix_portal || '— sozlanmagan —'} mono />
              <Item label="Asosiy valyuta" value={cfgQ.data?.currency.primary || '—'} />
              <Item label="Ikkilamchi valyuta" value={cfgQ.data?.currency.secondary || '—'} />
            </div>
          )}
        </Section>

        {/* ── Kampaniyalar targetolog sozlamalari ─────────────── */}
        <CampaignAssignmentsSection />

      </div>
    </>
  );
}

function CampaignAssignmentsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState('unassigned');
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');

  const targetologsQ = useQuery({
    queryKey: ['targetologs'],
    queryFn: getTargetologs,
    staleTime: 60_000,
  });
  const targetologs = useMemo(() => targetologsQ.data ?? [], [targetologsQ.data]);
  const targetologLabels = useMemo(() => Object.fromEntries(
    targetologs.map((t, i) => [t.key, { label: t.label, color: TARGETOLOG_COLORS[i % TARGETOLOG_COLORS.length] }])
  ), [targetologs]);

  const addMut = useMutation({
    mutationFn: () => createTargetolog(newKey, newLabel),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['targetologs'] });
      setAdding(false); setNewKey(''); setNewLabel('');
      toast.success('Saqlandi', 'Yangi targetolog qo\'shildi');
    },
    onError: (e: Error) => toast.error('Xato', e.message),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['campaign-assignments'],
    queryFn: getCampaignAssignments,
    staleTime: 60_000,
  });

  const assignMut = useMutation({
    mutationFn: ({ name, targ }: { name: string; targ: string }) => assignCampaign(name, targ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaign-assignments'] });
      toast.success('Saqlandi', 'Kampaniya targetologga biriktirildi');
    },
    onError: (e: Error) => toast.error('Xato', e.message),
  });

  const unassignMut = useMutation({
    mutationFn: (name: string) => unassignCampaign(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaign-assignments'] });
      toast.success('Olib tashlandi', 'Override o\'chirildi');
    },
    onError: (e: Error) => toast.error('Xato', e.message),
  });

  const campaigns = data ?? [];
  const unassignedCount = campaigns.filter(c => !c.targetolog).length;

  const filtered = campaigns.filter(c => {
    if (filter === 'unassigned') return !c.targetolog;
    if (filter === 'all') return true;
    return c.targetolog === filter;
  });

  return (
    <Section
      title="Kampaniyalar sozlamasi"
      subtitle="Targetologga biriktirilmagan yoki noto'g'ri biriktirilgan kampaniyalarni boshqaring"
    >
      <div className="flex justify-end mb-3">
        <button
          onClick={() => setAdding(v => !v)}
          className="flex items-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-[11px] text-primary hover:bg-primary/10"
        >
          <Plus size={13} /> Yangi targetolog
        </button>
      </div>
      {adding && (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-bg3 p-3">
          <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[10px] text-text3">
            Ism
            <input value={newLabel} onChange={e => { setNewLabel(e.target.value); if (!newKey) setNewKey(e.target.value.toLowerCase().trim().replace(/\s+/g, '-')); }} placeholder="Masalan, Mountain Great" className="rounded border border-border bg-bg2 px-2 py-1.5 text-[12px] text-text outline-none" />
          </label>
          <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[10px] text-text3">
            Kalit
            <input value={newKey} onChange={e => setNewKey(e.target.value.toLowerCase())} placeholder="mountain-great" className="rounded border border-border bg-bg2 px-2 py-1.5 text-[12px] text-text outline-none" />
          </label>
          <button disabled={!newLabel.trim() || !newKey.trim() || addMut.isPending} onClick={() => addMut.mutate()} className="rounded bg-primary px-3 py-1.5 text-[11px] text-white disabled:opacity-50">Qo'shish</button>
        </div>
      )}
      {/* Filter tabs */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {([
          { key: 'unassigned', label: `Biriktirilmagan (${unassignedCount})` },
          ...targetologs.map(t => ({ key: t.key, label: t.label })),
          { key: 'all',        label: 'Hammasi' },
        ]).map(t => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 6,
              border: '1px solid',
              borderColor: filter === t.key ? 'var(--primary)' : 'var(--border)',
              background: filter === t.key ? 'var(--primary)' : 'transparent',
              color: filter === t.key ? '#fff' : 'var(--text2)',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-[12px] text-text3 text-center py-6">
          {filter === 'unassigned' ? 'Barcha kampaniyalar biriktirilgan ✓' : 'Kampaniyalar topilmadi'}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(c => (
            <CampaignRow
              key={c.campaign_name}
              c={c}
              targetologLabels={targetologLabels}
              onAssign={(targ) => assignMut.mutate({ name: c.campaign_name, targ })}
              onUnassign={() => unassignMut.mutate(c.campaign_name)}
              busy={assignMut.isPending || unassignMut.isPending}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function CampaignRow({
  c, targetologLabels, onAssign, onUnassign, busy,
}: {
  c: CampaignAssignment;
  targetologLabels: Record<string, { label: string; color: string }>;
  onAssign: (targ: string) => void;
  onUnassign: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tInfo = c.targetolog ? targetologLabels[c.targetolog] ?? { label: c.targetolog, color: '#607D8B' } : null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'var(--bg3)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '6px 10px',
    }}>
      {/* Unassigned warning */}
      {!c.targetolog && (
        <AlertCircle size={13} style={{ color: '#FF9800', flexShrink: 0 }} />
      )}

      {/* Campaign info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.campaign_name}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>
          {c.total_leads} lid · ${c.total_spend.toFixed(0)} · {c.last_date}
          {c.is_override && <span style={{ marginLeft: 4, color: '#FF9800' }}>★ manual</span>}
        </div>
      </div>

      {/* Current targetolog badge */}
      {tInfo && (
        <span style={{
          fontSize: 10, padding: '1px 7px', borderRadius: 4,
          background: tInfo.color + '22', color: tInfo.color,
          border: `1px solid ${tInfo.color}44`,
          whiteSpace: 'nowrap',
        }}>
          {tInfo.label}
        </span>
      )}

      {/* Assign dropdown */}
      <div style={{ position: 'relative' }}>
        <button
          disabled={busy}
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 3,
            fontSize: 10, padding: '3px 7px', borderRadius: 5,
            border: '1px solid var(--border)',
            background: 'var(--bg2)', color: 'var(--text2)',
            cursor: 'pointer',
          }}
        >
          <Plus size={10} />
          {c.targetolog ? 'O\'zgartirish' : 'Biriktirish'}
        </button>
        {open && (
          <div style={{
            position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50,
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            minWidth: 130, overflow: 'hidden',
          }}>
            {Object.entries(targetologLabels).map(([key, info]) => (
              <button
                key={key}
                onClick={() => { onAssign(key); setOpen(false); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '7px 12px', fontSize: 11,
                  background: 'transparent', border: 0,
                  color: info.color, cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = info.color + '22')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {info.label}
              </button>
            ))}
            <button
              onClick={() => { onAssign(''); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '7px 12px', fontSize: 11,
                background: 'transparent', border: 0, borderTop: '1px solid var(--border)',
                color: '#9E9E9E', cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(158,158,158,0.1)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              Biriktirilmagan (chiqar)
            </button>
          </div>
        )}
      </div>

      {/* Remove override button (only if manually assigned) */}
      {c.is_override && (
        <button
          disabled={busy}
          onClick={onUnassign}
          title="Override ni o'chirish (pattern ga qaytadi)"
          style={{
            background: 'transparent', border: 0, cursor: 'pointer',
            color: '#f44336', display: 'flex', padding: 3,
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg2 border border-border rounded-lg shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <div className="text-[13px] font-semibold">{title}</div>
        {subtitle && <div className="text-[11px] text-text3 mt-0.5">{subtitle}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Item({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-text3 uppercase tracking-wider font-medium">{label}</div>
      <div className={`text-[12.5px] mt-1 ${mono ? 'mono text-text2' : 'font-medium'}`}>{value}</div>
    </div>
  );
}
