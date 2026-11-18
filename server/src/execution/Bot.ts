import { EventEmitter } from 'node:events';
import { closedOnly } from '../data/candles.js';
import type { ExchangeAdapter } from '../exchange/types.js';
import type { RiskManager } from '../risk/RiskManager.js';
import type { Candle } from '../strategy/types.js';
import type { Executor } from './Executor.js';

export interface BotDeps {
  mode: 'paper' | 'live'; symbol: string; resolution: string; tfMs: number;
  adapter: ExchangeAdapter; rm: RiskManager; executor: Executor;
  fetchRecent: (symbol: string) => Promise<Candle[]>;
  /** Optional higher-timeframe feed (e.g. 1h trend for a 15m strategy). */
  htf?: { resolution: string; fetch: (symbol: string) => Promise<Candle[]> };
  /** Called with the closed candles after each newly processed candle (used to record history). */
  onClosed?: (closed: Candle[]) => void;
  setPrice?: (symbol: string, price: number, time: number) => void; // paper only
  onEquity?: (equity: number) => void;
  now?: () => number; pollMs?: number;
}

/** Polling runner around the Executor. Emits 'event' for anything worth pushing to the dashboard. */
export class Bot extends EventEmitter {
  running = false;
  liveConfirmed = false;
  lastDataTime = 0;
  lastError = '';
  private lastCandle = 0;
  private pending?: string;
  private lastPrice?: number;
  private feedErrors = 0;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private now: () => number;

  constructor(private d: BotDeps) { super(); this.now = d.now ?? Date.now; }

  get symbol() { return this.d.symbol; }
  /** The coin the scanner wants next (applied as soon as the bot is flat). */
  get pendingSymbol() { return this.pending; }

  /** Switch the traded coin. Only ever happens while flat; with an open position the request waits for the exit. */
  requestSymbol(s: string) {
    this.pending = s === this.d.symbol ? undefined : s;
    if (!this.running && this.pending && !this.d.executor.position) this.applyPending();
  }
  private applyPending() {
    const s = this.pending;
    if (!s || this.d.executor.position) return;
    this.pending = undefined;
    this.setSymbol(s);
    this.d.executor.o.persist?.();
    this.emit('event', { type: 'info', message: `now trading ${s}` });
    this.pushStatus();
  }
  private setSymbol(s: string) {
    this.d.symbol = s; this.d.executor.o.symbol = s;
    this.lastCandle = 0; this.lastPrice = undefined; this.feedErrors = 0;
  }
  /** Startup only: follow a restored open position onto its coin. */
  adoptSymbol(s: string) { this.pending = undefined; this.setSymbol(s); }

  start() {
    if (this.running) return;
    if (this.d.mode === 'live' && !this.liveConfirmed) throw new Error('LIVE mode needs typed confirmation first');
    if (this.d.executor.problems.length) throw new Error(`reconciliation problems must be resolved first: ${this.d.executor.problems.join('; ')}`);
    if (this.d.rm.status(this.now()).killed) throw new Error('max-drawdown kill switch is active; reset it manually first');
    this.d.rm.recordExchangeSuccess(); // a manual Start is the only thing that clears the error streak
    this.feedErrors = 0; this.lastError = '';
    this.d.executor.halted = false;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.d.pollMs ?? 30_000);
    this.emit('event', { type: 'bot', running: true });
    void this.tick();
  }

  /** Stops polling and blocks new entries, even from a tick that is already mid-flight. */
  stop() {
    this.d.executor.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.running) this.emit('event', { type: 'bot', running: false });
    this.running = false;
  }

  private halt(reason: string) {
    this.lastError = reason;
    this.stop();
    this.emit('event', { type: 'error', message: `bot stopped: ${reason}` });
  }

  /** Panic: stop, market-close first if asked (that also removes our own stop), then cancel stray orders, then make sure any remaining position is still protected. */
  async panic(marketClose: boolean) {
    this.stop();
    this.liveConfirmed = false; // starting again in LIVE needs a fresh typed confirmation
    const errors: string[] = [];
    const { executor, adapter } = this.d;
    if (marketClose && executor.position) {
      try {
        const px = (await this.d.fetchRecent(this.d.symbol)).at(-1)!.close;
        this.d.setPrice?.(this.d.symbol, px, this.now());
        await executor.closeNow(px, this.now(), 'panic');
        if (executor.position) errors.push('market close failed; position still open');
      } catch (e) { errors.push(`close: ${msg(e)}`); }
    }
    try { await adapter.cancelAllOrders(); } catch (e) { errors.push(`cancel: ${msg(e)}`); }
    if (executor.position) {
      try { await executor.ensureProtected(this.now()); } catch (e) { errors.push(`stop check: ${msg(e)}`); }
      if (executor.position && !executor.position.stopRef && adapter.stops) errors.push('position is open WITHOUT a stop');
    }
    this.emit('event', { type: 'panic', marketClose, errors });
    this.pushStatus();
    return { errors };
  }

  /** Manual restart after the drawdown kill switch; re-bases the peak to current equity. */
  resetKill() { this.d.rm.resetKill(this.status().equity); this.d.executor.o.persist?.(); this.pushStatus(); }

  /** The human has checked the exchange and accepts the current state. */
  ackProblems() { this.d.executor.problems = []; this.pushStatus(); }

  /** "Close now" button. */
  async closeNow() {
    const px = (await this.d.fetchRecent(this.d.symbol)).at(-1)!.close;
    this.d.setPrice?.(this.d.symbol, px, this.now());
    await this.d.executor.closeNow(px, this.now(), 'manual close');
    this.pushStatus();
  }

  /** Wait for in-flight work (shutdown). */
  async drain() { while (this.busy) await new Promise((r) => setTimeout(r, 50)); await this.d.executor.idle(); }

  async tick() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      if (this.pending) { await this.d.executor.idle(); this.applyPending(); }
      const all = await this.d.fetchRecent(this.d.symbol);
      if (!this.running) return; // stopped or panicked while we were fetching
      const t = this.now();
      this.feedErrors = 0; this.lastDataTime = t; this.lastError = '';
      const last = all[all.length - 1]!;
      this.lastPrice = last.close;
      this.d.setPrice?.(this.d.symbol, last.close, t);
      // Intra-candle stop/target protection, only if this really is the still-forming candle (it opened at our last entry).
      if (last.time + this.d.tfMs > t) await this.d.executor.checkExits(last, t);
      const htfClosed = this.d.htf ? closedOnly(await this.d.htf.fetch(this.d.symbol), this.d.htf.resolution, t) : undefined;
      if (!this.running) return;
      const closed = closedOnly(all, this.d.resolution, t);
      const sig = closed[closed.length - 1];
      if (sig && sig.time > this.lastCandle && this.running) {
        this.lastCandle = sig.time;
        // dataTime = when the signal candle closed: buys on an old signal are rejected by the stale-data rule.
        await this.d.executor.onCandle(closed, t, sig.time + this.d.tfMs, last.close, htfClosed);
        this.d.onClosed?.(closed);
        this.d.onEquity?.(this.d.executor.equity(last.close));
      }
    } catch (e) {
      this.lastError = msg(e);
      this.emit('event', { type: 'error', message: this.lastError });
      if (++this.feedErrors >= this.d.rm.c.MAX_EXCHANGE_ERRORS) this.halt(`price feed failed ${this.feedErrors} times in a row: ${this.lastError}`);
    } finally {
      this.busy = false;
      const { executor, rm } = this.d;
      if (this.running && executor.problems.length) this.halt(`needs your attention: ${executor.problems.join('; ')}`);
      else if (this.running && rm.status(this.now()).errors >= rm.c.MAX_EXCHANGE_ERRORS) this.halt('too many consecutive exchange errors');
      this.pushStatus();
    }
  }

  pushStatus() { this.emit('event', { type: 'status', ...this.status() }); }

  status() {
    const t = this.now();
    const { executor, rm } = this.d;
    return {
      mode: this.d.mode, running: this.running, liveConfirmed: this.liveConfirmed, symbol: this.d.symbol,
      lastDataTime: this.lastDataTime, lastError: this.lastError,
      equity: executor.equity(this.lastPrice ?? executor.position?.entry ?? 0), realized: executor.realized,
      position: executor.position, problems: executor.problems, risk: rm.status(t),
      limits: { dailyLossPct: rm.c.DAILY_LOSS_LIMIT_PCT, maxDrawdownPct: rm.c.MAX_DRAWDOWN_PCT, maxTrades: rm.c.MAX_TRADES_PER_DAY, capital: rm.c.BOT_CAPITAL_USDT },
    };
  }

  /** Executor events are forwarded here by main (sink fan-out). */
  note(kind: string, data: Record<string, unknown>) { this.emit('event', { type: kind, ...data }); }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
