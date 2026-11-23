import { f2 } from '../api';
import { Card } from './ui';

interface Cond { label: string; ok: boolean; detail: string }
export interface View {
  ready: boolean; summary: string; running?: boolean; mode?: 'flat' | 'in_position'; price?: number; symbol?: string;
  entry?: Cond[]; exit?: Cond[]; gates?: Cond[]; plan?: { entry: number; stop: number; target: number } | null;
  facts?: string[]; strategy?: string; timeframe?: string;
  lastCandleClose?: number | null; nextCandleClose?: number | null;
}

const Row = ({ c, neutral }: { c: Cond; neutral?: boolean }) => (
  <li className="flex gap-2 py-1.5 text-sm">
    <span className={`mt-0.5 w-5 shrink-0 text-center font-bold ${neutral ? 'text-zinc-500' : c.ok ? 'text-emerald-400' : 'text-red-400'}`}>{neutral ? '•' : c.ok ? '✓' : '✗'}</span>
    <span><span className="text-zinc-200">{c.label}</span><br /><span className="num text-xs text-zinc-500">{c.detail}</span></span>
  </li>
);
const time = (ms?: number | null) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');

/** Plain-language answer to "what is the bot waiting for?" */
export default function WhatNext({ v, err }: { v?: View; err?: string }) {
  if (err) return <Card title="When will it open a long?"><div className="text-sm text-red-400">{err}</div></Card>;
  if (!v) return <Card title="When will it open a long?"><div className="text-sm text-zinc-500">Loading…</div></Card>;
  const holding = v.mode === 'in_position';
  const gate = v.gates?.find((check) => !check.ok);
  const entry = v.entry?.find((check) => !check.ok);

  return (
    <Card title={`When will it open a long? · ${v.symbol ?? 'Active market'}`}>
      <p className="mb-1 text-sm text-zinc-400">A long buys first and can profit if it sells later at a higher price. See Paper Shorts for the sell-first simulation.</p>
      <p className="mb-2 text-base font-semibold">{holding ? 'Long position open' : v.running === false ? 'Long bot stopped' : gate ? gate.detail : entry ? 'Waiting for a buy setup' : 'Checking for a buy'}</p>
      <p className="mb-3 text-sm text-zinc-200">{v.summary}</p>
      {v.ready && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div>
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{holding ? 'It will SELL when ANY of these happens' : 'It will BUY when ALL of these are true'}</h4>
            <ul className="divide-y divide-zinc-800">{(holding ? v.exit : v.entry)?.map((c) => <Row key={c.label} c={c} neutral={holding} />)}</ul>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Safety checks (must also pass to buy)</h4>
            <ul className="divide-y divide-zinc-800">{v.gates?.map((c) => <Row key={c.label} c={c} />)}</ul>
          </div>
          <div className="text-sm">
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Right now ({v.symbol}, {v.timeframe} candles)</h4>
            <div className="num space-y-0.5 text-zinc-400">
              {v.facts?.map((f) => <div key={f}>{f}</div>)}
              {v.plan && !holding && <div className="pt-1 text-zinc-500">If it bought now: stop ≈ {f2(v.plan.stop)}, target ≈ {f2(v.plan.target)}</div>}
            </div>
            <p className="mt-3 text-xs text-zinc-500">It decides only when a {v.timeframe} candle <b>closes</b> (last close {time(v.lastCandleClose)}, next {time(v.nextCandleClose)}). While holding, the stop and target are also watched continuously. Every trade risks only a small part of the bot's money.</p>
          </div>
        </div>
      )}
    </Card>
  );
}
