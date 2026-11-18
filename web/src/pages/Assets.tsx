import { useEffect, useState } from 'react';
import { Btn, Card } from '../components/ui';
import { api, f2 } from '../api';

interface Row { currency: string; total: number; locked: number; available: number; valueUsdt: number | null }
interface Data { configured: boolean; mode?: string; botCoin?: string; botCapital?: number; rows?: Row[]; totalUsdt?: number; at?: number }

const amt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 8 });

export default function Assets() {
  const [d, setD] = useState<Data>();
  const [err, setErr] = useState('');
  const load = () => api<Data>('/assets').then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);

  if (err) return <Card title="Your Nobitex assets"><div className="text-sm text-red-400">{err}</div><Btn className="mt-2" onClick={load}>Retry</Btn></Card>;
  if (!d) return <div className="text-zinc-500">Loading…</div>;
  if (!d.configured) return <Card title="Your Nobitex assets"><p className="text-sm text-zinc-400">No API key is configured. Add <code>EXCHANGE_API_KEY</code> and <code>EXCHANGE_API_SECRET</code> to <code>.env</code> (a key with <b>READ</b> permission is enough for this page) and restart the server.</p></Card>;
  const rows = [...(d.rows ?? [])].sort((a, b) => (b.valueUsdt ?? -1) - (a.valueUsdt ?? -1));

  return (
    <div className="space-y-4">
      <Card title="Your Nobitex assets (spot wallets)">
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-zinc-400">Approx. total <b className="num text-lg text-zinc-100">{f2(d.totalUsdt)} USDT</b> <span className="text-xs text-zinc-500">(coins without a USDT market, and rial, are not counted)</span></span>
          <span className="flex items-center gap-2 text-xs text-zinc-500">updated {new Date(d.at ?? 0).toLocaleTimeString()}<Btn onClick={load}>Refresh</Btn></span>
        </div>
        <div className="overflow-x-auto"><table className="num w-full text-sm">
          <thead className="text-xs uppercase text-zinc-500"><tr><th className="px-3 py-2 text-left">Asset</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">In open orders</th><th className="px-3 py-2 text-right">Available</th><th className="px-3 py-2 text-right">≈ USDT</th><th className="px-3 py-2 text-left">Bot</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.currency} className="border-t border-zinc-800">
              <td className="px-3 py-2 font-medium uppercase">{r.currency === 'rls' ? 'RIAL' : r.currency}</td>
              <td className="px-3 py-2 text-right">{amt(r.total)}</td><td className="px-3 py-2 text-right">{amt(r.locked)}</td><td className="px-3 py-2 text-right">{amt(r.available)}</td>
              <td className="px-3 py-2 text-right">{r.valueUsdt == null ? '–' : f2(r.valueUsdt)}</td>
              <td className="px-3 py-2 text-xs text-zinc-500">{r.currency === 'usdt' ? `bot may use up to ${d.botCapital} USDT` : r.currency === d.botCoin ? 'bot trades this, but only what it bought itself' : 'not touched'}</td>
            </tr>))}</tbody>
        </table>{!rows.length && <div className="p-4 text-zinc-500">No balances found.</div>}</div>
      </Card>
      <p className="text-xs text-zinc-500">This page is read-only. The bot never sells coins it did not buy itself and can never use more than its fixed capital ({d.botCapital} USDT).</p>
    </div>
  );
}
