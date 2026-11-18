import { describe, expect, it } from 'vitest';
import { RiskManager, type RiskConfig, type Ctx, type OrderIntent } from './RiskManager.js';

const cfg: RiskConfig = {
  BOT_CAPITAL_USDT: 1000, RISK_PER_TRADE_PCT: 1, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_DAY: 2,
  DAILY_LOSS_LIMIT_PCT: 3, MAX_DRAWDOWN_PCT: 10,
  STALE_DATA_SECONDS: 60, MAX_EXCHANGE_ERRORS: 3, FEE_PCT: 0.1,
};
const T0 = Date.UTC(2026, 0, 1, 12);
const ctx = (o: Partial<Ctx> = {}): Ctx => ({ now: T0, dataTime: T0, market: { minQty: 0.0001, minNotional: 5, qtyStep: 0.0001 }, ...o });
const buy = (o: Partial<OrderIntent> = {}): OrderIntent => ({ symbol: 'BTC/USDT', side: 'buy', qty: 1, price: 100, stopLoss: 98, ...o });
const mk = (o: Partial<RiskConfig> = {}) => new RiskManager({ ...cfg, ...o });
const reason = (d: ReturnType<RiskManager['evaluate']>) => (d.approved ? '' : d.reason);

describe('RiskManager buys', () => {
  it('approves and sizes by 1% risk (10 USDT / 2 stop distance = 5 units)', () => {
    expect(mk().evaluate(buy({ qty: 50 }), ctx())).toEqual({ approved: true, qty: 5 });
  });
  it('never grows a smaller request', () => {
    expect(mk().evaluate(buy({ qty: 2 }), ctx())).toEqual({ approved: true, qty: 2 });
  });
  it('caps by available capital (incl. fee)', () => {
    const d = mk({ RISK_PER_TRADE_PCT: 5 }).evaluate(buy({ qty: 1000, stopLoss: 50 }), ctx()); // risk allows 1 unit
    expect(d).toEqual({ approved: true, qty: 1 });
    const d2 = mk({ BOT_CAPITAL_USDT: 100, RISK_PER_TRADE_PCT: 5 }).evaluate(buy({ qty: 1000, stopLoss: 99.9 }), ctx());
    expect(d2.approved && d2.qty).toBeCloseTo(0.9990, 4); // 100 / (100*1.001)
  });
  it.each([[0, 100], [-1, 100], [NaN, 100], [1, 0], [1, Infinity]])('rejects invalid qty/price %s %s', (qty, price) =>
    expect(reason(mk().evaluate(buy({ qty, price }), ctx()))).toMatch(/invalid/));
  it.each([[undefined], [0], [NaN], [100], [101]])('rejects missing/invalid stop %s', (stopLoss) =>
    expect(reason(mk().evaluate(buy({ stopLoss }), ctx()))).toMatch(/stop-loss/));
  it('rejects stale data, allows exactly at the limit', () => {
    expect(reason(mk().evaluate(buy(), ctx({ dataTime: T0 - 60_001 })))).toMatch(/stale/);
    expect(mk().evaluate(buy(), ctx({ dataTime: T0 - 60_000 })).approved).toBe(true);
  });
  it('rejects after 3 consecutive exchange errors; success resets', () => {
    const r = mk();
    r.recordExchangeError(); r.recordExchangeError();
    expect(r.evaluate(buy(), ctx()).approved).toBe(true);
    r.recordExchangeError();
    expect(reason(r.evaluate(buy(), ctx()))).toMatch(/exchange errors/);
    r.recordExchangeSuccess();
    expect(r.evaluate(buy(), ctx()).approved).toBe(true);
  });
  it('enforces max trades per day and resets next UTC day', () => {
    const r = mk({ MAX_OPEN_POSITIONS: 5 });
    r.onOpen('BTC/USDT', 10, T0); r.onClose('BTC/USDT', 1, T0);
    r.onOpen('BTC/USDT', 10, T0); r.onClose('BTC/USDT', 1, T0);
    expect(reason(r.evaluate(buy(), ctx()))).toMatch(/trades per day/);
    const tomorrow = T0 + 24 * 3600_000;
    expect(r.evaluate(buy(), ctx({ now: tomorrow, dataTime: tomorrow })).approved).toBe(true);
  });
  it('rejects a second position in the same symbol and beyond max open positions', () => {
    const r = mk({ MAX_OPEN_POSITIONS: 2 });
    r.onOpen('BTC/USDT', 100, T0);
    expect(reason(r.evaluate(buy(), ctx()))).toMatch(/already open/);
    r.onOpen('ETH/USDT', 100, T0);
    r.onClose('ETH/USDT', 0, T0); r.onOpen('ETH/USDT', 100, T0); // keep 2 open
    const r2 = mk({ MAX_OPEN_POSITIONS: 1 });
    r2.onOpen('BTC/USDT', 100, T0);
    expect(reason(r2.evaluate(buy({ symbol: 'ETH/USDT' }), ctx()))).toMatch(/max open positions/);
  });
  it('subtracts deployed capital from free funds', () => {
    const r = mk({ BOT_CAPITAL_USDT: 100, RISK_PER_TRADE_PCT: 5, MAX_OPEN_POSITIONS: 2 });
    r.onOpen('ETH/USDT', 99, T0);
    expect(reason(r.evaluate(buy({ stopLoss: 99.9 }), ctx()))).toMatch(/minimum/); // ~1 USDT free < min notional
  });
  it('rejects below min qty and below min notional', () => {
    const m = { minQty: 10, minNotional: 5, qtyStep: 1 };
    expect(reason(mk().evaluate(buy(), ctx({ market: m })))).toMatch(/quantity/);
    const n = { minQty: 0.0001, minNotional: 600, qtyStep: 0.0001 };
    expect(reason(mk().evaluate(buy(), ctx({ market: n })))).toMatch(/notional/);
  });
  it('rounds qty down to the exchange step', () => {
    const d = mk().evaluate(buy({ qty: 3.14159 }), ctx({ market: { minQty: 0.1, minNotional: 5, qtyStep: 0.1 } }));
    expect(d).toEqual({ approved: true, qty: 3.1 });
  });
});

describe('daily loss limit', () => {
  it('halts at -3% of capital, still allows sells, resets next UTC day', () => {
    const r = mk();
    r.onOpen('BTC/USDT', 100, T0);
    r.onClose('BTC/USDT', -29.99, T0);
    expect(r.evaluate(buy(), ctx()).approved).toBe(true);
    r.onOpen('BTC/USDT', 100, T0); r.onClose('BTC/USDT', -0.01, T0);
    expect(reason(r.evaluate(buy(), ctx()))).toMatch(/daily loss/);
    const t = T0 + 24 * 3600_000;
    expect(r.evaluate(buy(), ctx({ now: t, dataTime: t })).approved).toBe(true);
  });
  it('wins offset losses within the day', () => {
    const r = mk({ MAX_TRADES_PER_DAY: 10 });
    r.onOpen('BTC/USDT', 1, T0); r.onClose('BTC/USDT', -20, T0);
    r.onOpen('BTC/USDT', 1, T0); r.onClose('BTC/USDT', 15, T0);
    expect(r.evaluate(buy(), ctx()).approved).toBe(true);
  });
});

describe('drawdown kill switch', () => {
  it('trips at 10% from peak, survives day rollover, needs manual reset', () => {
    const r = mk();
    r.updateEquity(1100);
    r.updateEquity(991); // 9.9%
    expect(r.status(T0).killed).toBe(false);
    r.updateEquity(990); // 10%
    expect(reason(r.evaluate(buy(), ctx()))).toMatch(/kill switch/);
    const t = T0 + 48 * 3600_000;
    expect(reason(r.evaluate(buy(), ctx({ now: t, dataTime: t })))).toMatch(/kill switch/);
    r.resetKill(990);
    expect(r.evaluate(buy(), ctx()).approved).toBe(true);
    expect(r.status(T0).peak).toBe(990);
  });
});

describe('sells', () => {
  it('allowed with an open position even when killed/halted/stale', () => {
    const r = mk();
    r.onOpen('BTC/USDT', 100, T0);
    r.updateEquity(1); // kill
    expect(r.evaluate({ symbol: 'BTC/USDT', side: 'sell', qty: 1, price: 90 }, ctx({ dataTime: 0 }))).toEqual({ approved: true, qty: 1 });
  });
  it('rejected without a position (no shorting)', () => {
    expect(reason(mk().evaluate({ symbol: 'BTC/USDT', side: 'sell', qty: 1, price: 90 }, ctx()))).toMatch(/shorting/);
  });
});

it('status reports counters', () => {
  const r = mk();
  r.onOpen('BTC/USDT', 10, T0);
  expect(r.status(T0)).toMatchObject({ openPositions: 1, tradesToday: 1, errors: 0, dailyPnl: 0 });
});

describe('snapshot / restore', () => {
  it('a restart keeps the daily halt, trade count, kill switch, peak and open positions', () => {
    const a = mk();
    a.onOpen('BTC/USDT', 100, T0); a.onClose('BTC/USDT', -31, T0); // daily halt
    a.onOpen('ETH/USDT', 50, T0);
    a.updateEquity(1200); a.updateEquity(1000); // kill
    const b = mk(); b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.status(T0)).toMatchObject({ killed: true, dailyHalted: true, tradesToday: 2, openPositions: 1, peak: 1200 });
    expect(reason(b.evaluate(buy(), ctx()))).toMatch(/kill switch/);
    b.resetKill(1000); expect(reason(b.evaluate(buy(), ctx()))).toMatch(/daily loss/);
    const t = T0 + 24 * 3600_000; // next UTC day clears the daily state, not the open position
    expect(b.status(t)).toMatchObject({ dailyHalted: false, tradesToday: 0, openPositions: 1 });
  });
});

describe('partial closes', () => {
  it('partial close keeps the position open, books P&L and can trip the daily limit', () => {
    const r = mk();
    r.onOpen('BTC/USDT', 100, T0);
    r.onPartialClose('BTC/USDT', -10, 50, T0);
    expect(r.status(T0)).toMatchObject({ openPositions: 1, dailyPnl: -10, dailyHalted: false });
    expect(r.evaluate({ symbol: 'BTC/USDT', side: 'sell', qty: 1, price: 90 }, ctx()).approved).toBe(true);
    r.onPartialClose('BTC/USDT', -25, 25, T0);
    expect(r.status(T0).dailyHalted).toBe(true);
  });
});
