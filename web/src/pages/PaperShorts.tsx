import { useEffect, useRef, useState } from 'react';
import { api, f2, pnlColor } from '../api';
import { Btn, Card } from '../components/ui';

const pairs = ['BTC/USDT', 'ZEC/USDT'] as const;
type Pair = typeof pairs[number];
interface Position { opened: number; entry: number; stop: number; target: number; qty: number }
interface Trade extends Position { closed: number; cover: number; fees: number; net: number; reason: string }
interface Portfolio { cash: number; position: Position | null; trades: Trade[]; closed: number; skipped: number }
interface Check { label: string; ok: boolean; detail: string }
interface EntryView {
  candleClose?: number; nextClose: number; checks: Check[];
  entry?: number; stop?: number; target?: number; costPct?: number; maxCostPct?: number;
  size?: { baseline: boolean; filtered: boolean };
}
interface Status {
  capital: number; running: boolean; error: string; quote?: { bid: number; ask: number; time: number };
  entryView?: EntryView;
  baseline: Portfolio; filtered: Portfolio;
}
const usdt = (value: number) => value.toFixed(4);

function PortfolioCard({ title, data, capital, selective = false }: { title: string; data: Portfolio; capital: number; selective?: boolean }) {
  const pnl = data.cash - capital, p = data.position;
  return <Card title={title}>
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-zinc-400">Realized P&L (USDT)</dt><dd className={pnlColor(pnl)}>{usdt(pnl)}</dd></div>
      <div><dt className="text-zinc-400">Closed shorts</dt><dd>{data.closed}</dd></div>
      {selective && <div><dt className="text-zinc-400">Skipped on cost</dt><dd>{data.skipped}</dd></div>}
    </dl>
    <p className="my-4 text-sm text-zinc-300">{p
      ? `Open short · ${p.qty} at ${f2(p.entry)} · stop ${f2(p.stop)} · target ${f2(p.target)}`
      : 'No open short'}</p>
    {data.trades.length > 0 && <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Recent closed shorts</caption>
        <thead className="text-xs text-zinc-400"><tr>{['Closed', 'Entry', 'Cover', 'Fees', 'Net P&L', 'Exit'].map((label) =>
          <th scope="col" className="px-2 py-2" key={label}>{label}</th>)}</tr></thead>
        <tbody>{data.trades.map((t) => <tr key={t.closed} className="border-t border-zinc-800">
          <td className="px-2 py-2 whitespace-nowrap">{new Date(t.closed).toLocaleString()}</td>
          <td className="px-2 py-2">{f2(t.entry)}</td><td className="px-2 py-2">{f2(t.cover)}</td>
          <td className="px-2 py-2">{usdt(t.fees)}</td><td className={`px-2 py-2 ${pnlColor(t.net)}`}>{usdt(t.net)}</td>
          <td className="px-2 py-2">{t.reason}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </Card>;
}

function ShortChecklist({ status }: { status: Status }) {
  const view = status.entryView;
  const ready = status.running && !status.error;
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const checks = view?.checks ?? [];
  const pending = checks.find((check) => !check.ok);
  const count = Number(!!status.baseline.position) + Number(!!status.filtered.position);
  const title = !status.running ? 'Paused' : status.error ? 'Waiting for fresh market data'
    : !view ? 'Fetching market data' : count ? `${count} simulated short${count === 1 ? '' : 's'} open`
    : pending?.label ? 'Waiting for a short setup' : 'Setup checked';
  return <Card title="When will it open a short?">
    <p className="text-base font-semibold" role="status">{title}</p>
    <p className="mt-1 text-sm text-zinc-400">A short sells first and buys back later. A lower buyback price can produce a profit after fees.</p>
    {view && ready && <>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-400">
        {view.candleClose && <span>Last price period closed {time(view.candleClose)}</span>}
        <span>Next scheduled 15-minute close {time(view.nextClose)}</span>
      </div>
      <ol className="mt-3 divide-y divide-zinc-800">
        {checks.map((check) => <li key={check.label} className="flex items-start gap-3 py-2 text-sm">
          <span className={check.ok ? 'shrink-0 text-emerald-400' : 'shrink-0 text-amber-300'}>{check.ok ? '✓ Met' : '○ Waiting'}</span>
          <div>{check.label}<p className="text-xs text-zinc-400">{check.detail}</p></div>
        </li>)}
      </ol>
      {view.entry !== undefined && <div className="mt-3 grid gap-2 rounded-lg bg-zinc-950 p-3 text-sm sm:grid-cols-3">
        <div>Sell near <b>{f2(view.entry)}</b></div>
        <div>Buy back to limit loss near <b>{f2(view.stop)}</b></div>
        <div>Profit target near <b>{f2(view.target)}</b></div>
        {view.costPct !== undefined && view.maxCostPct !== undefined &&
          <p className={`sm:col-span-3 ${view.costPct <= view.maxCostPct ? 'text-emerald-400' : 'text-amber-300'}`}>
            Cost-filtered portfolio {view.costPct <= view.maxCostPct ? 'passes' : 'skips this quote'}.
            Estimated cost {f2(view.costPct)}%, limit {f2(view.maxCostPct)}%.
          </p>}
        {view.size && (['baseline', 'filtered'] as const).some((key) => !status[key].position && !view.size![key]) &&
          <p className="text-amber-300 sm:col-span-3">At least one portfolio cannot open the exchange’s minimum order within its risk budget.</p>}
      </div>}
    </>}
    <p className="mt-3 text-xs text-zinc-400">The Overview tab shows long entries. A long buys first and can profit if it sells later at a higher price.</p>
  </Card>;
}

export default function PaperShorts() {
  const [pair, setPair] = useState<Pair>(pairs[0]);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const version = revision.current;
      try {
        const next = await api<Status>(`/paper-shorts?pair=${encodeURIComponent(pair)}`);
        if (active && version === revision.current) { setStatus(next); setError(''); }
      } catch (e) {
        if (active && version === revision.current) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [pair]);

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    revision.current++;
    try {
      const next = await api<Status>(`/paper-shorts/${status.running ? 'stop' : 'start'}`, { body: { pair } });
      revision.current++;
      setStatus(next);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return <section className="space-y-4">
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Paper Shorts</h1>
        <label className="flex items-center gap-2 text-sm">Market
          <select className="rounded border border-zinc-700 bg-zinc-950 p-1.5" value={pair} disabled={busy}
            onChange={(e) => { revision.current++; setStatus(undefined); setError(''); setPair(e.target.value as Pair); }}>
            {pairs.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <span className="text-sm text-zinc-400">{status ? status.running ? 'Running' : 'Paused' : 'Loading…'}</span>
        <Btn disabled={busy || !status} tone={status?.running ? 'default' : 'green'} onClick={toggle}>
          {status?.running ? 'Pause shorts' : 'Start shorts'}
        </Btn>
      </div>
      <p className="mt-3 text-sm text-zinc-400">Simulated positions. Pausing or restarting the server suspends entry and exit checks until you start the runner again.</p>
      {status?.quote && <p className="mt-2 text-sm">Bid {f2(status.quote.bid)} · Ask {f2(status.quote.ask)} · {new Date(status.quote.time).toLocaleTimeString()}</p>}
      {(error || status?.error) && <p role="alert" className="mt-2 text-sm text-red-400">{error || status?.error}</p>}
    </Card>
    {status && <ShortChecklist status={status} />}
    {status && <div className="grid gap-4 xl:grid-cols-2">
      <PortfolioCard title="Baseline" data={status.baseline} capital={status.capital} />
      <PortfolioCard title="Cost-filtered" data={status.filtered} capital={status.capital} selective />
    </div>}
  </section>;
}
