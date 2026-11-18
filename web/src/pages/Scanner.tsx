import { useEffect, useState } from 'react';
import { Btn, Card } from '../components/ui';
import { api, f2, pnlColor, useLive } from '../api';

interface M { returnPct: number; trades: number; pf: number | null; ddPct: number; killed: boolean }
interface Coin { symbol: string; volumeUsdt: number; spreadPct: number; historyDays: number; is?: M; oos?: M; passes: boolean; reasons: string[] }
interface Scan {
  enabled: boolean; running: boolean; error: string | null; selected: string | null; current: string; pending: string | null; intervalHours: number;
  last: null | { at: number; strategy: string; universe: number; scanned: number; results: Coin[]; cfg: { minVolumeUsdt: number; maxSpreadPct: number; minOosTrades: number; minOosPf: number; maxDdPct: number } };
}

const pct = (n?: number) => (n == null ? '–' : `${f2(n)}%`);

export default function Scanner() {
  const { tick } = useLive();
  const [d, setD] = useState<Scan>();
  const [err, setErr] = useState('');
  const load = () => api<Scan>('/scan').then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [tick]);
  if (!d) return <div className="text-zinc-500">{err || 'Loading…'}</div>;

  const next = d.last ? new Date(d.last.at + d.intervalHours * 3600_000) : null;
  return (
    <div className="space-y-4">
      <Card title="Coin scanner">
        {!d.enabled ? (
          <p className="text-sm text-zinc-400">The scanner is <b>off</b>. To let the bot choose the coin itself, set <code>AUTO_SCAN=true</code> and <code>STRATEGY=donchian</code> in <code>.env</code> and restart. It works in paper mode first; going LIVE still needs your typed confirmation.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-base text-zinc-100">
              {d.running ? 'Scanning the market now… (a full scan takes a few minutes)' : d.selected ? <>Trading <b>{d.selected}</b>{d.current !== d.selected && <span className="text-amber-400"> (switching from {d.current} once it has no open position)</span>}.</> : d.last ? <>No coin passes the gates right now, so the bot <b>stays in cash</b>. That is a valid result.</> : 'Waiting for the first scan. No trades happen until a coin passes.'}
            </p>
            <p className="text-zinc-500">Strategy: <b className="text-zinc-300">{d.last?.strategy ?? '–'}</b> · last scan {d.last ? new Date(d.last.at).toLocaleString() : 'never'} · next {next ? next.toLocaleString() : 'soon'} · rescans every {d.intervalHours} h</p>
            {(d.error || err) && <p className="text-red-400">{d.error || err}</p>}
            <Btn tone="green" disabled={d.running} onClick={() => api('/scan/run', { body: {} }).then(load).catch((e) => setErr(e.message))}>Rescan now</Btn>
          </div>
        )}
      </Card>

      {d.last && (
        <Card title={`Scan results: ${d.last.scanned} liquid USDT coins checked`}>
          <p className="mb-3 text-xs text-zinc-500">
            The strategy runs unchanged on each coin over an earlier and a later period (fees plus half the spread per side included). A coin passes only if it is profitable in <b>both</b> periods, with at least {d.last.cfg.minOosTrades} trades and profit factor ≥ {d.last.cfg.minOosPf} in the later one, and drawdown ≤ {d.last.cfg.maxDdPct}%. Only coins with ≥ {f2(d.last.cfg.minVolumeUsdt)} USDT daily volume and spread ≤ {d.last.cfg.maxSpreadPct}% are considered. <b>Passing is a minimum bar, not a forecast of profit.</b>
          </p>
          <div className="overflow-x-auto"><table className="num w-full text-sm">
            <thead className="text-xs uppercase text-zinc-500"><tr><th className="px-2 py-2 text-left">Coin</th><th className="px-2 text-right">24h vol (USDT)</th><th className="px-2 text-right">Spread</th><th className="px-2 text-right">Earlier</th><th className="px-2 text-right">Later</th><th className="px-2 text-right">Trades</th><th className="px-2 text-right">PF</th><th className="px-2 text-right">Max DD</th><th className="px-2 text-left">Verdict</th></tr></thead>
            <tbody>{d.last.results.map((c) => (
              <tr key={c.symbol} className="border-t border-zinc-800 align-top">
                <td className="px-2 py-2 font-medium">{c.symbol}{c.symbol === d.selected && <span className="ml-1 rounded bg-emerald-600 px-1 text-xs text-white">selected</span>}</td>
                <td className="px-2 text-right">{f2(c.volumeUsdt)}</td><td className="px-2 text-right">{f2(c.spreadPct)}%</td>
                <td className={`px-2 text-right ${pnlColor(c.is?.returnPct ?? 0)}`}>{pct(c.is?.returnPct)}</td>
                <td className={`px-2 text-right ${pnlColor(c.oos?.returnPct ?? 0)}`}>{pct(c.oos?.returnPct)}</td>
                <td className="px-2 text-right">{c.oos?.trades ?? '–'}</td><td className="px-2 text-right">{c.oos?.pf == null ? '–' : f2(c.oos.pf)}</td><td className="px-2 text-right">{pct(c.oos?.ddPct)}</td>
                <td className={`px-2 text-xs ${c.passes ? 'text-emerald-400' : 'text-zinc-500'}`}>{c.passes ? '✓ passes every gate' : c.reasons.join('; ')}</td>
              </tr>))}</tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}
