import { floorToStep, type MarketInfo, type Side } from '../exchange/types.js';

export interface RiskConfig {
  BOT_CAPITAL_USDT: number; RISK_PER_TRADE_PCT: number; MAX_OPEN_POSITIONS: number; MAX_TRADES_PER_DAY: number;
  DAILY_LOSS_LIMIT_PCT: number; MAX_DRAWDOWN_PCT: number;
  STALE_DATA_SECONDS: number; MAX_EXCHANGE_ERRORS: number; FEE_PCT: number;
}

export interface OrderIntent { symbol: string; side: Side; qty: number; price: number; stopLoss?: number }
export interface Ctx { now: number; dataTime: number; market: MarketInfo } // epoch ms
export interface RiskSnapshot { day: string; dailyPnl: number; tradesToday: number; dailyHalted: boolean; killed: boolean; peak: number; realized: number; open: [string, number][] }
export type Decision = { approved: true; qty: number } | { approved: false; reason: string };

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const bad = (n: number) => !Number.isFinite(n) || n <= 0;
const no = (reason: string): Decision => ({ approved: false, reason });

/**
 * Gate between strategy and exchange. Buys are checked against every rule and may be
 * shrunk (never grown). Sells only reduce risk, so they pass unless malformed.
 */
export class RiskManager {
  private day = '';
  private dailyPnl = 0;
  private tradesToday = 0;
  private dailyHalted = false;
  private killed = false;
  private peak: number;
  private errors = 0;
  private open = new Map<string, number>(); // symbol -> cost in USDT
  private realized = 0;

  constructor(public c: RiskConfig) { this.peak = c.BOT_CAPITAL_USDT; }

  /** Auto-resets daily counters at UTC midnight. Kill switch is NOT reset. */
  private roll(now: number) {
    const d = dayOf(now);
    if (d !== this.day) { this.day = d; this.dailyPnl = 0; this.tradesToday = 0; this.dailyHalted = false; }
  }

  evaluate(o: OrderIntent, x: Ctx): Decision {
    this.roll(x.now);
    if (bad(o.qty) || bad(o.price)) return no('invalid qty or price');
    if (o.side === 'sell') return this.open.has(o.symbol) ? { approved: true, qty: o.qty } : no('no open position to sell (spot only, no shorting)'); // exits are never blocked by settings

    if (this.killed) return no('max drawdown kill switch active; manual reset required');
    if (this.dailyHalted) return no('daily loss limit hit; halted until next UTC day');
    if (o.stopLoss === undefined || bad(o.stopLoss) || o.stopLoss >= o.price) return no('valid stop-loss below entry is required');
    if (x.now - x.dataTime > this.c.STALE_DATA_SECONDS * 1000) return no('price data is stale');
    if (this.errors >= this.c.MAX_EXCHANGE_ERRORS) return no('too many consecutive exchange errors');
    if (this.tradesToday >= this.c.MAX_TRADES_PER_DAY) return no('max trades per day reached');
    if (this.open.has(o.symbol)) return no(`position already open in ${o.symbol}`);
    if (this.open.size >= this.c.MAX_OPEN_POSITIONS) return no('max open positions reached');

    const equity = this.c.BOT_CAPITAL_USDT + this.realized;
    const free = equity - [...this.open.values()].reduce((a, b) => a + b, 0);
    const byRisk = (equity * this.c.RISK_PER_TRADE_PCT / 100) / (o.price - o.stopLoss);
    const byCapital = free / (o.price * (1 + this.c.FEE_PCT / 100));
    const qty = floorToStep(Math.min(o.qty, byRisk, byCapital), x.market.qtyStep);
    if (qty < x.market.minQty) return no('size below exchange minimum quantity');
    if (qty * o.price < x.market.minNotional) return no('size below exchange minimum notional');
    return { approved: true, qty };
  }

  /** Call after a buy fill. */
  onOpen(symbol: string, costUsdt: number, now: number) { this.roll(now); this.open.set(symbol, costUsdt); this.tradesToday++; }

  /** Call after a position is fully closed; pnl is net of fees. */
  onClose(symbol: string, pnl: number, now: number) {
    this.roll(now);
    this.open.delete(symbol);
    this.realized += pnl;
    this.dailyPnl += pnl;
    this.checkDaily();
  }

  /** Part of a position was sold; the rest stays open at `remainingCost`. */
  onPartialClose(symbol: string, pnl: number, remainingCost: number, now: number) {
    this.roll(now);
    this.open.set(symbol, remainingCost);
    this.realized += pnl;
    this.dailyPnl += pnl;
    this.checkDaily();
  }

  private checkDaily() {
    if (this.dailyPnl <= -this.c.BOT_CAPITAL_USDT * this.c.DAILY_LOSS_LIMIT_PCT / 100) this.dailyHalted = true;
  }

  /** Bot equity (capital + realized + unrealized). Trips the drawdown kill switch. */
  updateEquity(equity: number) {
    this.peak = Math.max(this.peak, equity);
    if ((this.peak - equity) / this.peak * 100 >= this.c.MAX_DRAWDOWN_PCT) this.killed = true;
  }

  /** Persisted so a restart cannot be used to dodge the daily limit, trade cap or kill switch. */
  snapshot(): RiskSnapshot {
    return { day: this.day, dailyPnl: this.dailyPnl, tradesToday: this.tradesToday, dailyHalted: this.dailyHalted, killed: this.killed, peak: this.peak, realized: this.realized, open: [...this.open] };
  }
  restore(s: RiskSnapshot) {
    ({ day: this.day, dailyPnl: this.dailyPnl, tradesToday: this.tradesToday, dailyHalted: this.dailyHalted, killed: this.killed, peak: this.peak, realized: this.realized } = s);
    this.open = new Map(s.open);
  }

  recordExchangeError() { this.errors++; }
  recordExchangeSuccess() { this.errors = 0; }

  /** Manual restart after a kill switch: peak is re-based to current equity. */
  resetKill(equity: number) { this.killed = false; this.peak = equity; }

  status(now: number) {
    this.roll(now);
    return { killed: this.killed, dailyHalted: this.dailyHalted, dailyPnl: this.dailyPnl, tradesToday: this.tradesToday, openPositions: this.open.size, peak: this.peak, errors: this.errors };
  }
}
