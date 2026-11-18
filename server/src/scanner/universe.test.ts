import { describe, expect, it } from 'vitest';
import { filterUniverse, type UsdtMarket } from './universe.js';

const m = (coin: string, volumeUsdt: number, bid: number, ask: number, closed = false): UsdtMarket => ({ symbol: `${coin.toUpperCase()}/USDT`, coin, volumeUsdt, bid, ask, last: bid, closed });
const cfg = { minVolumeUsdt: 100_000, maxSpreadPct: 0.3, topN: 3 };

describe('filterUniverse', () => {
  it('keeps liquid tight-spread markets, most liquid first, capped at topN', () => {
    const r = filterUniverse([m('eth', 600_000, 100, 100.1), m('btc', 1_300_000, 100, 100.05), m('sol', 400_000, 10, 10.01), m('ada', 300_000, 1, 1.001)], new Set(), cfg);
    expect(r.map((x) => x.coin)).toEqual(['btc', 'eth', 'sol']);
    expect(r[0]!.spreadPct).toBeCloseTo(0.05, 2);
  });
  it('drops thin, wide-spread, closed, excluded, stable/pegged and broken-quote markets', () => {
    const r = filterUniverse([
      m('thin', 50_000, 1, 1.001), m('wide', 500_000, 100, 101), m('shut', 500_000, 1, 1.001, true), m('stock', 500_000, 1, 1.001),
      m('usdc', 500_000, 1, 1.0001), m('xaut', 500_000, 1, 1.001), m('nobid', 500_000, 0, 1), m('crossed', 500_000, 2, 1), m('ok', 500_000, 1, 1.001),
    ], new Set(['stock']), { ...cfg, topN: 20 });
    expect(r.map((x) => x.coin)).toEqual(['ok']);
  });
});
