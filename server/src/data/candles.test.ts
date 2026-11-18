import { describe, expect, it } from 'vitest';
import { closedOnly, fetchHistory } from './candles.js';

const page = (ts: number[]) => ({ s: 'ok', t: ts, o: ts.map(() => 1), h: ts.map(() => 2), l: ts.map(() => 0.5), c: ts.map(() => 1.5), v: ts.map(() => 3) });

describe('candle feed', () => {
  it('pages backwards, merges, trims to range, ascending', async () => {
    const urls: string[] = [];
    const pages = [page([4000, 5000, 6000]), page([1000, 2000, 3000]), { s: 'no_data' }];
    const f = (async (u: string) => (urls.push(u), { ok: true, status: 200, json: async () => pages.shift() })) as any;
    const c = await fetchHistory('BTC/USDT', '60', 2_000_000, 6_000_000, { baseUrl: 'https://x', fetch: f, sleep: async () => {} });
    expect(c.map((x) => x.time / 1000)).toEqual([2000, 3000, 4000, 5000, 6000]);
    expect(urls[0]).toContain('symbol=BTCUSDT'); expect(urls[0]).toContain('to=6000');
    expect(urls[1]).toContain('to=3999');
  });
  it('stops when the API makes no progress and throws on errors', async () => {
    const f = (async () => ({ ok: true, status: 200, json: async () => page([9000]) })) as any;
    expect((await fetchHistory('BTC/USDT', '60', 0, 9_000_000, { baseUrl: 'x', fetch: f, sleep: async () => {} })).length).toBe(1);
    const e = (async () => ({ ok: true, status: 200, json: async () => ({ s: 'error', errmsg: 'Invalid resolution!' }) })) as any;
    await expect(fetchHistory('BTC/USDT', '7', 0, 9_000_000, { baseUrl: 'x', fetch: e })).rejects.toThrow(/Invalid resolution/);
    const h = (async () => ({ ok: false, status: 429 })) as any;
    await expect(fetchHistory('BTC/USDT', '60', 0, 9_000_000, { baseUrl: 'x', fetch: h })).rejects.toThrow(/429/);
  });
  it('closedOnly drops the forming candle', () => {
    const cs = [0, 3600_000, 7200_000].map((time) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    expect(closedOnly(cs, '60', 7200_000).length).toBe(2); // third candle closes at 10_800_000
    expect(closedOnly(cs, '60', 10_800_000).length).toBe(3);
  });
});
