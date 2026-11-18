import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NobitexAdapter, nobitexSymbol } from './NobitexAdapter.js';
import { UnknownOutcomeError } from './types.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32).toString('base64url');

type Call = { path: string; init: any };
function mk(routes: Record<string, (body: any) => any>, calls: Call[] = []) {
  const f = (async (url: string, init: any) => {
    const path = url.replace('https://x', '');
    calls.push({ path, init });
    const r = routes[path.split('?')[0]!];
    if (!r) return { ok: false, status: 404, text: async () => '{"status":"failed","code":"NotFound"}' };
    const out = r(init.body ? JSON.parse(init.body) : undefined);
    return { ok: out.http ? false : true, status: out.http ?? 200, text: async () => JSON.stringify(out.json ?? out) };
  }) as any;
  return new NobitexAdapter({ baseUrl: 'https://x', apiKey: 'KEY', apiSecret: seed, feePct: 0.13, fetch: f, now: () => 1_700_000_000_000, sleep: async () => {} });
}
const options = () => ({ status: 'ok', nobitex: { amountPrecisions: { BTCUSDT: '0.000001' }, pricePrecisions: { BTCUSDT: '0.01' }, minOrders: { usdt: '0.5' } } });

describe('NobitexAdapter', () => {
  it('maps symbols', () => {
    expect(nobitexSymbol('BTC/USDT')).toEqual({ src: 'btc', dst: 'usdt', id: 'BTCUSDT' });
    expect(() => nobitexSymbol('BTC')).toThrow();
  });
  it('signs timestamp+METHOD+path+body with Ed25519, url-safe base64', () => {
    const a = mk({});
    const h = a.signedHeaders('POST', '/market/orders/add', '{"a":1}', 1700000000);
    expect(h['Nobitex-Timestamp']).toBe('1700000000');
    expect(h['Nobitex-Key']).toBe('KEY');
    expect(verify(null, Buffer.from('1700000000POST/market/orders/add{"a":1}'), publicKey, Buffer.from(h['Nobitex-Signature'], 'base64url'))).toBe(true);
  });
  it('rejects a malformed secret and unsigned private calls', async () => {
    expect(() => new NobitexAdapter({ baseUrl: 'x', apiKey: 'k', apiSecret: 'AAAA', feePct: 0 })).toThrow(/32- or 64-byte/);
    await expect(new NobitexAdapter({ baseUrl: 'https://x', apiKey: '', apiSecret: '', feePct: 0, fetch: (async () => ({})) as any }).getBalance('usdt')).rejects.toThrow(/not configured/);
  });
  it('reads ticker and market rules', async () => {
    const a = mk({ '/v3/orderbook/BTCUSDT': () => ({ status: 'ok', lastTradePrice: '63000.5', lastUpdate: 1699999999000 }), '/v2/options': options });
    expect(await a.getTicker('BTC/USDT')).toEqual({ price: 63000.5, time: 1699999999000 });
    expect(await a.getMarket('BTC/USDT')).toEqual({ minQty: 0.000001, minNotional: 0.5, qtyStep: 0.000001 });
    await expect(a.getMarket('XYZ/USDT')).rejects.toThrow(/no market rules/);
  });
  it('reads activeBalance', async () => {
    const a = mk({ '/users/wallets/list': () => ({ status: 'ok', wallets: [{ currency: 'usdt', activeBalance: '12.5' }] }) });
    expect(await a.getBalance('USDT')).toBe(12.5);
    expect(await a.getBalance('btc')).toBe(0);
  });
  it('places a bounded market order, polls status, returns the fill', async () => {
    const calls: Call[] = [];
    let polls = 0;
    const a = mk({
      '/v3/orderbook/BTCUSDT': () => ({ status: 'ok', lastTradePrice: '100', lastUpdate: 1 }),
      '/v2/options': options,
      '/market/orders/add': () => ({ status: 'ok', order: { id: 7, status: 'Active', matchedAmount: '0' } }),
      '/market/orders/status': () => (++polls, { status: 'ok', order: { id: 7, status: 'Done', matchedAmount: '0.5', averagePrice: '100.2' } }),
    }, calls);
    const f = await a.marketOrder({ clientOrderId: 'BTCUSDT-b-1', symbol: 'BTC/USDT', side: 'buy', qty: 0.5000009 });
    expect(f).toMatchObject({ qty: 0.5, price: 100.2, side: 'buy' });
    expect(f.fee).toBeCloseTo(0.5 * 100.2 * 0.0013);
    const add = calls.find((c) => c.path === '/market/orders/add')!;
    expect(JSON.parse(add.init.body)).toEqual({ type: 'buy', execution: 'market', srcCurrency: 'btc', dstCurrency: 'usdt', amount: '0.500000', price: '101.00', clientOrderId: 'BTCUSDT-b-1' });
    expect(add.init.headers['Nobitex-Signature']).toBeTruthy();
    expect(polls).toBe(1);
  });
  it('throws on bad client id, API failure, no id, unfilled, tiny qty', async () => {
    const base = { '/v3/orderbook/BTCUSDT': () => ({ status: 'ok', lastTradePrice: '100', lastUpdate: 1 }), '/v2/options': options };
    const r = { clientOrderId: 'ok-1', symbol: 'BTC/USDT', side: 'sell' as const, qty: 1 };
    await expect(mk(base).marketOrder({ ...r, clientOrderId: 'bad_id!' })).rejects.toThrow(/clientOrderId/);
    await expect(mk({ ...base, '/market/orders/add': () => ({ status: 'failed', code: 'SmallOrder', message: 'x' }) }).marketOrder(r)).rejects.toThrow(/SmallOrder/);
    await expect(mk({ ...base, '/market/orders/add': () => ({ status: 'ok', order: {} }) }).marketOrder(r)).rejects.toThrow(/no order id/);
    await expect(mk(base).marketOrder({ ...r, qty: 0.0000001 })).rejects.toThrow(/min/);
  });
  it('surfaces HTTP 429 and non-JSON, and cancels all spot orders', async () => {
    await expect(mk({ '/v2/options': () => ({ http: 429, json: { status: 'failed', code: 'TooManyRequests' } }) }).getMarket('BTC/USDT')).rejects.toThrow(/TooManyRequests/);
    const bad = new NobitexAdapter({ baseUrl: 'https://x', apiKey: '', apiSecret: '', feePct: 0, fetch: (async () => ({ ok: true, status: 200, text: async () => '<html>' })) as any });
    await expect(bad.getTicker('BTC/USDT')).rejects.toThrow(/non-JSON/);
    const calls: Call[] = [];
    await mk({ '/market/orders/cancel-old': () => ({ status: 'ok' }) }, calls).cancelAllOrders();
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ tradeType: 'spot' });
  });

  it('places, polls and cancels exchange-side stop-market orders', async () => {
    const calls: Call[] = [];
    let status = 'Inactive';
    const a = mk({
      '/v2/options': options,
      '/market/orders/add': () => ({ status: 'ok', order: { id: 42 } }),
      '/market/orders/status': () => ({ status: 'ok', order: { id: 42, status, matchedAmount: status === 'Done' ? '0.5' : '0', averagePrice: '97.5' } }),
      '/market/orders/update-status': (b) => (b.order === 42 ? { status: 'ok', updatedStatus: 'Canceled' } : { status: 'failed', code: 'X' }),
    }, calls);
    const ref = await a.stops.place('BTC/USDT', 0.5000009, 98.123, 'BTCUSDT-x-1');
    expect(ref).toBe('42');
    expect(JSON.parse(calls.find((c) => c.path === '/market/orders/add')!.init.body)).toEqual({ type: 'sell', execution: 'stop_market', srcCurrency: 'btc', dstCurrency: 'usdt', amount: '0.500000', stopPrice: '98.12', clientOrderId: 'BTCUSDT-x-1' });
    expect(await a.stops.status('42')).toEqual({ state: 'open', filledQty: 0, avgPrice: 97.5 });
    status = 'Done'; expect(await a.stops.status('42')).toEqual({ state: 'filled', filledQty: 0.5, avgPrice: 97.5 });
    status = 'Canceled'; expect((await a.stops.status('42')).state).toBe('canceled');
    await a.stops.cancel('42');
    await expect(a.stops.cancel('7')).rejects.toThrow(/X/);
    await expect(a.stops.place('BTC/USDT', 0.0000001, 98, 'c')).rejects.toThrow(/below min/);
    await expect(mk({ '/v2/options': options, '/market/orders/add': () => ({ status: 'ok', order: {} }) }).stops.place('BTC/USDT', 1, 98, 'c')).rejects.toThrow(/no stop order id/);
  });

  describe('order outcome safety', () => {
    const base = () => ({ '/v3/orderbook/BTCUSDT': () => ({ status: 'ok', lastTradePrice: '100', lastUpdate: 1 }), '/v2/options': options });
    const r = { clientOrderId: 'ok-1', symbol: 'BTC/USDT', side: 'buy' as const, qty: 1 };
    const resting = (afterCancel: object) => {
      let canceled = false;
      return {
        ...base(),
        '/market/orders/add': () => ({ status: 'ok', order: { id: 1, status: 'Active' } }),
        '/market/orders/update-status': () => { canceled = true; return { status: 'ok' }; },
        '/market/orders/status': () => ({ status: 'ok', order: canceled ? { id: 1, ...afterCancel } : { id: 1, status: 'Active', matchedAmount: '0' } }),
      };
    };
    it('cancels a resting order; unfilled -> clean failure', async () => {
      await expect(mk(resting({ status: 'Canceled', matchedAmount: '0' })).marketOrder(r)).rejects.toThrow(/not filled/);
    });
    it('cancels the remainder of a partial fill and returns the filled part', async () => {
      const f = await mk(resting({ status: 'Canceled', matchedAmount: '0.3', averagePrice: '100' })).marketOrder(r);
      expect(f.qty).toBe(0.3);
    });
    it('an order that is still live after cancel is an UNKNOWN outcome', async () => {
      await expect(mk(resting({ status: 'Active', matchedAmount: '0' })).marketOrder(r)).rejects.toBeInstanceOf(UnknownOutcomeError);
    });
    it('status check failures are UNKNOWN outcomes, not plain errors', async () => {
      const a = mk({ ...base(), '/market/orders/add': () => ({ status: 'ok', order: { id: 1, status: 'Active' } }), '/market/orders/status': () => { throw new Error('socket hang up'); } });
      await expect(a.marketOrder(r)).rejects.toBeInstanceOf(UnknownOutcomeError);
    });
    it('lost response: finds the order by clientOrderId and carries on', async () => {
      const a = mk({ ...base(), '/market/orders/add': () => { throw new Error('ECONNRESET'); },
        '/market/orders/list': () => ({ status: 'ok', orders: [{ id: 9, clientOrderId: 'ok-1', status: 'Done', matchedAmount: '1', averagePrice: '100' }] }) });
      expect((await a.marketOrder(r)).qty).toBe(1);
    });
    it('lost response, lookup says it does not exist: plain failure, safe to retry', async () => {
      const a = mk({ ...base(), '/market/orders/add': () => { throw new Error('ECONNRESET'); }, '/market/orders/list': () => ({ status: 'ok', orders: [] }) });
      const e = await a.marketOrder(r).catch((x) => x);
      expect(e).toBeInstanceOf(Error); expect(e).not.toBeInstanceOf(UnknownOutcomeError); expect(e.message).toMatch(/not placed/);
    });
    it('lost response and lookup fails too: UNKNOWN outcome', async () => {
      const a = mk({ ...base(), '/market/orders/add': () => ({ http: 502, json: { status: 'failed' } }) });
      await expect(a.marketOrder(r)).rejects.toBeInstanceOf(UnknownOutcomeError); // 5xx + no list route -> lookup fails
    });
    it('a stop whose response was lost is adopted via lookup; unverifiable -> UNKNOWN', async () => {
      const lost = { '/v2/options': options, '/market/orders/add': () => { throw new Error('timeout'); } };
      const a = mk({ ...lost, '/market/orders/list': () => ({ status: 'ok', orders: [{ id: 77, clientOrderId: 'stop-1' }] }) });
      expect(await a.stops.place('BTC/USDT', 1, 98, 'stop-1')).toBe('77');
      await expect(mk(lost).stops.place('BTC/USDT', 1, 98, 'stop-1')).rejects.toBeInstanceOf(UnknownOutcomeError);
    });
    it('reads total balance including locked funds', async () => {
      const a = mk({ '/users/wallets/list': () => ({ status: 'ok', wallets: [{ currency: 'btc', balance: '1', activeBalance: '0' }] }) });
      expect(await a.getTotalBalance('BTC')).toBe(1); expect(await a.getBalance('BTC')).toBe(0); expect(await a.getTotalBalance('eth')).toBe(0);
    });
  });

  it('lists non-zero wallets and prices coins in USDT', async () => {
    const calls: Call[] = [];
    const a = mk({
      '/users/wallets/list': () => ({ status: 'ok', wallets: [
        { currency: 'btc', balance: '0.5', blockedBalance: '0.1', activeBalance: '0.4' },
        { currency: 'eth', balance: '0', blockedBalance: '0', activeBalance: '0' },
        { currency: 'usdt', balance: '12', blockedBalance: '0', activeBalance: '12' }] }),
      '/market/stats': () => ({ status: 'ok', stats: { 'btc-usdt': { latest: '63000.5' }, 'doge-usdt': { latest: null } } }),
    }, calls);
    expect(await a.getWallets()).toEqual([{ currency: 'btc', total: 0.5, locked: 0.1, available: 0.4 }, { currency: 'usdt', total: 12, locked: 0, available: 12 }]);
    expect(await a.getUsdtPrices(['btc', 'usdt', 'rls', 'doge'])).toEqual({ btc: 63000.5 });
    expect(calls.at(-1)!.path).toContain('srcCurrency=btc,doge&dstCurrency=usdt');
    expect(await a.getUsdtPrices(['usdt', 'rls'])).toEqual({}); // nothing to fetch
  });

  it('lists USDT markets with 24h stats, and the coins we never auto-trade', async () => {
    const a = mk({
      '/market/stats': () => ({ status: 'ok', stats: { 'btc-usdt': { isClosed: false, bestBuy: '100', bestSell: '100.1', volumeDst: '1500000.5', latest: '100.05' }, 'btc-rls': { bestBuy: '1' }, 'ada-usdt': { isClosed: true, bestBuy: null, bestSell: null, volumeDst: '5', latest: null } } }),
      '/v2/options': () => ({ status: 'ok', nobitex: { allCurrencies: ['btc', 'ada', 'old'], activeCurrencies: ['btc', 'ada'], testingCurrencies: ['tst'], xchangeTestingCurrencies: ['xt'], indexFunds: { nxfix: 1 }, currencyDisclaimers: { tsla: {} } } }),
    });
    const m = await a.getUsdtMarkets();
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ symbol: 'BTC/USDT', coin: 'btc', volumeUsdt: 1500000.5, bid: 100, ask: 100.1, last: 100.05, closed: false });
    expect(m[1]).toMatchObject({ coin: 'ada', closed: true, bid: 0 });
    expect([...(await a.getExcludedCoins())].sort()).toEqual(['nxfix', 'old', 'tsla', 'tst', 'xt']);
  });
});
