import { nobitexSymbol } from '../exchange/NobitexAdapter.js';
import type { Candle } from '../strategy/types.js';

export const TF_SECONDS: Record<string, number> = { '15': 900, '60': 3600, '240': 14400, D: 86400 }; // resolutions we support (Nobitex serves 15m only for the last ~7 days)

export interface FeedOpts { baseUrl: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }

/** Pages backwards through Nobitex UDF history (max 500 candles/request, 60 req/min). Returns ascending, de-duplicated candles. */
export async function fetchHistory(symbol: string, resolution: string, fromMs: number, toMs: number, o: FeedOpts): Promise<Candle[]> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const id = nobitexSymbol(symbol).id;
  const byTime = new Map<number, Candle>();
  let to = Math.floor(toMs / 1000);
  const from = Math.floor(fromMs / 1000);
  while (to > from) {
    const url = `${o.baseUrl}/market/udf/history?symbol=${id}&resolution=${resolution}&to=${to}&countback=500`;
    const res = await f(url, { headers: { 'User-Agent': 'TraderBot/safe-trading-bot-0.1' } });
    if (!res.ok) throw new Error(`candle fetch failed: HTTP ${res.status}`);
    const j: any = await res.json();
    if (j.s === 'no_data') break;
    if (j.s !== 'ok') throw new Error(`candle fetch failed: ${j.errmsg ?? j.s}`);
    for (let i = 0; i < j.t.length; i++) {
      byTime.set(j.t[i] * 1000, { time: j.t[i] * 1000, open: j.o[i], high: j.h[i], low: j.l[i], close: j.c[i], volume: j.v[i] });
    }
    const earliest = Math.min(...j.t);
    if (!(earliest < to)) break; // no progress
    to = earliest - 1;
    await sleep(1100);
  }
  return [...byTime.values()].filter((c) => c.time >= fromMs).sort((a, b) => a.time - b.time);
}

/** Drops the still-forming candle: only candles whose full interval has elapsed are safe to trade on. */
export function closedOnly(candles: Candle[], resolution: string, nowMs: number): Candle[] {
  const ms = TF_SECONDS[resolution]! * 1000;
  return candles.filter((c) => c.time + ms <= nowMs);
}

/** Latest `n` candles including the still-forming one (single request). */
export async function fetchRecent(symbol: string, resolution: string, n: number, o: FeedOpts): Promise<Candle[]> {
  const f = o.fetch ?? fetch;
  const url = `${o.baseUrl}/market/udf/history?symbol=${nobitexSymbol(symbol).id}&resolution=${resolution}&to=${Math.floor(Date.now() / 1000) + 1}&countback=${Math.min(n, 500)}`;
  const res = await f(url, { headers: { 'User-Agent': 'TraderBot/safe-trading-bot-0.1' } });
  if (!res.ok) throw new Error(`candle fetch failed: HTTP ${res.status}`);
  const j: any = await res.json();
  if (j.s !== 'ok') throw new Error(`candle fetch failed: ${j.errmsg ?? j.s}`);
  return j.t.map((t: number, i: number) => ({ time: t * 1000, open: j.o[i], high: j.h[i], low: j.l[i], close: j.c[i], volume: j.v[i] }));
}
