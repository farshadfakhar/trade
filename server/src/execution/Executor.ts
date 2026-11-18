import { UnknownOutcomeError, floorToStep, type ExchangeAdapter, type Fill } from '../exchange/types.js';
import type { RiskManager } from '../risk/RiskManager.js';
import type { Candle, Position, Signal, Strategy } from '../strategy/types.js';

export type EventKind = 'signal' | 'risk' | 'order' | 'trade' | 'error';
export type Sink = (kind: EventKind, data: Record<string, unknown>) => void;
export interface ExecOpts {
  adapter: ExchangeAdapter; rm: RiskManager; strategy: Strategy; symbol: string;
  capital: number; riskPct: number; feePct: number; sink?: Sink;
  /** Paper/backtest only: lets stop/target exits fill at the trigger price. */
  setPrice?: (symbol: string, price: number, time: number) => void;
  /** Write-ahead guard: returns false if this clientOrderId was already used (e.g. a crash mid-order). */
  reserve?: (clientOrderId: string) => Promise<boolean>;
  /** Called after every state change so a restart can resume. */
  persist?: () => void;
  /** Returns a reason while new entries must not happen (e.g. the coin scanner has not approved this coin). Exits are never blocked. */
  entryBlock?: () => string | undefined;
}

/**
 * Strategy -> RiskManager -> Adapter. Identical in backtest, paper and live.
 * Every state-changing entry point runs through one queue, so a tick, a panic and a manual close can never interleave.
 */
export class Executor {
  position: Position | null = null;
  realized = 0;
  /** Non-empty = something needs a human; the bot refuses to trade until acknowledged. */
  problems: string[] = [];
  /** Set by stop/panic: no new entries even if a tick is mid-flight. */
  halted = false;
  /** Close time of the last losing trade; feeds the strategy's cooldown. */
  lastLossAt: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(public o: ExecOpts) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn, fn);
    this.chain = r.catch(() => {});
    return r;
  }
  /** Resolves when everything queued so far has finished (used on shutdown). */
  idle() { return this.chain; }

  private emit(k: EventKind, d: Record<string, unknown>) { this.o.sink?.(k, d); }
  private get base() { return this.o.symbol.split('/')[0]!; }
  private get id() { return this.o.symbol.replace(/[^A-Za-z0-9]/g, ''); }
  private problem(msg: string) { this.problems.push(msg); this.emit('error', { message: msg }); }

  state() { return { position: this.position, realized: this.realized, lastLossAt: this.lastLossAt }; }
  restore(s: { position: Position | null; realized: number; lastLossAt?: number }) { this.position = s.position; this.realized = s.realized; this.lastLossAt = s.lastLossAt; }

  equity(price: number) {
    return this.o.capital + this.realized + (this.position ? this.position.qty * price - this.position.cost : 0);
  }

  /** `candles` = closed candles, last one just closed. `dataTime` = when the signal candle closed. `livePrice` = current price, to catch stale signals. */
  onCandle(candles: Candle[], now: number, dataTime = now, livePrice?: number, htf?: Candle[]) {
    return this.run(async () => {
      const c = candles[candles.length - 1]!;
      await this.exits(c, now);

      const sig = this.o.strategy.onCandle(candles, this.position, { htf, lastLossAt: this.lastLossAt });
      if (sig.action !== 'hold') this.emit('signal', { symbol: this.o.symbol, ...sig, time: c.time });

      if (sig.action === 'sell' && this.position) await this.close(`${this.id}-s-${c.time}`, c.close, sig.reason, now);
      else if (sig.action === 'buy' && !this.position) await this.open(`${this.id}-b-${c.time}`, c.close, sig, now, dataTime, livePrice);
      else if (sig.newStop !== undefined && this.position) await this.raiseStop(sig.newStop);

      this.o.rm.updateEquity(this.equity(c.close));
      this.o.persist?.();
    });
  }

  /** Stop/target check against a (possibly still forming) candle. */
  checkExits(c: Candle, now: number) { return this.run(() => this.exits(c, now)); }

  /** Manual / panic exit at the given price. */
  closeNow(price: number, now: number, reason: string) {
    return this.run(async () => { if (this.position) await this.close(`${this.id}-m-${now}`, price, reason, now); });
  }

  /** Make sure the exchange stop still exists (re-places it if it vanished, books it if it fired). */
  ensureProtected(now: number) { return this.run(() => this.syncStop(now)); }

  /** After a restart: reconcile tracked position against the exchange. Returns (and records) problems. */
  reconcile(now: number): Promise<string[]> {
    return this.run(async () => {
      const p = this.position;
      if (!p) return this.problems;
      try {
        if (p.stopRef) await this.syncStop(now);
        else if (this.o.adapter.stops && !(await this.protect(p))) this.problems.push('tracked position has no exchange stop and one could not be placed');
        const q = this.position;
        if (q) { // total balance: coins locked in our own stop still count
          const bal = await (this.o.adapter.getTotalBalance ?? this.o.adapter.getBalance).call(this.o.adapter, this.base);
          if (bal < q.qty * 0.99) this.problems.push(`exchange ${this.base} balance ${bal} is below the tracked position ${q.qty}`);
        }
      } catch (e) { this.problems.push(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`); }
      return this.problems;
    });
  }

  // ---- everything below runs inside the queue ----

  /** With an exchange-side stop, the exchange does the stop job; we only poll it. */
  private async exits(c: Candle, now: number) {
    const p = this.position;
    if (!p) return;
    const id = `${this.id}-s-${c.time}`;
    if (p.stopRef) await this.syncStop(now);
    else if (c.low <= p.stop) return this.close(id, Math.min(p.stop, c.open), 'stop-loss', now); // stop first: if one candle touches both, assume the worse outcome
    const q = this.position;
    if (!q || c.high < q.target) return;
    if (!q.partial) return this.close(id, q.target, 'take-profit', now);
    if (!q.partialDone) await this.takeFirstTarget(q, id, now);
  }

  /** First target of a scale-out strategy: sell part, move the stop to breakeven. If the slice is too small for the exchange, just move the stop. */
  private async takeFirstTarget(p: Position, id: string, now: number) {
    try {
      const m = await this.o.adapter.getMarket(p.symbol);
      const want = floorToStep(p.qty * p.partial!.fraction, m.qtyStep);
      if (want < m.minQty || want * p.target < m.minNotional) { // too small to sell separately: skip the sale, keep the protection step
        p.partialDone = true; this.emit('error', { message: `first target hit but ${want} is below the exchange minimum; only moving the stop to breakeven` });
        await this.raiseStop(p.entry);
        return;
      }
    } catch (e) { return this.fail(e); }
    await this.close(id + 'p', p.target, 'take-profit (first target)', now, p.partial!.fraction, true);
  }

  /** Trailing / breakeven: only ever raises the stop. On the exchange: cancel the old stop, place the new one; the old one is restored if that fails. */
  private async raiseStop(newStop: number) {
    const p = this.position;
    if (!p || !(newStop > p.stop)) return;
    if (!p.stopRef) { p.stop = newStop; return this.o.persist?.(); } // simulated stop (paper/backtest)
    const old = p.stop;
    try { await this.o.adapter.stops!.cancel(p.stopRef); p.stopRef = undefined; }
    catch (e) { return this.fail(e); } // keep the old stop; the next candle tries again (or syncStop notices it filled)
    p.stop = newStop;
    if (!(await this.protect(p))) {
      p.stop = old;
      if (!(await this.protect(p))) this.problems.push('could not move the stop and could not restore the old one: position is UNPROTECTED');
    }
  }

  private async open(clientOrderId: string, price: number, sig: Signal, now: number, dataTime: number, livePrice?: number) {
    const sym = this.o.symbol, { stop, target } = sig;
    if (this.halted) return this.emit('risk', { approved: false, reason: 'bot is stopped/halted' });
    const blocked = this.o.entryBlock?.();
    if (blocked) return this.emit('risk', { approved: false, reason: blocked });
    if (stop === undefined || target === undefined) return this.emit('risk', { approved: false, reason: 'signal without stop/target' });
    if (livePrice !== undefined && (livePrice <= stop || livePrice >= target)) return this.emit('risk', { approved: false, reason: `live price ${livePrice} is already outside stop/target; signal is stale` });
    let sent = false;
    try {
      const qty = (this.equity(price) * this.o.riskPct / 100) / (price - stop);
      const market = await this.o.adapter.getMarket(sym);
      const d = this.o.rm.evaluate({ symbol: sym, side: 'buy', qty, price, stopLoss: stop }, { now, dataTime, market });
      this.emit('risk', { symbol: sym, side: 'buy', requestedQty: qty, ...d });
      if (!d.approved) return;
      if (this.o.reserve && !(await this.o.reserve(clientOrderId))) return this.problem(`order ${clientOrderId} was already attempted before a restart; check the exchange before resuming`);
      sent = true;
      const fill = await this.o.adapter.marketOrder({ clientOrderId, symbol: sym, side: 'buy', qty: d.qty });
      this.o.rm.recordExchangeSuccess();
      this.emit('order', { ...fill });
      // Fees may be taken in the base coin, so only count what the wallet really holds. If that lookup fails, trust the fill.
      const bal = await this.o.adapter.getBalance(this.base).catch(() => fill.qty);
      const held = floorToStep(Math.min(fill.qty, bal), market.qtyStep);
      const cost = fill.qty * fill.price + fill.fee;
      this.position = { symbol: sym, qty: held, entry: fill.price, stop, target, cost, entryTime: now, ...(sig.partial ? { partial: sig.partial, partialDone: false } : {}) };
      this.o.rm.onOpen(sym, cost, now);
      this.o.persist?.();
      // Never leave a position unprotected: if the exchange stop can't be placed, get out.
      if (this.o.adapter.stops && !(await this.protect(this.position))) {
        this.emit('error', { message: 'could not place the protective stop; closing the position' });
        await this.close(`${clientOrderId}-e`, price, 'no stop protection', now);
      }
    } catch (e) {
      if (sent && e instanceof UnknownOutcomeError) this.problem(`buy ${clientOrderId}: outcome unknown (${e.message}). Check the exchange for fills/coins before resuming.`);
      this.fail(e);
    }
  }

  /** (Re)places the exchange-side stop. */
  private async protect(p: Position): Promise<boolean> {
    try {
      p.stopRef = await this.o.adapter.stops!.place(p.symbol, p.qty, p.stop, `${this.id}-x-${Date.now()}`.slice(0, 32));
      this.o.persist?.();
      return true;
    } catch (e) {
      if (e instanceof UnknownOutcomeError) this.problem(`stop order outcome unknown (${e.message}). A stop may exist on the exchange: check before resuming.`);
      this.fail(e);
      return false;
    }
  }

  /** Poll the exchange stop; book the trade if it fired; re-place it if it vanished. */
  private async syncStop(now: number) {
    const p = this.position;
    if (!p?.stopRef) return;
    try {
      const i = await this.o.adapter.stops!.status(p.stopRef);
      if (i.state === 'filled') this.book(p, i.avgPrice, i.filledQty, i.filledQty * i.avgPrice * this.o.feePct / 100, 'stop-loss (exchange)', now);
      else if (i.state === 'canceled') {
        this.emit('error', { message: 'protective stop was canceled outside the bot; re-placing it' });
        p.stopRef = undefined;
        if (!(await this.protect(p))) { this.problems.push('protective stop lost and could not be re-placed'); await this.close(`${this.id}-e-${now}`, p.stop, 'stop lost', now); }
      }
    } catch (e) { this.fail(e); }
  }

  private book(p: Position, price: number, qty: number, fee: number, reason: string, now: number) {
    const pnl = qty * price - fee - p.cost;
    this.realized += pnl;
    this.position = null;
    if (pnl < 0) this.lastLossAt = now;
    this.o.rm.onClose(p.symbol, pnl, now);
    this.emit('trade', { symbol: p.symbol, entry: p.entry, exit: price, qty, pnl, reason, time: now });
    this.o.persist?.();
  }

  /** Only part of the position sold: book that part against its share of the cost, keep (and re-protect) the rest. */
  private async bookPartial(p: Position, fill: Fill, reason: string, now: number, tp1 = false) {
    const share = p.cost * fill.qty / p.qty;
    const pnl = fill.qty * fill.price - fill.fee - share;
    this.realized += pnl;
    this.position = { ...p, qty: p.qty - fill.qty, cost: p.cost - share, stopRef: undefined, ...(tp1 ? { partialDone: true, stop: Math.max(p.stop, p.entry) } : {}) }; // first target taken: stop to breakeven
    this.o.rm.onPartialClose(p.symbol, pnl, this.position.cost, now);
    this.emit('trade', { symbol: p.symbol, entry: p.entry, exit: fill.price, qty: fill.qty, pnl, reason: `${reason} (partial)`, time: now });
    this.o.persist?.();
    if (this.o.adapter.stops && !(await this.protect(this.position))) this.problems.push('partial sell left a position without a stop');
  }

  private async close(clientOrderId: string, price: number, reason: string, now: number, fraction = 1, tp1 = false) {
    const p = this.position!;
    let sent = false;
    try {
      this.o.setPrice?.(p.symbol, price, now);
      const market = await this.o.adapter.getMarket(p.symbol);
      const d = this.o.rm.evaluate({ symbol: p.symbol, side: 'sell', qty: p.qty, price }, { now, dataTime: now, market });
      this.emit('risk', { symbol: p.symbol, side: 'sell', ...d });
      if (!d.approved) return;
      const ref = p.stopRef;
      if (ref) { // free the coins first
        try { await this.o.adapter.stops!.cancel(ref); p.stopRef = undefined; }
        catch {
          const i = await this.o.adapter.stops!.status(ref).catch(() => null);
          if (i?.state === 'filled') return this.book(p, i.avgPrice, i.filledQty, i.filledQty * i.avgPrice * this.o.feePct / 100, 'stop-loss (exchange)', now); // it fired first: don't sell twice
          if (i?.state !== 'canceled') return; // still live or unknown: keep everything as is, retry later
          p.stopRef = undefined; // already gone: nothing left to cancel, go on and sell
        }
      }
      try {
        const bal = await this.o.adapter.getBalance(this.base);
        const want = floorToStep(p.qty * fraction, market.qtyStep);
        const qty = floorToStep(Math.min(want, bal), market.qtyStep);
        if (qty < want * 0.99) { this.problems.push(`wallet holds ${bal} ${this.base}, less than the ${want} to sell; not selling less than intended`); throw new Error('wallet balance below tracked position'); }
        sent = true;
        const fill = await this.o.adapter.marketOrder({ clientOrderId, symbol: p.symbol, side: 'sell', qty });
        this.o.rm.recordExchangeSuccess();
        this.emit('order', { ...fill });
        if (fraction < 1 || fill.qty < qty * 0.99) await this.bookPartial(p, fill, reason, now, tp1);
        else this.book(p, fill.price, fill.qty, fill.fee, reason, now);
      } catch (e) {
        if (sent && e instanceof UnknownOutcomeError) this.problem(`sell ${clientOrderId}: outcome unknown (${e.message}). Check the exchange before resuming.`);
        else if (this.o.adapter.stops && !p.stopRef && !(await this.protect(p))) this.problems.push('sell failed and the protective stop could not be restored: position is UNPROTECTED');
        throw e;
      }
    } catch (e) { this.fail(e); } // position stays; the exit is retried next candle
  }

  private fail(e: unknown) {
    this.o.rm.recordExchangeError();
    this.emit('error', { message: e instanceof Error ? e.message : String(e) });
  }
}
