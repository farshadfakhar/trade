import { useEffect, useState } from 'react';
import { Btn, Card, inputCls } from '../components/ui';
import { LineChart } from '../components/Charts';
import { api, f2, pnlColor, useLive } from '../api';

interface Report { candles: number; netPnl: number; returnPct: number; buyHoldPct: number; trades: number; winRate: number; profitFactor: number | null; maxDrawdownPct: number; sharpe: number; killed: boolean; equityCurve: { time: number; equity: number }[]; tradeList: { time: number; entry: number; exit: number; qty: number; pnl: number; reason: string }[] }
interface Strategies { current: string; saved: Record<string, number>; list: Record<string, { resolution: string; htfResolution: string | null; defaults: Record<string, number> }> }
const day = (d: Date) => d.toISOString().slice(0, 10);
const TF: Record<string, string> = { '15': '15m', '60': '1h', '240': '4h', D: '1d' };

function Results({ title, r }: { title: string; r: Report }) {
  const row = (l: string, v: string, cls = '') => <div key={l} className="flex justify-between border-b border-zinc-800 py-1.5 text-sm"><span className="text-zinc-500">{l}</span><span className={`num ${cls}`}>{v}</span></div>;
  return (
    <Card title={title}>
      {row('Net P&L (USDT)', f2(r.netPnl), pnlColor(r.netPnl))}{row('Return', `${f2(r.returnPct)}%`, pnlColor(r.returnPct))}{row('Buy & hold', `${f2(r.buyHoldPct)}%`, pnlColor(r.buyHoldPct))}
      {row('Trades', String(r.trades))}{row('Win rate', `${f2(r.winRate)}%`)}{row('Profit factor', r.profitFactor == null ? '–' : f2(r.profitFactor))}
      {row('Max drawdown', `${f2(r.maxDrawdownPct)}%`)}{row('Sharpe (annualised)', f2(r.sharpe))}{row('Kill switch tripped', r.killed ? 'yes' : 'no', r.killed ? 'text-red-400' : '')}
    </Card>
  );
}

export default function Backtest() {
  const { status } = useLive();
  const [pairs, setPairs] = useState<string[]>([]);
  const [st, setSt] = useState<Strategies>();
  const [name, setName] = useState('');
  const [params, setParams] = useState<Record<string, number>>({});
  const [f, setF] = useState({ symbol: '', resolution: '60', from: day(new Date(Date.now() - 365 * 86400_000)), to: day(new Date()) });
  const [both, setBoth] = useState(true);
  const [r, setR] = useState<{ fees: Report; free?: Report }>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pick = (s: Strategies, n: string) => {
    const info = s.list[n]!;
    setName(n); setParams(n === s.current ? s.saved : info.defaults);
    setF((x) => ({ ...x, resolution: info.resolution, from: day(new Date(Date.now() - (info.resolution === '15' ? 6 : 365) * 86400_000)) }));
  };
  useEffect(() => { Promise.all([api('/scan'), api<Strategies>('/strategies')]).then(([sc, t]) => { setPairs([...new Set<string>([...(status ? [status.symbol] : []), ...((sc.last?.results ?? []) as { symbol: string }[]).map((r) => r.symbol)])]); setSt(t); setF((x) => ({ ...x, symbol: status?.symbol ?? 'BTC/USDT' })); pick(t, t.current); }).catch(() => {}); }, []); // eslint-disable-line

  const run = async () => {
    setBusy(true); setErr(''); setR(undefined);
    try {
      const body = { ...f, strategy: name, params };
      const fees = await api<Report>('/backtest', { body });
      const free = both ? await api<Report>('/backtest', { body: { ...body, noFees: true } }) : undefined;
      setR({ fees, free });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const label = (k: string) => k.replace(/([A-Z])/g, ' $1').toLowerCase();

  return (
    <div className="space-y-4">
      <Card title="Backtest (fees and slippage included; same code path as live)">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <label className="text-sm"><span className="text-zinc-400">Strategy</span><select className={inputCls} value={name} onChange={(e) => st && pick(st, e.target.value)}>{Object.keys(st?.list ?? {}).map((k) => <option key={k} value={k}>{k}{k === st?.current ? ' (live)' : ''}</option>)}</select></label>
          <label className="text-sm"><span className="text-zinc-400">Pair</span><input list="pairs" className={inputCls} value={f.symbol} placeholder="BTC/USDT" onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} /><datalist id="pairs">{pairs.map((p) => <option key={p} value={p} />)}</datalist></label>
          <label className="text-sm"><span className="text-zinc-400">Timeframe</span><select className={inputCls} value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })}>{Object.entries(TF).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="text-sm"><span className="text-zinc-400">From</span><input type="date" className={inputCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="text-sm"><span className="text-zinc-400">To</span><input type="date" className={inputCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
          {Object.keys(params).map((k) => <label key={k} className="text-xs"><span className="text-zinc-500">{label(k)}</span><input type="number" step="any" className={`${inputCls} num`} value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} /></label>)}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Btn tone="green" disabled={busy || !f.symbol} onClick={run}>{busy ? 'Running… (first run downloads candles, ~1s per 500)' : 'Run'}</Btn>
          <label className="flex items-center gap-2 text-sm text-zinc-400"><input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />also show the result without fees</label>
          {err && <span className="text-sm text-red-400">{err}</span>}
        </div>
        <p className="mt-2 text-xs text-zinc-500">Max range is 3.5 years. {f.resolution === '15' && <b className="text-amber-400">Nobitex only serves 15m candles for about the last 7 days, so a 15m backtest cannot cover more. </b>}To check for overfitting, tune on one range and then run a range you never tuned on.</p>
      </Card>
      {r && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4">
            <Results title="Results with fees" r={r.fees} />
            {r.free && <Results title="Results without fees (for comparison only)" r={r.free} />}
            <p className="text-xs text-zinc-500">Gate: profitable after fees, max DD &lt; 20%, ≥ 50 trades, beats hold or clearly lower DD, and holds out-of-sample.</p>
          </div>
          <Card title="Equity curve" className="lg:col-span-2"><LineChart series={[{ name: 'With fees', color: '#10b981', data: r.fees.equityCurve.map((p) => ({ time: p.time, value: p.equity })) }, ...(r.free ? [{ name: 'No fees', color: '#71717a', data: r.free.equityCurve.map((p) => ({ time: p.time, value: p.equity })) }] : [])]} /></Card>
          <Card title={`Trades (${r.fees.tradeList.length})`} className="lg:col-span-3"><div className="max-h-80 overflow-auto"><table className="num w-full text-sm"><tbody>
            {r.fees.tradeList.map((t, i) => <tr key={i} className="border-t border-zinc-800"><td className="px-2 py-1">{new Date(t.time).toLocaleString()}</td><td className="px-2">{f2(t.entry)} → {f2(t.exit)}</td><td className="px-2">{t.qty}</td><td className={`px-2 ${pnlColor(t.pnl)}`}>{f2(t.pnl)}</td><td className="px-2 text-zinc-500">{t.reason}</td></tr>)}
          </tbody></table></div></Card>
        </div>
      )}
    </div>
  );
}
