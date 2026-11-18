export interface UsdtMarket { symbol: string; coin: string; volumeUsdt: number; bid: number; ask: number; last: number; closed: boolean }
export interface UniverseCfg { minVolumeUsdt: number; maxSpreadPct: number; topN: number }
export interface Candidate extends UsdtMarket { spreadPct: number }

/** Stablecoins and wrapped/pegged coins: no trend to trade. */
const PEGGED = new Set(['usdt', 'usdc', 'dai', 'busd', 'usde', 'tusd', 'fdusd', 'wbtc', 'xaut', 'paxg']);

/** Liquid, tradable USDT markets, most liquid first. Thin or wide-spread markets are where small accounts lose to the spread. */
export function filterUniverse(markets: UsdtMarket[], excluded: Set<string>, c: UniverseCfg): Candidate[] {
  return markets
    .filter((m) => !m.closed && !PEGGED.has(m.coin) && !excluded.has(m.coin) && m.bid > 0 && m.ask >= m.bid && m.volumeUsdt >= c.minVolumeUsdt)
    .map((m) => ({ ...m, spreadPct: ((m.ask - m.bid) / ((m.ask + m.bid) / 2)) * 100 }))
    .filter((m) => m.spreadPct <= c.maxSpreadPct)
    .sort((a, b) => b.volumeUsdt - a.volumeUsdt)
    .slice(0, c.topN);
}
