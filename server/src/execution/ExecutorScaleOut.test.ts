import { describe, expect, it } from 'vitest';
import { PaperAdapter } from '../exchange/PaperAdapter.js';
import type { OrderInfo } from '../exchange/types.js';
import { RiskManager } from '../risk/RiskManager.js';
import type { Candle, Signal, Strategy, StrategyCtx } from '../strategy/types.js';
import { Executor } from './Executor.js';

const cfg = { BOT_CAPITAL_USDT: 1000, RISK_PER_TRADE_PCT: 1, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_DAY: 9, DAILY_LOSS_LIMIT_PCT: 30, MAX_DRAWDOWN_PCT: 90, STALE_DATA_SECONDS: 60, MAX_EXCHANGE_ERRORS: 3, FEE_PCT: 0 };
const M = 900_000, T0 = Date.UTC(2026, 0, 1);
const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({ time: T0 + i * M, open: o, high: h, low: l, close: c, volume: 1 });
const scaleOut: Signal = { action: 'buy', stop: 98, target: 103, partial: { fraction: 0.5 }, reason: 't' };

function setup(withStops = false, minNotional = 1) {
  const adapter = new PaperAdapter({ feePct: 0, slippagePct: 0, startUsdt: 1000, market: { minQty: 0.001, minNotional, qtyStep: 0.001 } });
  const stops = {
    placed: [] as any[][], cancelled: 0, n: 0, failCancel: false, failPlace: false,
    info: { state: 'open', filledQty: 0, avgPrice: 0 } as OrderInfo,
    async place(...a: any[]) { if (stops.failPlace) throw new Error('place failed'); stops.placed.push(a); return `ref${++stops.n}`; },
    async status() { return stops.info; },
    async cancel() { if (stops.failCancel) throw new Error('cancel failed'); stops.cancelled++; },
  };
  if (withStops) (adapter as any).stops = stops;
  const rm = new RiskManager(cfg);
  const events: [string, any][] = [];
  const signals: Signal[] = [scaleOut];
  const seen: StrategyCtx[] = [];
  const strategy: Strategy = { onCandle: (_c, _p, ctx) => (seen.push(ctx ?? {}), signals.shift() ?? { action: 'hold', reason: '' }) };
  const ex = new Executor({ adapter, rm, strategy, symbol: 'BTC/USDT', capital: 1000, riskPct: 1, feePct: 0, setPrice: (s, p, t) => adapter.setPrice(s, p, t), sink: (k, d) => events.push([k, d]) });
  const step = async (c: Candle, htf?: Candle[]) => { adapter.setPrice('BTC/USDT', c.close, c.time + M); await ex.onCandle([c], c.time + M, undefined, undefined, htf); };
  return { adapter, stops, rm, ex, events, step, signals, seen };
}
const trades = (s: ReturnType<typeof setup>) => s.events.filter((e) => e[0] === 'trade').map((e) => e[1]);

describe('scale-out strategies (first target, breakeven, trail)', () => {
  it('records entry time and scale-out settings on the position', async () => {
    const s = setup(); await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toMatchObject({ qty: 5, entryTime: T0 + M, partial: { fraction: 0.5 }, partialDone: false, target: 103 });
  });
  it('first target: sells half, books its share, moves the stop to breakeven, keeps the rest open', async () => {
    const s = setup(); await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 103.5, 99, 103));
    expect(s.ex.position).toMatchObject({ qty: 2.5, cost: 250, stop: 100, partialDone: true });
    expect(trades(s)[0]).toMatchObject({ qty: 2.5, exit: 103, pnl: 7.5, reason: 'take-profit (first target) (partial)' });
    expect(s.rm.status(T0).openPositions).toBe(1);
    await s.step(candle(2, 103, 110, 102, 109)); // no second full take-profit: the rest only trails or stops
    expect(s.ex.position).not.toBeNull();
  });
  it('after the partial, the breakeven stop exits the rest at ~entry (a loss-free exit)', async () => {
    const s = setup(); await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 103.5, 99, 103));
    await s.step(candle(2, 103, 104, 99.5, 100.5)); // falls through breakeven 100
    expect(s.ex.position).toBeNull();
    expect(trades(s)[1]).toMatchObject({ exit: 100, pnl: 0, reason: 'stop-loss' });
  });
  it('a slice below the exchange minimum is not sold; the stop still moves to breakeven', async () => {
    const s = setup(false, 400); await s.step(candle(0, 100, 100, 100, 100)); // 2.5 units * 103 = 257 < 400
    await s.step(candle(1, 100, 103.5, 99, 103));
    expect(s.ex.position).toMatchObject({ qty: 5, stop: 100, partialDone: true });
    expect(trades(s)).toHaveLength(0); expect(s.events.some((e) => e[0] === 'error' && /below the exchange minimum/.test(e[1].message))).toBe(true);
  });
  it('trailing: a strategy newStop raises the stop, never lowers it', async () => {
    const s = setup(); await s.step(candle(0, 100, 100, 100, 100));
    s.signals.push({ action: 'hold', reason: 'trail', newStop: 101 }); await s.step(candle(1, 100, 102, 100, 101.5));
    expect(s.ex.position!.stop).toBe(101);
    s.signals.push({ action: 'hold', reason: 'trail', newStop: 99 }); await s.step(candle(2, 101, 102, 101.2, 101.5));
    expect(s.ex.position!.stop).toBe(101);
  });
  it('a losing full exit sets lastLossAt (cooldown) which is handed to the strategy; wins do not', async () => {
    const s = setup(); await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 101, 97, 98)); // stop-loss
    expect(s.ex.lastLossAt).toBe(T0 + 2 * M);
    await s.step(candle(2, 98, 98, 98, 98));
    expect(s.seen.at(-1)!.lastLossAt).toBe(T0 + 2 * M);
    const w = setup(); await w.step(candle(0, 100, 100, 100, 100));
    w.signals.push({ action: 'sell', reason: 'win' }); w.adapter.setPrice('BTC/USDT', 110, T0 + 2 * M);
    await w.ex.onCandle([candle(1, 110, 110, 110, 110)], T0 + 2 * M); expect(w.ex.lastLossAt).toBeUndefined();
  });
  it('passes the higher-timeframe candles to the strategy and persists lastLossAt in state()', async () => {
    const s = setup(); const htf = [candle(0, 1, 1, 1, 1)];
    await s.step(candle(0, 100, 100, 100, 100), htf);
    expect(s.seen[0]!.htf).toBe(htf);
    s.ex.lastLossAt = 123; const o = setup(); o.ex.restore(JSON.parse(JSON.stringify(s.ex.state()))); expect(o.ex.lastLossAt).toBe(123);
  });
});

describe('scale-out with exchange-side stops', () => {
  it('first target: cancels the stop, sells half, re-places the stop at breakeven for the remainder', async () => {
    const s = setup(true); await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 103.5, 99, 103));
    expect(s.stops.cancelled).toBe(1);
    expect(s.ex.position).toMatchObject({ qty: 2.5, stop: 100, stopRef: 'ref2' });
    expect(s.stops.placed[1]).toEqual(['BTC/USDT', 2.5, 100, expect.any(String)]);
  });
  it('trailing on the exchange: cancel + re-place at the higher stop; on failure it restores the old stop', async () => {
    const s = setup(true); await s.step(candle(0, 100, 100, 100, 100));
    s.signals.push({ action: 'hold', reason: 'trail', newStop: 101 }); await s.step(candle(1, 100, 102, 100, 101.5));
    expect(s.ex.position).toMatchObject({ stop: 101, stopRef: 'ref2' });
    // new placement fails once -> old stop restored
    let calls = 0; const real = s.stops.place.bind(s.stops);
    s.stops.place = async (...a: any[]) => { if (calls++ === 0) throw new Error('rejected'); return real(...a); };
    s.signals.push({ action: 'hold', reason: 'trail', newStop: 102 }); await s.step(candle(2, 101, 102.8, 101, 102.5));
    expect(s.ex.position).toMatchObject({ stop: 101, stopRef: expect.stringMatching(/^ref/) }); expect(s.ex.problems).toEqual([]);
    // both fail -> flagged UNPROTECTED
    s.stops.failPlace = true; s.stops.place = real;
    s.signals.push({ action: 'hold', reason: 'trail', newStop: 102 }); await s.step(candle(3, 101, 102.8, 101, 102.5));
    expect(s.ex.problems.join()).toMatch(/UNPROTECTED/);
  });
  it('a failed cancel while trailing keeps the old stop untouched', async () => {
    const s = setup(true); await s.step(candle(0, 100, 100, 100, 100));
    s.stops.failCancel = true; s.signals.push({ action: 'hold', reason: 'trail', newStop: 101 }); await s.step(candle(1, 100, 102, 100, 101.5));
    expect(s.ex.position).toMatchObject({ stop: 98, stopRef: 'ref1' });
  });
});
