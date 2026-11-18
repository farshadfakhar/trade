import { describe, expect, it } from 'vitest';
import { PaperAdapter } from '../exchange/PaperAdapter.js';
import { UnknownOutcomeError } from '../exchange/types.js';
import type { OrderInfo } from '../exchange/types.js';
import { RiskManager } from '../risk/RiskManager.js';
import type { Candle, Signal, Strategy } from '../strategy/types.js';
import { Executor } from './Executor.js';

const cfg = { BOT_CAPITAL_USDT: 1000, RISK_PER_TRADE_PCT: 1, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_DAY: 5, DAILY_LOSS_LIMIT_PCT: 3, MAX_DRAWDOWN_PCT: 10, STALE_DATA_SECONDS: 60, MAX_EXCHANGE_ERRORS: 3, FEE_PCT: 0 };
const H = 3600_000, T0 = Date.UTC(2026, 0, 1);
const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({ time: T0 + i * H, open: o, high: h, low: l, close: c, volume: 1 });
const buy: Signal = { action: 'buy', stop: 98, target: 104, reason: 't' };

function setup(opts: { reserve?: (id: string) => Promise<boolean> } = {}) {
  const adapter = new PaperAdapter({ feePct: 0, slippagePct: 0, startUsdt: 1000, market: { minQty: 0.001, minNotional: 1, qtyStep: 0.001 } });
  const stops = {
    placed: [] as unknown[][], cancelled: 0, failPlace: false, failCancel: false, n: 0,
    info: { state: 'open', filledQty: 0, avgPrice: 0 } as OrderInfo,
    async place(...a: unknown[]) { if (stops.failPlace) throw new Error('place failed'); stops.placed.push(a); stops.info = { state: 'open', filledQty: 0, avgPrice: 0 }; return `ref${++stops.n}`; },
    async status() { return stops.info; },
    async cancel() { if (stops.failCancel) throw new Error('cancel failed'); stops.cancelled++; stops.info = { state: 'canceled', filledQty: 0, avgPrice: 0 }; },
  };
  (adapter as any).stops = stops;
  const rm = new RiskManager(cfg);
  const events: [string, any][] = []; let persists = 0;
  const signals: Signal[] = [buy];
  const strategy: Strategy = { onCandle: () => signals.shift() ?? { action: 'hold', reason: '' } };
  const ex = new Executor({ adapter, rm, strategy, symbol: 'BTC/USDT', capital: 1000, riskPct: 1, feePct: 0, setPrice: (s, p, t) => adapter.setPrice(s, p, t), sink: (k, d) => events.push([k, d]), persist: () => persists++, ...opts });
  const step = async (c: Candle) => { adapter.setPrice('BTC/USDT', c.close, c.time + H); await ex.onCandle([c], c.time + H); };
  return { adapter, stops, rm, ex, events, step, signals, persists: () => persists };
}
const trade = (s: ReturnType<typeof setup>) => s.events.find((e) => e[0] === 'trade')?.[1];

describe('Executor with exchange-side stops', () => {
  it('places a stop right after the buy and does not sell on its own when the candle pierces it', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toMatchObject({ qty: 5, stopRef: 'ref1' });
    expect(s.stops.placed[0]).toEqual(['BTC/USDT', 5, 98, expect.stringMatching(/^BTCUSDT-x-/)]);
    await s.step(candle(1, 100, 101, 97, 99)); // low < stop, but the exchange owns that job
    expect(s.ex.position).not.toBeNull(); expect(trade(s)).toBeUndefined();
  });
  it('books the trade when the exchange stop fills', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.stops.info = { state: 'filled', filledQty: 5, avgPrice: 97.5 };
    await s.step(candle(1, 100, 101, 97, 99));
    expect(s.ex.position).toBeNull();
    expect(trade(s)).toMatchObject({ exit: 97.5, pnl: -12.5, reason: 'stop-loss (exchange)' });
    expect(s.rm.status(T0).openPositions).toBe(0);
  });
  it('on take-profit cancels the stop first, then sells', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    await s.step(candle(1, 100, 105, 99, 104));
    expect(s.stops.cancelled).toBe(1); expect(s.ex.position).toBeNull(); expect(trade(s)).toMatchObject({ reason: 'take-profit', pnl: 20 });
  });
  it('if cancel fails because the stop already filled, books the stop fill and never sells twice', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.stops.failCancel = true;
    let first = true; const real = s.stops.status.bind(s.stops);
    s.stops.status = async () => { if (first) { first = false; return { state: 'open', filledQty: 0, avgPrice: 0 } as OrderInfo; } return { state: 'filled', filledQty: 5, avgPrice: 98 } as OrderInfo; };
    await s.step(candle(1, 100, 105, 99, 104));
    expect(trade(s)).toMatchObject({ reason: 'stop-loss (exchange)', exit: 98 });
    expect(s.events.filter((e) => e[0] === 'order' && e[1].side === 'sell').length).toBe(0);
    void real;
  });
  it('if cancel fails and the stop is still open, keeps the position (no sell, retry later)', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.stops.failCancel = true;
    await s.step(candle(1, 100, 105, 99, 104));
    expect(s.ex.position?.stopRef).toBe('ref1'); expect(trade(s)).toBeUndefined();
  });
  it('closes immediately if the protective stop cannot be placed', async () => {
    const s = setup(); s.stops.failPlace = true;
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toBeNull();
    expect(s.events.some((e) => e[0] === 'error' && /protective stop/.test(e[1].message))).toBe(true);
    expect(trade(s)).toMatchObject({ reason: 'no stop protection' });
  });
  it('re-places a stop that was canceled outside the bot', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.stops.info = { state: 'canceled', filledQty: 0, avgPrice: 0 };
    await s.step(candle(1, 100, 101, 99, 100));
    expect(s.ex.position?.stopRef).toBe('ref2');
  });
  it('flags a lost stop that cannot be re-placed and exits', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.stops.info = { state: 'canceled', filledQty: 0, avgPrice: 0 }; s.stops.failPlace = true;
    await s.step(candle(1, 100, 101, 99, 100));
    expect(s.ex.problems.join()).toMatch(/stop lost/); expect(s.ex.position).toBeNull();
  });
  it('restores the stop when a sell fails after the old one was cancelled', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.adapter.marketOrder = async () => { throw new Error('sell down'); };
    await s.step(candle(1, 100, 105, 99, 104));
    expect(s.ex.position?.stopRef).toBe('ref2');
    s.stops.failPlace = true; s.ex.position!.stopRef = undefined;
    await s.step(candle(2, 100, 105, 99, 104));
    expect(s.ex.problems.join()).toMatch(/UNPROTECTED/);
  });
  it('write-ahead guard: a reused order id blocks the buy and raises a problem', async () => {
    const s = setup({ reserve: async () => false });
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toBeNull(); expect(s.ex.problems[0]).toMatch(/already attempted/);
    expect(s.events.some((e) => e[0] === 'order')).toBe(false);
    const ok = setup({ reserve: async () => true }); await ok.step(candle(0, 100, 100, 100, 100)); expect(ok.ex.position).not.toBeNull();
  });
  it('sizes the position by what the wallet really holds (fees taken in the base coin)', async () => {
    const s = setup();
    const real = s.adapter.getBalance.bind(s.adapter);
    s.adapter.getBalance = async (a) => (a === 'BTC' ? 4.995 : real(a));
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position!.qty).toBe(4.995); expect(s.stops.placed[0]![1]).toBe(4.995);
  });
  it('persists on every state change and round-trips state()', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.persists()).toBeGreaterThan(1);
    const other = setup(); other.ex.restore(JSON.parse(JSON.stringify(s.ex.state())));
    expect(other.ex.position).toMatchObject({ qty: 5, stopRef: 'ref1' });
  });
});

describe('reconcile after restart', () => {
  const resumed = async (mutate?: (s: ReturnType<typeof setup>) => void) => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    mutate?.(s);
    return s;
  };
  it('nothing to do without a position; healthy position is clean', async () => {
    expect(await setup().ex.reconcile(T0)).toEqual([]);
    const s = await resumed(); expect(await s.ex.reconcile(T0)).toEqual([]);
  });
  it('books a stop that fired while the bot was down', async () => {
    const s = await resumed((x) => { x.stops.info = { state: 'filled', filledQty: 5, avgPrice: 97 }; });
    expect(await s.ex.reconcile(T0)).toEqual([]); expect(s.ex.position).toBeNull(); expect(trade(s).exit).toBe(97);
  });
  it('flags an exchange balance lower than the tracked position', async () => {
    const s = await resumed((x) => { x.adapter.getBalance = async () => 1; });
    expect((await s.ex.reconcile(T0))[0]).toMatch(/below the tracked position/);
  });
  it('re-protects a position that has no stop, or flags it', async () => {
    const s = await resumed((x) => { x.ex.position!.stopRef = undefined; });
    expect(await s.ex.reconcile(T0)).toEqual([]); expect(s.ex.position?.stopRef).toBe('ref2');
    const f = await resumed((x) => { x.ex.position!.stopRef = undefined; x.stops.failPlace = true; });
    expect((await f.ex.reconcile(T0))[0]).toMatch(/no exchange stop/);
  });
  it('turns an exchange error into a problem instead of crashing', async () => {
    const s = await resumed((x) => { x.adapter.getBalance = async () => { throw new Error('offline'); }; });
    expect((await s.ex.reconcile(T0))[0]).toMatch(/reconcile failed: offline/);
  });
});

describe('review fixes', () => {
  it('close: if cancel fails because the stop is already canceled, it still SELLS (no re-protect, no stuck position)', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.stops.failCancel = true; s.stops.info = { state: 'canceled', filledQty: 0, avgPrice: 0 };
    await s.ex.closeNow(101, T0 + 2 * H, 'panic');
    expect(s.ex.position).toBeNull(); expect(s.stops.placed.length).toBe(1);
  });
  it('sells only the wallet quantity? No: refuses to sell less than the tracked position, flags it, and restores the stop', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.adapter.getBalance = async () => 2; // wallet holds 2 but 5 are tracked
    await s.ex.closeNow(101, T0 + 2 * H, 'manual');
    expect(s.ex.position).not.toBeNull(); expect(s.ex.problems.join()).toMatch(/less than the 5 to sell/);
    expect(s.stops.placed.length).toBe(2); // stop was restored after the failed attempt
  });
  it('partial sell books only its share of the cost, keeps the remainder open and re-protects it', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100)); // 5 units, cost 500
    const real = s.adapter.marketOrder.bind(s.adapter);
    s.adapter.marketOrder = async (r) => real({ ...r, qty: 2 }); // only 2 of 5 fill
    await s.ex.closeNow(110, T0 + 2 * H, 'manual');
    expect(s.ex.position).toMatchObject({ qty: 3, cost: 300, stopRef: 'ref2' });
    const t = trade(s); expect(t).toMatchObject({ qty: 2, pnl: 20, reason: 'manual (partial)' });
    expect(s.rm.status(T0).openPositions).toBe(1); expect(s.ex.realized).toBe(20);
  });
  it('an UNKNOWN buy outcome raises a problem (never silently retried)', async () => {
    const s = setup();
    s.adapter.marketOrder = async () => { throw new UnknownOutcomeError('timeout, lookup failed'); };
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.problems[0]).toMatch(/outcome unknown/);
  });
  it('an UNKNOWN stop outcome raises a problem', async () => {
    const s = setup();
    s.stops.place = async () => { throw new UnknownOutcomeError('lookup failed'); };
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.problems.join()).toMatch(/stop order outcome unknown/);
  });
  it('an UNKNOWN sell outcome raises a problem and does not touch the stop', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.adapter.marketOrder = async () => { throw new UnknownOutcomeError('x'); };
    await s.ex.closeNow(101, T0 + 2 * H, 'manual');
    expect(s.ex.problems.join()).toMatch(/sell .* outcome unknown/); expect(s.stops.placed.length).toBe(1);
  });
  it('a failing wallet lookup after a fill does not lose the position', async () => {
    const s = setup();
    const real = s.adapter.getBalance.bind(s.adapter);
    let calls = 0; s.adapter.getBalance = async (a) => { if (a === 'BTC' && calls++ === 0) throw new Error('timeout'); return real(a); };
    await s.step(candle(0, 100, 100, 100, 100));
    expect(s.ex.position).toMatchObject({ qty: 5 });
  });
  it('halted blocks entries; stale live price blocks entries', async () => {
    const h = setup(); h.ex.halted = true;
    await h.step(candle(0, 100, 100, 100, 100));
    expect(h.ex.position).toBeNull(); expect(h.events.find((e) => e[0] === 'risk')![1].reason).toMatch(/halted/);
    const p = setup();
    await p.ex.onCandle([candle(0, 100, 100, 100, 100)], T0 + H, T0 + H, 97.5);
    expect(p.ex.position).toBeNull(); expect(p.events.find((e) => e[0] === 'risk')![1].reason).toMatch(/stale/);
  });
  it('all state-changing calls are serialized: a manual close during a slow exit sells once', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    const real = s.adapter.marketOrder.bind(s.adapter);
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    let sells = 0;
    s.adapter.marketOrder = async (r) => { if (r.side === 'sell') { sells++; await gate; } return real(r); };
    const a = s.ex.closeNow(101, T0 + 2 * H, 'a');
    const b = s.ex.closeNow(101, T0 + 2 * H + 1, 'b');
    release(); await Promise.all([a, b]);
    expect(sells).toBe(1); expect(s.ex.position).toBeNull();
  });
  it('reconcile compares TOTAL balance (coins locked in our own stop still count)', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.adapter.getBalance = async () => 0; (s.adapter as any).getTotalBalance = async () => 5; // all locked in the stop
    expect(await s.ex.reconcile(T0)).toEqual([]);
  });
  it('ensureProtected re-places a stop that vanished', async () => {
    const s = setup();
    await s.step(candle(0, 100, 100, 100, 100));
    s.stops.info = { state: 'canceled', filledQty: 0, avgPrice: 0 };
    await s.ex.ensureProtected(T0 + 2 * H);
    expect(s.ex.position?.stopRef).toBe('ref2');
  });
});
