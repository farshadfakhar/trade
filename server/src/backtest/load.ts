import type { PrismaClient } from '@prisma/client';
import { TF_SECONDS, fetchHistory } from '../data/candles.js';
import type { StrategyInfo } from '../strategy/index.js';
import { loadCandles, saveCandles } from '../db/store.js';
import type { Candle } from '../strategy/types.js';

/** Cached candles from SQLite; fetches from Nobitex (and caches) when the cache doesn't cover the range. */
export async function getCandles(db: PrismaClient, baseUrl: string, symbol: string, res: string, from: number, to: number, refresh = false, log: (m: string) => void = () => {}): Promise<Candle[]> {
  let c = refresh ? [] : await loadCandles(db, symbol, res, from, to);
  if (!c.length || c[0]!.time > from + 7 * 86400_000 || c[c.length - 1]!.time < to - 7 * 86400_000) {
    log('fetching candles from Nobitex (rate-limited, ~1s per 500 candles)...');
    const fetched = await fetchHistory(symbol, res, from, to, { baseUrl });
    await saveCandles(db, symbol, res, fetched);
    c = await loadCandles(db, symbol, res, from, to); // merged: also keeps older candles the bot recorded itself (Nobitex only serves ~7 days of 15m)
  }
  return c;
}

/** Candles for a backtest, including indicator warm-up before `from` and the strategy's higher-timeframe feed. */
export async function loadForBacktest(db: PrismaClient, baseUrl: string, info: StrategyInfo, symbol: string, res: string, from: number, to: number, refresh = false, log: (m: string) => void = () => {}) {
  const ms = (r: string) => TF_SECONDS[r]! * 1000;
  const candles = await getCandles(db, baseUrl, symbol, res, from - 500 * ms(res), to, refresh, log);
  const htf = info.htfResolution ? { candles: await getCandles(db, baseUrl, symbol, info.htfResolution, from - 320 * ms(info.htfResolution), to, refresh, log), ms: ms(info.htfResolution) } : undefined;
  return { candles, htf };
}
