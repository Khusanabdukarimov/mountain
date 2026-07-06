import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/Topbar';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { getConfig } from '@/lib/api/config';
import {
  getCampaignAssignments,
  assignCampaign,
  unassignCampaign,
  type CampaignAssignment,
} from '@/lib/api/meta';
import { X, Plus, AlertCircle } from 'lucide-react';

const TARGETOLOG_LABELS: Record<string, { label: string; color: string }> = {
  dilmurod:   { label: 'Dilmurod',   color: '#2196F3' },
  'u-mark':   { label: 'U-Mark',     color: '#9C27B0' },
};

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
  const [filter, setFilter] = useState<'all' | 'unassigned' | 'dilmurod' | 'u-mark'>('unassigned');

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
      {/* Filter tabs */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {([
          { key: 'unassigned', label: `Biriktirilmagan (${unassignedCount})` },
          { key: 'dilmurod',   label: 'Dilmurod' },
          { key: 'u-mark', label: 'U-Mark' },
          { key: 'all',        label: 'Hammasi' },
        ] as { key: typeof filter; label: string }[]).map(t => (
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
  c, onAssign, onUnassign, busy,
}: {
  c: CampaignAssignment;
  onAssign: (targ: string) => void;
  onUnassign: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tInfo = c.targetolog ? TARGETOLOG_LABELS[c.targetolog] : null;

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
            {Object.entries(TARGETOLOG_LABELS).map(([key, info]) => (
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

