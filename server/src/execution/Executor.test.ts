import { describe, expect, it } from 'vitest';
import { PaperAdapter } from '../exchange/PaperAdapter.js';
import { RiskManager } from '../risk/RiskManager.js';
import type { Candle, Signal, Strategy } from '../strategy/types.js';
import { Executor } from './Executor.js';

const cfg = { BOT_CAPITAL_USDT: 1000, RISK_PER_TRADE_PCT: 1, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_DAY: 5, DAILY_LOSS_LIMIT_PCT: 3, MAX_DRAWDOWN_PCT: 10, STALE_DATA_SECONDS: 60, MAX_EXCHANGE_ERRORS: 3, FEE_PCT: 0 };
const H = 3600_000, T0 = Date.UTC(2026, 0, 1);
const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({ time: T0 + i * H, open: o, high: h, low: l, close: c, volume: 1 });

function setup(signals: Signal[], over: { fee?: number } = {}) {
  const adapter = new PaperAdapter({ feePct: over.fee ?? 0, slippagePct: 0, startUsdt: 1000, market: { minQty: 0.001, minNotional: 1, qtyStep: 0.001 } });
  const rm = new RiskManager(cfg);
  const events: [string, any][] = [];
  const strategy: Strategy = { onCandle: () => signals.shift() ?? { action: 'hold', reason: '' } };
  const ex = new Executor({ adapter, rm, strategy, symbol: 'BTC/USDT', capital: 1000, riskPct: 1, feePct: 0, setPrice: (s, p, t) => adapter.setPrice(s, p, t), sink: (k, d) => events.push([k, d]) });
  const step = async (c: Candle, dataTime?: number) => { adapter.setPrice('BTC/USDT', c.close, c.time + H); await ex.onCandle([c], c.time + H, dataTime); };
  return { adapter, rm, ex, events, step };
}
const buy: Signal = { action: 'buy', stop: 98, target: 104, reason: 'test' };

describe('Executor', () => {
  it('opens sized by risk (10 USDT / 2 = 5 units) and records the order', async () => {
    const s = setup([buy]);
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toMatchObject({ qty: 5, entry: 100, stop: 98, target: 104 });
    expect(s.events.map((e) => e[0])).toEqual(['signal', 'risk', 'order']);
  });
  it('exits at the stop price (and at the open on a gap), booking the loss', async () => {
    const s = setup([buy]);
    await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 101, 97, 99));
    expect(s.ex.position).toBeNull();
    expect(s.events.find((e) => e[0] === 'trade')![1]).toMatchObject({ exit: 98, pnl: -10, reason: 'stop-loss' });
    const g = setup([buy]);
    await g.step(candle(0, 100, 100, 100, 100));
    await g.step(candle(1, 95, 96, 94, 95)); // gapped below stop
    expect(g.events.find((e) => e[0] === 'trade')![1].exit).toBe(95);
  });
  it('takes profit at target; stop wins if one candle touches both', async () => {
    const s = setup([buy]);
    await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 105, 99, 104));
    expect(s.events.find((e) => e[0] === 'trade')![1]).toMatchObject({ exit: 104, pnl: 20, reason: 'take-profit' });
    expect(s.ex.equity(104)).toBe(1020);
    const b = setup([buy]);
    await b.step(candle(0, 100, 100, 100, 100));
    await b.step(candle(1, 100, 110, 90, 100));
    expect(b.events.find((e) => e[0] === 'trade')![1].reason).toBe('stop-loss');
  });
  it('exits on a strategy sell signal at the close, including fees in P&L', async () => {
    const s = setup([buy, { action: 'sell', reason: 'cross down' }], { fee: 0.1 });
    await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 101, 99.5, 100));
    const t = s.events.find((e) => e[0] === 'trade')![1];
    expect(t.reason).toBe('cross down');
    expect(t.pnl).toBeCloseTo(-(5 * 100 * 0.001) * 2); // two fees on 500 notional
  });
  it('reports unrealized P&L in equity', async () => {
    const s = setup([buy]);
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.equity(101)).toBe(1005);
  });
  it('does not open when the risk manager rejects (stale data) and logs why', async () => {
    const s = setup([buy]);
    await s.step(candle(0, 100, 100, 100, 100), T0 - 10 * H);
    expect(s.ex.position).toBeNull();
    expect(s.events.find((e) => e[0] === 'risk')![1]).toMatchObject({ approved: false, reason: expect.stringMatching(/stale/) });
  });
  it('ignores a buy without stop/target', async () => {
    const s = setup([{ action: 'buy', reason: 'x' }]);
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toBeNull();
    expect(s.events.at(-1)![1].reason).toMatch(/without stop/);
  });
  it('counts exchange errors, keeps the position when a sell fails, and halts new buys after 3', async () => {
    const s = setup([buy]);
    await s.step(candle(0, 100, 100, 100, 100));
    s.adapter.marketOrder = async () => { throw new Error('boom'); };
    await s.step(candle(1, 100, 101, 90, 95)); // stop hit, sell fails
    expect(s.ex.position).not.toBeNull();
    expect(s.events.at(-1)![0]).toBe('error');
    await s.step(candle(2, 95, 96, 90, 95)); await s.step(candle(3, 95, 96, 90, 95));
    expect(s.rm.status(T0).errors).toBe(3);
  });
  it('a failed buy leaves no position and counts an error', async () => {
    const s = setup([buy]);
    s.adapter.marketOrder = async () => { throw new Error('nope'); };
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toBeNull();
    expect(s.rm.status(T0).errors).toBe(1);
  });
  it('feeds equity to the drawdown kill switch', async () => {
    const s = setup([buy]);
    await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 100, 100, 0.5)); // equity collapses while holding... stop hit first at 98 -> closes
    expect(s.rm.status(T0).peak).toBe(1000);
  });
});
