import { describe, expect, it } from 'vitest';
import { PaperAdapter } from '../exchange/PaperAdapter.js';
import { RiskManager } from '../risk/RiskManager.js';
import type { Candle, Strategy } from '../strategy/types.js';
import { Bot } from './Bot.js';
import { Executor } from './Executor.js';

const cfg = { BOT_CAPITAL_USDT: 1000, RISK_PER_TRADE_PCT: 1, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_DAY: 5, DAILY_LOSS_LIMIT_PCT: 3, MAX_DRAWDOWN_PCT: 10, STALE_DATA_SECONDS: 60, MAX_EXCHANGE_ERRORS: 3, FEE_PCT: 0 };
const H = 3600_000, T0 = Date.UTC(2026, 0, 1);
const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ time: T0 + i * H, open: o, high: h, low: l, close: cl, volume: 1 });

function mk(mode: 'paper' | 'live' = 'paper') {
  const adapter = new PaperAdapter({ feePct: 0, slippagePct: 0, startUsdt: 1000, market: { minQty: 0.001, minNotional: 1, qtyStep: 0.001 } });
  const rm = new RiskManager(cfg);
  let signals: ('buy' | 'hold')[] = ['buy'];
  const strategy: Strategy = { onCandle: () => (signals.shift() ?? 'hold') === 'buy' ? { action: 'buy', stop: 98, target: 110, reason: 't' } : { action: 'hold', reason: '' } };
  const executor = new Executor({ adapter, rm, strategy, symbol: 'BTC/USDT', capital: 1000, riskPct: 1, feePct: 0, setPrice: (s, p, t) => adapter.setPrice(s, p, t) });
  const feed = { candles: [c(0, 100, 100, 100, 100), c(1, 100, 101, 99, 100)] as Candle[], fail: false, calls: 0 };
  let now = T0 + 1 * H + 5000; // candle 1 is still forming
  const bot = new Bot({ mode, symbol: 'BTC/USDT', resolution: '60', tfMs: H, adapter, rm, executor, setPrice: (s, p, t) => adapter.setPrice(s, p, t), now: () => now, pollMs: 1e9,
    fetchRecent: async () => { feed.calls++; if (feed.fail) throw new Error('down'); return feed.candles; } });
  return { bot, rm, executor, adapter, feed, advance: (ms: number) => (now += ms) };
}

const settle = () => new Promise((r) => setImmediate(r)); // start() fires a background tick

describe('Bot', () => {
  it('trades only on a newly CLOSED candle, once', async () => {
    const { bot, executor } = mk();
    bot.start(); await settle();
    expect(executor.position).toMatchObject({ entry: 100, qty: 5 }); // candle 0 closed, candle 1 forming
    await bot.tick(); expect(executor.position?.qty).toBe(5); // same candle: no repeat
    bot.stop();
  });
  it('checks stop/target against the forming candle', async () => {
    const { bot, executor, feed } = mk();
    bot.start(); await settle();
    feed.candles = [feed.candles[0]!, c(1, 100, 101, 97, 99)]; // forming candle pierces the stop
    await bot.tick();
    expect(executor.position).toBeNull();
    bot.stop();
  });
  it('feed failures stop the bot after 3 in a row; a good fetch resets the streak', async () => {
    const { bot, rm, feed } = mk();
    feed.fail = true;
    bot.start(); await settle(); await bot.tick();
    expect(bot.running).toBe(true);
    feed.fail = false; await bot.tick(); feed.fail = true; await bot.tick(); await bot.tick();
    expect(bot.running).toBe(true); // streak was reset by the good fetch
    await bot.tick();
    expect(bot.running).toBe(false); expect(bot.status().lastError).toMatch(/price feed failed 3 times/);
    expect(rm.status(T0).errors).toBe(0); // feed trouble is not an order error
  });
  it('order errors are NOT reset by successful fetches and halt the bot', async () => {
    const { bot, rm } = mk();
    bot.start(); await settle();
    rm.recordExchangeError(); rm.recordExchangeError(); rm.recordExchangeError();
    await bot.tick(); // fetch succeeds, but the error streak stays
    expect(bot.running).toBe(false); expect(bot.status().lastError).toMatch(/exchange errors/);
    bot.start(); expect(bot.running).toBe(true); expect(rm.status(T0).errors).toBe(0); // manual Start clears it
    bot.stop();
  });
  it('rejects a buy on an old signal (candle closed minutes ago) after Start or an outage', async () => {
    const { bot, executor, advance } = mk();
    advance(5 * 60_000);
    const ev: any[] = []; (bot as any).d.executor.o.sink = (k: string, d: any) => ev.push([k, d]);
    bot.start(); await settle();
    expect(executor.position).toBeNull();
    expect(ev.find((e) => e[0] === 'risk')[1].reason).toMatch(/stale/);
  });
  it('rejects a buy when the live price is already through the stop', async () => {
    const { bot, executor, feed } = mk();
    feed.candles = [feed.candles[0]!, c(1, 100, 100, 96, 97)]; // live 97 <= stop 98
    bot.start(); await settle();
    expect(executor.position).toBeNull();
  });
  it('stop() blocks entries even for a tick that is already mid-flight', async () => {
    const { bot, executor, feed } = mk();
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const orig = feed.candles; (bot as any).d.fetchRecent = async () => { await gate; return orig; };
    bot.start(); bot.stop(); release(); await settle();
    expect(executor.position).toBeNull();
  });
  it('panic revokes the LIVE confirmation', async () => {
    const live = mk('live'); live.bot.liveConfirmed = true;
    await live.bot.panic(false);
    expect(live.bot.liveConfirmed).toBe(false);
  });
  it('live mode refuses to start until confirmed; kill switch blocks start', () => {
    const live = mk('live');
    expect(() => live.bot.start()).toThrow(/confirmation/);
    live.bot.liveConfirmed = true;
    live.rm.updateEquity(1); // kill
    expect(() => live.bot.start()).toThrow(/kill switch/);
  });
  it('panic stops the bot, cancels orders and market-closes', async () => {
    const { bot, executor, adapter } = mk();
    let cancelled = 0; adapter.cancelAllOrders = async () => { cancelled++; };
    const events: any[] = []; bot.on('event', (e) => events.push(e));
    bot.start(); await settle();
    const r = await bot.panic(true);
    expect(bot.running).toBe(false); expect(cancelled).toBe(1); expect(executor.position).toBeNull(); expect(r.errors).toEqual([]);
    expect(events.some((e) => e.type === 'panic')).toBe(true);
  });
  it('panic without market-close keeps the position; reports failures', async () => {
    const { bot, executor, adapter } = mk();
    bot.start(); await settle();
    adapter.cancelAllOrders = async () => { throw new Error('x'); };
    const r = await bot.panic(false);
    expect(executor.position).not.toBeNull(); expect(r.errors[0]).toMatch(/cancel: x/);
    const m = await bot.panic(true); // cancel still failing; close succeeds
    expect(executor.position).toBeNull(); expect(m.errors.length).toBe(1);
    const z = mk(); z.feed.fail = true; z.bot.start(); await settle();
    z.executor.position = { symbol: 'BTC/USDT', qty: 1, entry: 1, stop: 0.5, target: 2, cost: 1 };
    expect((await z.bot.panic(true)).errors.some((e) => /close: down/.test(e))).toBe(true);
  });
  it('closeNow closes the position at the current price', async () => {
    const { bot, executor } = mk();
    bot.start(); await settle(); await bot.closeNow();
    expect(executor.position).toBeNull(); bot.stop(); bot.stop();
  });
  it('feeds the strategy only CLOSED higher-timeframe candles and reports each new closed candle once', async () => {
    const { bot, executor, feed } = mk();
    const ctxs: any[] = []; executor.o.strategy = { onCandle: (_c, _p, ctx) => (ctxs.push(ctx), { action: 'hold', reason: '' }) };
    // 1h candles every hour; now = T0 + 1h + 5s, so the 1h candle opened at T0 has closed but the one at T0+1h has not
    const htfAll = [c(0, 1, 1, 1, 1), c(1, 1, 1, 1, 1)];
    const closedSeen: number[][] = [];
    (bot as any).d.htf = { resolution: '60', fetch: async () => htfAll };
    (bot as any).d.onClosed = (cs: Candle[]) => closedSeen.push(cs.map((x) => x.time));
    bot.start(); await settle(); await bot.tick();
    expect(ctxs[0].htf.map((x: Candle) => x.time)).toEqual([T0]); // not T0 + 1h
    expect(closedSeen).toHaveLength(1); // second tick: same candle, no repeat
    void feed;
  });
});

describe('Bot symbol switching (coin scanner)', () => {
  it('switches immediately when stopped and flat; updates the executor', () => {
    const { bot, executor, rm } = mk();
    bot.requestSymbol('ETH/USDT');
    expect(bot.symbol).toBe('ETH/USDT'); expect(executor.o.symbol).toBe('ETH/USDT');
    expect(bot.pendingSymbol).toBeUndefined();
  });
  it('waits for the exit while a position is open, then switches on the next tick', async () => {
    const { bot, executor } = mk();
    executor.position = { symbol: 'BTC/USDT', qty: 1, entry: 1, stop: 0.5, target: 2, cost: 1 };
    bot.requestSymbol('ETH/USDT');
    expect(bot.symbol).toBe('BTC/USDT'); expect(bot.pendingSymbol).toBe('ETH/USDT');
    executor.position = null; bot.start(); await settle();
    expect(bot.symbol).toBe('ETH/USDT'); bot.stop();
  });
  it('requesting the current coin cancels a pending switch', () => {
    const { bot, executor } = mk();
    executor.position = { symbol: 'BTC/USDT', qty: 1, entry: 1, stop: 0.5, target: 2, cost: 1 };
    bot.requestSymbol('ETH/USDT'); bot.requestSymbol('BTC/USDT');
    expect(bot.pendingSymbol).toBeUndefined();
  });
});

describe('Executor entry block', () => {
  it('blocks new entries with the given reason but never exits', async () => {
    const { bot, executor } = mk();
    const ev: any[] = []; executor.o.sink = (k, d) => ev.push([k, d]);
    executor.o.entryBlock = () => 'scanner: coin not approved';
    bot.start(); await settle();
    expect(executor.position).toBeNull(); expect(ev.find((e) => e[0] === 'risk')[1].reason).toBe('scanner: coin not approved');
    bot.stop();
  });
});
