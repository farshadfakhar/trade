import { useEffect, useMemo, useState } from 'react';
import { Btn, Card, Meter } from '../components/ui';
import { HelpCard, StatusBanner, Watchlist, type Watch } from '../components/Beginner';
import { LineChart, PriceChart, type Overlay } from '../components/Charts';
import WhatNext, { type View } from '../components/WhatNext';
import { api, ema, f2, pnlColor, useLive, type Candle, type TradeRow } from '../api';

/** Indicator lines that belong to the active strategy, so the chart shows what the bot actually looks at. */
function overlaysFor(v: View | undefined, candles: Candle[]): Overlay[] {
  const p = (v as any)?.params as Record<string, number> | undefined;
  if (!v || !p || !candles.length) return [];
  const t = (i: number) => candles[i]!.time;
  const line = (name: string, color: string, vals: (number | undefined)[]): Overlay => ({ name, color, data: vals.flatMap((x, i) => (x === undefined || !Number.isFinite(x) ? [] : [{ time: t(i), value: x }])) });
  const close = candles.map((c) => c.close);
  if (v.strategy === 'donchian') {
    // highest high / lowest low of the PREVIOUS N candles: the levels the bot waits for price to cross
    const roll = (n: number, f: (a: number[]) => number, key: 'high' | 'low') => candles.map((_, i) => (i < n ? undefined : f(candles.slice(i - n, i).map((c) => c[key]))));
    return [line('Buy level', '#60a5fa', roll(p.entryLen!, (a) => Math.max(...a), 'high')), line('Sell level', '#f59e0b', roll(p.exitLen!, (a) => Math.min(...a), 'low')),
      ...(p.trend ? [line('Long-term average', '#a78bfa', ema(close, p.trend).map((x, i) => (i < p.trend! ? undefined : x)))] : [])];
  }
  if (v.strategy === 'emaRsi') return ([['fast', '#60a5fa'], ['slow', '#f59e0b'], ['trend', '#a78bfa']] as const).map(([k, c]) => line(`EMA${p[k]}`, c, ema(close, p[k]!).map((x, i) => (i < p[k]! ? undefined : x))));
  if (v.strategy === 'pullback15m') return [line(`EMA${p.triggerEma}`, '#60a5fa', ema(close, p.triggerEma!)), line(`EMA${p.pullbackEma}`, '#f59e0b', ema(close, p.pullbackEma!))];
  return [];
}

export default function Overview() {
  const { status: s, tick } = useLive();
  const [view, setView] = useState<View>();
  const [viewErr, setViewErr] = useState('');
  const [watch, setWatch] = useState<Watch>();
  const [candles, setCandles] = useState<Candle[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [equity, setEquity] = useState<{ at: string; equity: number }[]>([]);
  const [err, setErr] = useState('');
  const symbol = s?.symbol;
  const res = (view as any)?.resolution as string | undefined;

  useEffect(() => {
    const load = () => { api<View>('/strategy').then((x) => { setView(x); setViewErr(''); }).catch((e) => setViewErr(e.message)); api<Watch>('/watchlist').then(setWatch).catch(() => {}); };
    load(); const t = setInterval(load, 30_000); return () => clearInterval(t);
  }, [tick, symbol]);
  useEffect(() => {
    if (!symbol || !res) return;
    const load = () => api<Candle[]>(`/candles?symbol=${encodeURIComponent(symbol)}&resolution=${res}`).then(setCandles).catch((e) => setErr(e.message));
    setCandles([]); load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, [symbol, res]);
  useEffect(() => { api<TradeRow[]>('/trades?limit=500').then(setTrades).catch(() => {}); api('/equity?limit=2000').then(setEquity).catch(() => {}); }, [tick]);

  const overlays = useMemo(() => overlaysFor(view, candles), [view, candles]);
  const k = useMemo(() => {
    const wins = trades.filter((t) => t.pnl > 0).length;
    let peak = 0, dd = 0;
    for (const p of equity) { peak = Math.max(peak, p.equity); dd = Math.max(dd, peak ? ((peak - p.equity) / peak) * 100 : 0); }
    const lastClose = candles.at(-1)?.close ?? 0;
    const at = (iso: string) => { const t = Date.parse(iso); return [...candles].reverse().find((c) => c.time <= t)?.close ?? candles[0]?.close ?? 0; };
    const cap = s?.limits.capital ?? 0;
    const first = equity[0] ? at(equity[0].at) : 0;
    const hold = candles.length && first ? equity.map((p) => ({ time: Date.parse(p.at), value: cap * at(p.at) / first })) : [];
    return { wins, n: trades.length, dd, holdPct: first ? (lastClose / first - 1) * 100 : 0, hold };
  }, [trades, equity, candles, s?.limits.capital]);

  if (!s) return <div className="text-zinc-500">Connecting…</div>;
  const coin = s.symbol.replace('/USDT', '');
  const total = s.equity - s.limits.capital;
  const totalPct = (total / s.limits.capital) * 100;
  const ddNow = s.risk.peak ? Math.max(0, ((s.risk.peak - s.equity) / s.risk.peak) * 100) : 0;
  const unreal = s.position && candles.length ? s.position.qty * candles.at(-1)!.close - s.position.cost : 0;
  const act = (p: Promise<unknown>) => p.then(() => setErr('')).catch((e) => setErr(e.message));
  const card = (label: string, value: React.ReactNode, hint: string, cls = '') => (
    <Card><div className="text-xs text-zinc-500">{label}</div><div className={`num mt-1 text-2xl font-semibold ${cls}`}>{value}</div><div className="mt-1 text-xs text-zinc-500">{hint}</div></Card>
  );

  return (
    <div className="space-y-4">
      {err && <div className="rounded-lg bg-red-950 p-2 text-sm text-red-300">{err}</div>}
      {watch && <StatusBanner b={watch.banner} mode={watch.mode} />}
      {watch?.advice.map((a) => <div key={a} className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200"><b>Worth changing:</b> {a}</div>)}
      {s.risk.killed && <div className="flex items-center justify-between rounded-lg bg-red-950 p-3 text-red-300">The safety stop is ACTIVE. Nothing trades until you reset it.<Btn tone="red" onClick={() => window.confirm('Reset the safety stop?') && act(api('/risk/reset-kill', { body: {} }))}>Reset</Btn></div>}
      {s.problems?.length > 0 && <div className="rounded-lg bg-red-950 p-3 text-sm text-red-300"><b>Needs your attention before trading can start:</b><ul className="my-1 list-disc pl-5">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>Check your Nobitex account (open orders, balances), then acknowledge. <Btn tone="red" className="ml-2" onClick={() => window.confirm('Have you checked the exchange and accept its current state?') && act(api('/problems/ack', { body: {} }))}>Acknowledge</Btn></div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {card("Bot's money (USDT)", f2(s.equity), `Started with ${f2(s.limits.capital)}. The bot can never use more than this.`)}
        {card("Today's profit / loss", f2(s.risk.dailyPnl), 'Since midnight UTC', pnlColor(s.risk.dailyPnl))}
        {card('Total profit / loss', <span className={pnlColor(total)}>{f2(total)}</span>, `${f2(totalPct)}%. Just holding ${coin} would be ${f2(k.holdPct)}%`)}
        {card('Winning trades', k.n ? `${f2((k.wins / k.n) * 100)}%` : '–', k.n ? `${k.wins} of ${k.n} trades made money` : 'No trades yet')}
        {card('Biggest drop so far', `${f2(k.dd)}%`, `The bot stops itself at ${s.limits.maxDrawdownPct}%`)}
      </div>

      {watch && <Watchlist w={watch} />}
      <WhatNext v={view} err={viewErr} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={`${s.symbol} price (${view?.timeframe ?? ''} candles)${overlays.length ? ': ' + overlays.map((o) => o.name).join(' · ') : ''}`} className="lg:col-span-2"><PriceChart candles={candles} trades={trades} position={s.position} overlays={overlays} /></Card>
        <div className="space-y-4">
          <Card title="Safety limits (how close to stopping?)">
            <Meter label="Lost today" value={Math.max(0, -s.risk.dailyPnl) / s.limits.capital * 100} max={s.limits.dailyLossPct} text={`${f2(Math.max(0, -s.risk.dailyPnl) / s.limits.capital * 100)}% of ${s.limits.dailyLossPct}% allowed`} />
            <Meter label="Down from best point" value={ddNow} max={s.limits.maxDrawdownPct} text={`${f2(ddNow)}% of ${s.limits.maxDrawdownPct}% allowed`} />
            <Meter label="Trades today" value={s.risk.tradesToday} max={s.limits.maxTrades} text={`${s.risk.tradesToday} of ${s.limits.maxTrades} allowed`} />
            <div className="text-xs text-zinc-500">Failed exchange requests in a row: {s.risk.errors}</div>
          </Card>
          <Card title="Current trade">
            {s.position ? (
              <div className="num space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-zinc-500">Bought at</span>{f2(s.position.entry)}</div>
                <div className="flex justify-between"><span className="text-zinc-500">Amount</span>{s.position.qty} {coin}</div>
                <div className="flex justify-between"><span className="text-zinc-500">Sells automatically if it falls to</span><span className="text-red-400">{f2(s.position.stop)}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">{s.position.partial ? (s.position.partialDone ? 'First target (done)' : `Sells ${s.position.partial.fraction * 100}% if it rises to`) : 'Target price'}</span><span className="text-emerald-400">{f2(s.position.target)}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Profit / loss right now</span><span className={pnlColor(unreal)}>{f2(unreal)}</span></div>
                <Btn className="mt-2 w-full" onClick={() => window.confirm('Sell this position at the current price now?') && act(api('/position/close', { body: {} }))}>Sell now</Btn>
              </div>
            ) : <div className="text-sm text-zinc-500">No trade open. The bot is holding only cash.</div>}
          </Card>
        </div>
      </div>

      <Card title="Bot's money over time vs. just holding the coin">
        {equity.length > 1
          ? <LineChart series={[{ name: 'Bot', color: '#10b981', data: equity.map((p) => ({ time: Date.parse(p.at), value: p.equity })) }, { name: 'Just holding', color: '#71717a', data: k.hold }]} />
          : <div className="text-sm text-zinc-500">The line appears after the bot has been running for a while.</div>}
      </Card>

      <HelpCard strategy={view?.strategy ?? 'unknown'} timeframe={view?.timeframe ?? ''} />
    </div>
  );
}
