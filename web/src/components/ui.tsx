import type { ReactNode } from 'react';

export const Card = ({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) => (
  <div className={`rounded-xl border border-zinc-800 bg-zinc-900 p-4 ${className}`}>
    {title && <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>}
    {children}
  </div>
);

export const Kpi = ({ label, value, cls = '' }: { label: string; value: ReactNode; cls?: string }) => (
  <Card><div className="text-xs text-zinc-500">{label}</div><div className={`num mt-1 text-2xl font-semibold ${cls}`}>{value}</div></Card>
);

export const Btn = ({ tone = 'default', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'green' | 'red' }) => (
  <button {...p} className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${{ default: 'bg-zinc-800 hover:bg-zinc-700', green: 'bg-emerald-600 hover:bg-emerald-500 text-white', red: 'bg-red-600 hover:bg-red-500 text-white' }[tone]} ${p.className ?? ''}`} />
);

export const Meter = ({ label, value, max, text }: { label: string; value: number; max: number; text: string }) => {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0);
  return (
    <div className="mb-3">
      <div className="mb-1 flex justify-between text-xs"><span className="text-zinc-400">{label}</span><span className="num">{text}</span></div>
      <div className="h-2 rounded bg-zinc-800"><div className={`h-2 rounded ${pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
};

export const inputCls = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm';
