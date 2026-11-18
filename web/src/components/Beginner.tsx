import { Card } from './ui';
import { f2 } from '../api';

export interface Banner { tone: 'good' | 'wait' | 'warn' | 'bad'; title: string; text: string }
export interface Row {
  symbol: string; role: string; status: 'holding' | 'ready' | 'waiting' | 'blocked' | 'unknown'; headline: string; price?: number;
  trigger: { label: string; price: number; awayPct: number } | null; missing: string[];
  scan: null | { oosReturnPct: number | null; pf: number | null; trades: number | null; passes: boolean; reasons: string[] };
}
export interface Watch { banner: Banner; advice: string[]; mode: 'paper' | 'live'; rows: Row[]; scanner: { enabled: boolean; running: boolean; lastScanAt: number | null; nextScanAt: number | null; selected: string | null; strategy: string; timeframe: string } }

const tone: Record<Banner['tone'], string> = {
  good: 'border-emerald-700 bg-emerald-950/60 text-emerald-100', wait: 'border-sky-800 bg-sky-950/50 text-sky-100',
  warn: 'border-amber-700 bg-amber-950/60 text-amber-100', bad: 'border-red-700 bg-red-950/60 text-red-100',
};
const dot: Record<Banner['tone'], string> = { good: 'bg-emerald-400', wait: 'bg-sky-400', warn: 'bg-amber-400', bad: 'bg-red-400' };

export function StatusBanner({ b, mode }: { b: Banner; mode: 'paper' | 'live' }) {
  return (
    <div className={`rounded-xl border p-4 ${tone[b.tone]}`}>
      <div className="flex items-center gap-2 text-lg font-semibold"><span className={`h-3 w-3 rounded-full ${dot[b.tone]}`} />{b.title}</div>
      <p className="mt-1 text-sm opacity-90">{b.text}</p>
      <p className="mt-2 text-xs opacity-70">{mode === 'paper' ? 'PRACTICE MODE: the bot trades with pretend money on real prices. No real money is used.' : 'LIVE MODE: the bot is using real money.'}</p>
    </div>
  );
}

const pill: Record<Row['status'], [string, string]> = {
  holding: ['Holding it now', 'bg-emerald-600 text-white'], ready: ['Ready to buy', 'bg-sky-600 text-white'],
  waiting: ['Waiting', 'bg-zinc-700 text-zinc-200'], blocked: ['Not approved', 'bg-amber-700 text-white'], unknown: ['No data', 'bg-zinc-800 text-zinc-400'],
};

export function Watchlist({ w }: { w: Watch }) {
  const sc = w.scanner;
  return (
    <Card title={sc.enabled ? 'Coins the bot is watching' : 'The coin the bot is watching'}>
      <p className="mb-3 text-sm text-zinc-400">
        {sc.enabled
          ? <>The scanner tests the strategy on liquid coins and keeps only the ones that did well in the past. The bot trades <b>one coin at a time</b>; the others are backups it can switch to later.
              {sc.running ? ' A scan is running now.' : sc.lastScanAt ? ` Last scan ${new Date(sc.lastScanAt).toLocaleString()}; next ${sc.nextScanAt ? new Date(sc.nextScanAt).toLocaleString() : 'soon'}.` : ''}</>
          : <>The scanner is off, so the bot only watches one coin. Turn on <code>AUTO_SCAN</code> in <code>.env</code> to let it choose.</>}
      </p>
      {w.rows.length === 0 ? <p className="text-sm text-zinc-500">{sc.running ? 'Scanning… this takes a few minutes.' : 'No coin has passed the scanner yet. The bot stays in cash, which is safe.'}</p> : (
        <div className="divide-y divide-zinc-800">
          {w.rows.map((r) => (
            <div key={r.symbol} className={`flex flex-wrap items-start gap-3 py-3 ${r.role === 'Trading now' ? 'rounded-lg bg-zinc-800/40 px-2' : ''}`}>
              <div className="w-28 shrink-0"><div className="font-semibold">{r.symbol.replace('/USDT', '')}</div><div className="text-xs text-zinc-500">{r.role}</div></div>
              <div className="w-28 shrink-0"><span className={`rounded px-2 py-0.5 text-xs font-medium ${pill[r.status][1]}`}>{pill[r.status][0]}</span><div className="num mt-1 text-xs text-zinc-500">{r.price ? `${f2(r.price)} USDT` : ''}</div></div>
              <div className="min-w-[14rem] flex-1 text-sm">
                <div className="text-zinc-200">{r.headline}</div>
                {r.scan && r.scan.passes && <div className="mt-0.5 text-xs text-zinc-500">Past test: {r.scan.oosReturnPct != null ? `${r.scan.oosReturnPct >= 0 ? '+' : ''}${f2(r.scan.oosReturnPct)}%` : '–'} in the recent period over {r.scan.trades ?? '–'} trades.</div>}
              </div>
            </div>))}
        </div>)}
    </Card>
  );
}

export function HelpCard({ strategy, timeframe }: { strategy: string; timeframe: string }) {
  const q = (t: string, a: React.ReactNode) => <div className="py-2"><div className="text-sm font-medium text-zinc-200">{t}</div><div className="text-sm text-zinc-400">{a}</div></div>;
  return (
    <details className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <summary className="cursor-pointer text-sm font-medium text-zinc-300">New here? How this works (click to open)</summary>
      <div className="mt-2 divide-y divide-zinc-800">
        {q('What does the bot do?', <>It watches crypto prices and buys a coin only when its rules say the price is likely to keep rising. It then sells by itself. You don't need to click anything except <b>Start</b>.</>)}
        {q('Is it using my real money?', <>Not while the badge says <b>PAPER</b>. Paper means practice: pretend money, real prices. Real money is used only if you switch to LIVE yourself and type a confirmation.</>)}
        {q('Why is nothing happening?', <>That is normal. With {timeframe} candles it only decides when a candle closes, and it buys only when all its conditions are true. That can take days. A bot that never buys is safer than one that buys constantly.</>)}
        {q('What if it loses?', <>Every trade has a <b>stop-loss</b>: a price where it sells automatically to limit the loss, and each trade risks only a small part of its money. If the bot loses too much in a day (3%) or overall (10%), it <b>stops itself</b>.</>)}
        {q('Can it lose everything?', <>It can only use the fixed amount you gave it (see "Bot's money" above), never the rest of your account. It can still lose part of that. No bot can promise profit, and most lose money. Test with practice money for weeks first.</>)}
        {q('What is the strategy?', <>"{strategy}". The Scanner tab shows how each coin did in past tests. A good past result is not a promise about the future.</>)}
        {q('What should I do each day?', <>Keep the program running (a sleeping laptop stops it). Look at this page. If a red box appears, read it. The red <b>PANIC</b> button stops everything right away.</>)}
      </div>
    </details>
  );
}
