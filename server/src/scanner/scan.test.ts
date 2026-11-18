import { describe, expect, it } from 'vitest';
import type { Report } from '../backtest/backtest.js';
import type { Candle } from '../strategy/types.js';
import { choose, scan, type ScanCfg, type ScanDeps } from './scan.js';
import type { UsdtMarket } from './universe.js';

const DAY = 86400_000, NOW = Date.UTC(2026, 10, 18);
const cfg: ScanCfg = { minVolumeUsdt: 1, maxSpreadPct: 1, topN: 10, minOosTrades: 8, minOosPf: 1.2, maxDdPct: 12, minHistoryDays: 365, lookbackDays: 900, oosShare: 0.4 };
const mkt = (coin: string, v: number): UsdtMarket => ({ symbol: `${coin.toUpperCase()}/USDT`, coin, volumeUsdt: v, bid: 1, ask: 1.001, last: 1, closed: false });
const candles = (days: number): Candle[] => Array.from({ length: days }, (_, i) => ({ time: NOW - (days - i) * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
const rep = (o: Partial<Report>): Report => ({ returnPct: 5, trades: 20, profitFactor: 1.6, maxDrawdownPct: 6, killed: false, ...o } as Report);

function deps(over: Partial<ScanDeps> & { reports?: Record<string, { is: Partial<Report>; oos: Partial<Report> }>; days?: Record<string, number> } = {}): ScanDeps {
  return {
    markets: async () => [mkt('aaa', 900), mkt('bbb', 800), mkt('ccc', 700)],
    excluded: async () => new Set(),
    candles: async (s) => candles(over.days?.[s] ?? 1000),
    run: async (s, _c, from) => { const r = over.reports?.[s]; return rep(r ? (from <= NOW - 800 * DAY ? r.is : r.oos) : {}); }, // earlier-period call starts at the window start, later-period at the cut
    now: () => NOW, ...over,
  };
}

describe('scan', () => {
  it('passes a coin that is profitable in both periods and ranks passers by later-period return', async () => {
    const r = await scan(deps({ reports: { 'AAA/USDT': { is: { returnPct: 3 }, oos: { returnPct: 4 } }, 'BBB/USDT': { is: { returnPct: 3 }, oos: { returnPct: 9 } }, 'CCC/USDT': { is: { returnPct: 2 }, oos: { returnPct: 1 } } } }), cfg, 'donchian');
    expect(r.results.map((x) => x.symbol)).toEqual(['BBB/USDT', 'AAA/USDT', 'CCC/USDT']);
    expect(r.best).toBe('BBB/USDT'); expect(r.results[0]!.reasons).toEqual(['passes every gate']);
  });
  it('explains every failed gate', async () => {
    const r = await scan(deps({ reports: { 'AAA/USDT': { is: { returnPct: -1 }, oos: { returnPct: -2, trades: 3, profitFactor: 0.8, maxDrawdownPct: 20, killed: true } }, 'BBB/USDT': { is: {}, oos: { profitFactor: null } } } }), cfg, 'donchian');
    const a = r.results.find((x) => x.symbol === 'AAA/USDT')!;
    expect(a.passes).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/earlier period.*later period.*only 3 trades.*profit factor 0.80.*drawdown 20.0%.*kill switch/);
    expect(r.results.find((x) => x.symbol === 'BBB/USDT')!.reasons.join()).toMatch(/profit factor n\/a/);
  });
  it('rejects coins without enough history, and survives a failing coin', async () => {
    const r = await scan(deps({ days: { 'AAA/USDT': 100 }, candles: async (s) => { if (s === 'CCC/USDT') throw new Error('boom'); return candles(s === 'AAA/USDT' ? 100 : 1000); } }), cfg, 'donchian');
    expect(r.results.find((x) => x.symbol === 'AAA/USDT')!.reasons[0]).toMatch(/only 9\d days of history/);
    expect(r.results.find((x) => x.symbol === 'CCC/USDT')!.reasons[0]).toMatch(/scan failed: boom/);
    expect(r.best).toBe('BBB/USDT');
  });
  it('handles an empty candle list', async () => {
    const r = await scan(deps({ candles: async () => [] }), cfg, 'donchian');
    expect(r.best).toBeNull(); expect(r.results[0]!.reasons[0]).toMatch(/only 0 days/);
  });
});

describe('choose', () => {
  const base = { at: 0, strategy: 's', universe: 2, scanned: 2, cfg } as any;
  const r = { ...base, best: 'BBB/USDT', results: [{ symbol: 'BBB/USDT', passes: true }, { symbol: 'AAA/USDT', passes: true }, { symbol: 'CCC/USDT', passes: false }] };
  it('keeps the current coin while it still passes (no churn)', () => expect(choose(r, 'AAA/USDT')).toBe('AAA/USDT'));
  it('moves to the best coin when the current one fails or is unknown', () => { expect(choose(r, 'CCC/USDT')).toBe('BBB/USDT'); expect(choose(r, null)).toBe('BBB/USDT'); expect(choose(r, 'ZZZ/USDT')).toBe('BBB/USDT'); });
  it('chooses nothing (stay in cash) when no coin passes', () => expect(choose({ ...r, best: null, results: [{ symbol: 'AAA/USDT', passes: false }] }, 'AAA/USDT')).toBeNull());
});
