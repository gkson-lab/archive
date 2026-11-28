import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { eraInfo } from '../shared/era';
import type { CardFull } from '../shared/types';

export function EraBadge({ era, series }: { era: string; series?: string }) {
  const e = eraInfo(era, series);
  return (
    <span class="era-badge" style={{ background: e.color }} title={e.label}>
      {e.label}
    </span>
  );
}

export function CardImg({ card, class: cls, large }: { card?: Pick<CardFull, 'img' | 'imgLarge' | 'name'>; class?: string; large?: boolean }) {
  const src = large ? card?.imgLarge || card?.img : card?.img;
  if (!src) return <div class={`ph ${cls ?? ''}`} aria-label={card?.name} />;
  return <img class={cls} src={src} alt={card?.name ?? ''} loading="lazy" decoding="async" draggable={false} />;
}

export function Sheet({ onClose, children, label }: { onClose: () => void; children: ComponentChildren; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  let startY = 0;
  let el: HTMLDivElement | null = null;
  return (
    <>
      <div class="sheet-backdrop" onClick={onClose} />
      <div
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={(r) => {
          el = r;
        }}
        onTouchStart={(e) => {
          if ((el?.scrollTop ?? 0) > 0) return;
          startY = e.touches[0].clientY;
        }}
        onTouchMove={(e) => {
          if (!startY || !el) return;
          const dy = e.touches[0].clientY - startY;
          if (dy > 0 && el.scrollTop <= 0) el.style.transform = `translateY(${dy}px)`;
        }}
        onTouchEnd={(e) => {
          if (!el || !startY) return;
          const dy = e.changedTouches[0].clientY - startY;
          startY = 0;
          if (dy > 110) onClose();
          else el.style.transform = '';
        }}
      >
        <div class="grab" />
        {children}
      </div>
    </>
  );
}

export function Sparkline({ points, color = 'var(--accent)' }: { points: { date: string; v: number }[]; color?: string }) {
  if (points.length < 2) return null;
  const W = 300;
  const H = 54;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (W - 8) + 4, H - 6 - ((p.v - min) / span) * (H - 14)] as const);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${d} L${xy[xy.length - 1][0]},${H} L${xy[0][0]},${H} Z`;
  const up = vs[vs.length - 1] >= vs[0];
  const stroke = color === 'auto' ? (up ? 'var(--good)' : 'var(--bad)') : color;
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Price trend from ${min.toFixed(2)} to ${max.toFixed(2)}`}>
      <path d={area} fill={stroke} opacity="0.12" />
      <path d={d} fill="none" stroke={stroke} stroke-width="2" vector-effect="non-scaling-stroke" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3" fill={stroke} />
    </svg>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} aria-label={label} />
      <span />
    </label>
  );
}

export function fmtDate(iso?: string) {
  if (!iso) return 'unknown';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
