import { describe, expect, it } from 'vitest';
import { emaRsiTrend } from '../strategy/emaRsiTrend.js';
import type { Candle } from '../strategy/types.js';
import { backtest, type BacktestCfg } from './backtest.js';

const cfg: BacktestCfg = { BOT_CAPITAL_USDT: 1000, RISK_PER_TRADE_PCT: 1, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_DAY: 5, DAILY_LOSS_LIMIT_PCT: 3, MAX_DRAWDOWN_PCT: 10, STALE_DATA_SECONDS: 60, MAX_EXCHANGE_ERRORS: 3, FEE_PCT: 0.1, SLIPPAGE_PCT: 0.05 };
const market = { minQty: 0.000001, minNotional: 0.5, qtyStep: 0.000001 };
const H = 3600_000, T0 = Date.UTC(2025, 0, 1);

// deterministic choppy uptrend: enough crossovers to produce trades
function series(n: number): Candle[] {
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p; p = Math.max(1, p * (1 + 0.004 * Math.sin(i / 7) + 0.0006 + 0.002 * Math.sin(i * 1.7)));
    return { time: T0 + i * H, open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p, volume: 1 };
  });
}

describe('backtest', () => {
  it('is deterministic, internally consistent, and charges fees', async () => {
    const c = series(1500);
    const a = await backtest('BTC/USDT', c, emaRsiTrend(), cfg, market);
    const b = await backtest('BTC/USDT', c, emaRsiTrend(), cfg, market);
    expect(a.netPnl).toBe(b.netPnl);
    expect(a.trades).toBeGreaterThan(0);
    expect(a.equityCurve.length).toBe(1500);
    expect(a.tradeList.reduce((s, t) => s + t.pnl, 0)).toBeCloseTo(a.endEquity - a.startEquity, 6); // no open position left at the end, else unrealized differs
    const free = await backtest('BTC/USDT', c, emaRsiTrend(), { ...cfg, FEE_PCT: 0, SLIPPAGE_PCT: 0 }, market);
    expect(free.netPnl).toBeGreaterThan(a.netPnl);
    expect(a.winRate).toBeGreaterThanOrEqual(0); expect(a.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });
  it('risk per trade bounds every loss (stop-loss exits lose ~1% + costs)', async () => {
    const r = await backtest('BTC/USDT', series(1500), emaRsiTrend(), cfg, market);
    for (const t of r.tradeList.filter((t) => t.reason === 'stop-loss')) expect(t.pnl).toBeGreaterThan(-1000 * 0.01 * 1.5);
  });
  it('`from` only trades from that time on, but uses earlier candles as warm-up', async () => {
    const c = series(1500), from = c[900]!.time;
    const r = await backtest('BTC/USDT', c, emaRsiTrend(), cfg, market, H, from);
    expect(r.candles).toBe(600); expect(r.from).toBe(from); expect(r.equityCurve.length).toBe(600);
    expect(r.tradeList.every((t) => t.time > from)).toBe(true);
    const cold = await backtest('BTC/USDT', c.slice(900), emaRsiTrend(), cfg, market, H); // no warm-up: needs 202 candles before it can act
    expect(r.trades + 0).toBeGreaterThanOrEqual(cold.trades);
    expect((await backtest('BTC/USDT', c, emaRsiTrend(), cfg, market, H, Date.now() * 2)).candles).toBe(0); // `from` after all data
  });
  it('handles no candles', async () => {
    const r = await backtest('BTC/USDT', [], emaRsiTrend(), cfg, market);
    expect(r).toMatchObject({ trades: 0, netPnl: 0, profitFactor: null, sharpe: 0 });
  });
});

describe('multi-timeframe backtest', () => {
  it('only shows the strategy higher-timeframe candles that had closed (no look-ahead)', async () => {
    const seen: { closeTime: number; htfLast: number | undefined }[] = [];
    const spy = { onCandle: (c: Candle[], _p: unknown, ctx?: { htf?: Candle[] }) => { seen.push({ closeTime: c.at(-1)!.time + 900_000, htfLast: ctx?.htf?.at(-1)?.time }); return { action: 'hold' as const, reason: '' }; } };
    const ms15 = 900_000, T = Date.UTC(2025, 0, 1);
    const c15: Candle[] = Array.from({ length: 40 }, (_, i) => ({ time: T + i * ms15, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const c1h: Candle[] = Array.from({ length: 12 }, (_, i) => ({ time: T + i * H, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    await backtest('BTC/USDT', c15, spy, cfg, market, ms15, 0, { candles: c1h, ms: H });
    for (const s of seen) if (s.htfLast !== undefined) expect(s.htfLast + H).toBeLessThanOrEqual(s.closeTime); // never an unclosed 1h candle
    expect(seen[0]!.htfLast).toBeUndefined(); // the first 15m candle closes before any 1h candle has
    expect(seen.at(-1)!.htfLast).toBe(T + 9 * H); // 40 x 15m = 10h; the last CLOSED 1h candle opened at hour 9
  });
});
