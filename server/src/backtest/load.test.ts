import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCandles } from './load.js';

afterEach(() => vi.unstubAllGlobals());

describe('getCandles', () => {
  it('returns the cached/recorded candles merged with what the exchange still serves (not just the fetch)', async () => {
    const day = 86400_000, T = Date.UTC(2026, 0, 1);
    const rows = [0, 1, 2].map((i) => ({ time: BigInt(T + i * day), open: 1, high: 1, low: 1, close: 1, volume: 1 })); // recorded by the bot
    const db: any = { candle: { findMany: vi.fn(async () => rows), deleteMany: vi.fn(), createMany: vi.fn() }, $transaction: vi.fn(async () => []) };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ s: 'no_data' }) }))); // exchange has nothing older
    const c = await getCandles(db, 'https://x', 'BTC/USDT', '15', T - 30 * day, T + 10 * day, false, () => {});
    expect(c.map((x) => x.time)).toEqual([T, T + day, T + 2 * day]);
    expect(fetch).toHaveBeenCalled(); // coverage was incomplete, so it asked the exchange
  });
  it('uses the cache without any network call when it covers the range', async () => {
    const day = 86400_000, T = Date.UTC(2026, 0, 1);
    const rows = Array.from({ length: 31 }, (_, i) => ({ time: BigInt(T + i * day), open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const db: any = { candle: { findMany: vi.fn(async () => rows) } };
    vi.stubGlobal('fetch', vi.fn());
    expect(await getCandles(db, 'https://x', 'BTC/USDT', '60', T, T + 30 * day)).toHaveLength(31);
    expect(fetch).not.toHaveBeenCalled();
  });
});
