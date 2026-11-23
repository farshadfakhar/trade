import { EMA } from 'technicalindicators';
import { floorToStep, type MarketInfo } from '../exchange/types.js';
import type { Candle } from '../strategy/types.js';

export const shortPairs = ['BTC/USDT', 'ZEC/USDT'] as const;
export type ShortPair = typeof shortPairs[number];
const portfolios = ['baseline', 'filtered'] as const;
const quarter = 900_000, hour = 4 * quarter;
const capital = 10, riskFraction = 0.01;

interface Position {
  opened: number; entry: number; stop: number; target: number; qty: number;
  entryBid: number; entryAsk: number;
}
interface Trade extends Position {
  closed: number; cover: number; exitBid: number; exitAsk: number;
  fees: number; net: number; reason: string;
}
interface Portfolio {
  cash: number; position: Position | null; trades: Trade[]; closed: number; skipped: number;
}
export interface PaperShortState {
  baseline: Portfolio; filtered: Portfolio; lastSignal: number;
}
export interface ShortSample {
  bid: number; ask: number; quoteTime: number; bars: Candle[]; hourly: Candle[]; market: MarketInfo; candleError?: string;
}

interface EntryCheck { label: string; ok: boolean; detail: string }
interface EntryView {
  candleClose?: number; nextClose: number; checks: EntryCheck[];
  entry?: number; stop?: number; target?: number; costPct?: number; maxCostPct?: number;
  size?: Record<typeof portfolios[number], boolean>;
}
const price = (value: number) => value.toFixed(2);

const empty = (): Portfolio => ({ cash: capital, position: null, trades: [], closed: 0, skipped: 0 });
export const newPaperShortState = (): PaperShortState => ({ baseline: empty(), filtered: empty(), lastSignal: 0 });

export function updateShorts(state: PaperShortState, sample: ShortSample, now: number, fee: number, slip: number): EntryView {
  const { bid, ask, quoteTime, market } = sample;
  if (![bid, ask, quoteTime].every(Number.isFinite) || bid <= 0 || bid > ask || now - quoteTime > 30_000 || quoteTime - now > 5000) {
    throw new Error('No fresh bid and ask available');
  }
  const entry = bid * (1 - slip), cover = ask * (1 + slip);
  for (const name of portfolios) {
    const account = state[name], position = account.position;
    if (!position) continue;
    const reason = cover >= position.stop ? 'stop' : cover <= position.target ? 'target' : now - position.opened >= 4 * hour ? 'time' : undefined;
    if (!reason) continue;
    const fees = position.qty * (position.entry + cover) * fee;
    const net = position.qty * (position.entry - cover) - fees;
    account.cash += net;
    account.closed++;
    account.trades.unshift({ ...position, closed: now, cover, exitBid: bid, exitAsk: ask, fees, net, reason });
    account.trades = account.trades.slice(0, 200);
    account.position = null;
  }

  const bars = sample.bars.filter((bar) => bar.time + quarter <= now);
  const hourly = sample.hourly.filter((bar) => bar.time + hour <= now);
  const view: EntryView = { nextClose: (Math.floor(now / quarter) + 1) * quarter, checks: [] };
  const historyReady = bars.length >= 21 && hourly.length >= 51;
  view.checks.push({
    label: 'Recent price history is available', ok: historyReady,
    detail: historyReady ? 'Using completed 15-minute and one-hour periods.' : 'Waiting for enough completed 15-minute and one-hour periods.',
  });
  if (!historyReady) return view;
  const bounce = bars.at(-2)!, signal = bars.at(-1)!, latestHour = hourly.at(-1)!;
  const closeTime = signal.time + quarter;
  view.candleClose = closeTime;
  const fresh = now - closeTime <= 60_000 && signal.time - bounce.time === quarter &&
    now - latestHour.time - hour < hour && latestHour.time - hourly.at(-2)!.time === hour;
  const fast = EMA.calculate({ period: 20, values: bars.map((bar) => bar.close) });
  const slow = EMA.calculate({ period: 50, values: hourly.map((bar) => bar.close) });
  const downtrend = latestHour.close < slow.at(-1)! && slow.at(-1)! < slow.at(-2)!;
  const bounced = bounce.high >= fast.at(-2)!;
  const threshold = Math.min(fast.at(-1)!, bounce.low);
  const turnedDown = signal.close < threshold;
  view.checks.push(
    { label: 'The broader trend is falling', ok: downtrend, detail: `The one-hour close needs to be below a falling average. Close ${price(latestHour.close)}, average ${price(slow.at(-1)!)}.` },
    { label: 'Price bounced up toward its recent average', ok: bounced, detail: `Previous 15-minute high ${price(bounce.high)}, average ${price(fast.at(-2)!)}.` },
    { label: 'The bounce failed and price turned down', ok: turnedDown, detail: `The 15-minute close needs to be below ${price(threshold)}. It closed at ${price(signal.close)}.` },
    { label: 'The entry window is open', ok: fresh, detail: fresh ? 'The latest 15-minute period just closed.' : 'Entries are checked during the first minute after a 15-minute period closes.' },
  );
  const evaluate = fresh && closeTime > state.lastSignal;
  if (evaluate) state.lastSignal = closeTime;
  if (!(downtrend && bounced && turnedDown)) return view;

  const stop = Math.max(bounce.high, signal.high), target = entry - 2 * (stop - entry);
  const usable = target > 0 && entry < stop && cover < stop;
  if (!usable) {
    view.checks.push({ label: 'The quoted entry leaves room for the stop and target', ok: false, detail: 'The current quote is too close to the stop or the target is outside the valid price range.' });
    return view;
  }
  const risk = stop * (1 + slip) * (1 + fee) - entry * (1 - fee);
  const cost = cover - entry + (entry + cover) * fee;
  Object.assign(view, { entry, stop, target, costPct: cost / entry * 100, maxCostPct: (entry - target) / entry * 100 / 3 });
  const size = { baseline: false, filtered: false };
  view.size = size;
  for (const name of portfolios) {
    const account = state[name];
    if (account.position || account.cash <= 0) continue;
    const qty = floorToStep(Math.min(account.cash * riskFraction / risk, account.cash / (entry * (1 + fee))), market.qtyStep);
    size[name] = qty >= market.minQty && qty * entry >= market.minNotional;
    if (!size[name] || !evaluate) continue;
    if (name === 'filtered' && cost > (entry - target) / 3) { account.skipped++; continue; }
    account.position = { opened: now, entry, stop, target, qty, entryBid: bid, entryAsk: ask };
  }
  return view;
}

export class PaperShorts {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private quote?: { bid: number; ask: number; time: number };
  private error = '';
  private entryView?: EntryView;

  constructor(
    private state: PaperShortState,
    private sample: () => Promise<ShortSample>,
    private save: (state: PaperShortState) => Promise<unknown>,
    private fee: number,
    private slip: number,
  ) {}

  status() {
    return { ...this.state, running: this.timer !== undefined, quote: this.quote, error: this.error, entryView: this.entryView, capital };
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), 15_000);
      this.poll();
    }
    return this.status();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    return this.status();
  }

  private poll() {
    const timer = this.timer;
    if (!timer || this.pending) return;
    this.pending = (async () => {
      try {
        const sample = await this.sample();
        if (this.timer !== timer) return;
        const next = structuredClone(this.state);
        const entryView = updateShorts(next, sample, Date.now(), this.fee, this.slip);
        if (JSON.stringify(next) !== JSON.stringify(this.state)) {
          await this.save(next);
          this.state = next;
        }
        this.entryView = entryView;
        this.quote = { bid: sample.bid, ask: sample.ask, time: sample.quoteTime };
        this.error = sample.candleError ?? '';
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Paper short poll failed';
      }
    })().finally(() => { this.pending = undefined; });
  }
}
