import { useEffect, useState } from 'react';
import { Card } from '../components/ui';
import { api, f2, pnlColor, useLive, type TradeRow } from '../api';

type Key = 'at' | 'pnl' | 'entry' | 'exit' | 'qty';

export default function Trades() {
  const { tick } = useLive();
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [sort, setSort] = useState<{ k: Key; dir: 1 | -1 }>({ k: 'at', dir: -1 });
  useEffect(() => { api<TradeRow[]>('/trades?limit=1000').then(setRows).catch(() => {}); }, [tick]);
  const sorted = [...rows].sort((a, b) => (sort.k === 'at' ? Date.parse(a.at) - Date.parse(b.at) : a[sort.k] - b[sort.k]) * sort.dir);
  const th = (k: Key, label: string) => <th className="cursor-pointer px-3 py-2 text-left font-medium" onClick={() => setSort({ k, dir: sort.k === k ? (-sort.dir as 1 | -1) : -1 })}>{label}{sort.k === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</th>;
  return (
    <Card title="Trade history">
      <div className="mb-3 flex items-center justify-between text-sm"><span className="text-zinc-500">{rows.length} trades · fees are already included in P&L</span><a className="rounded-lg bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700" href="/api/trades.csv">Export CSV</a></div>
      <div className="overflow-x-auto"><table className="num w-full text-sm">
        <thead className="text-xs uppercase text-zinc-500"><tr>{th('at', 'Time')}<th className="px-3 py-2 text-left">Pair</th><th className="px-3 py-2 text-left">Side</th>{th('entry', 'Entry')}{th('exit', 'Exit')}{th('qty', 'Size')}{th('pnl', 'P&L')}<th className="px-3 py-2 text-left">Reason</th></tr></thead>
        <tbody>{sorted.map((t) => (
          <tr key={t.id} className="border-t border-zinc-800">
            <td className="px-3 py-2">{new Date(t.at).toLocaleString()}</td><td className="px-3 py-2">{t.symbol}</td><td className="px-3 py-2">long</td>
            <td className="px-3 py-2">{f2(t.entry)}</td><td className="px-3 py-2">{f2(t.exit)}</td><td className="px-3 py-2">{t.qty}</td>
            <td className={`px-3 py-2 ${pnlColor(t.pnl)}`}>{f2(t.pnl)}</td><td className="px-3 py-2">{t.reason}</td>
          </tr>))}</tbody>
      </table>{!rows.length && <div className="p-4 text-zinc-500">No trades yet.</div>}</div>
    </Card>
  );
}
