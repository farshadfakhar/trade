import { createPrivateKey, sign } from 'node:crypto';
import { floorToStep, type ExchangeAdapter, type Fill, type MarketInfo, type OrderInfo, type OrderRequest, type StopOrders, type Ticker, UnknownOutcomeError } from './types.js';

export interface NobitexOpts {
  baseUrl: string; apiKey: string; apiSecret: string; feePct: number;
  fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
}

/** 'BTC/USDT' -> { src:'btc', dst:'usdt', id:'BTCUSDT' } */
export function nobitexSymbol(symbol: string) {
  const [b, q] = symbol.split('/');
  if (!b || !q) throw new Error(`bad symbol ${symbol}`);
  return { src: b.toLowerCase(), dst: q.toLowerCase(), id: (b + q).toUpperCase() };
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const decimals = (step: string) => (step.split('.')[1] ?? '').length;
const UA = 'TraderBot/safe-trading-bot-0.1';
/** Transport-level failure: we don't know whether the server acted on the request. */
class NetworkError extends Error {}

/**
 * Spot-only Nobitex adapter. Public data needs no key; orders/wallets use signed requests
 * (Ed25519 over timestamp + METHOD + path + body, URL-safe base64).
 * Never retries on errors (docs: aggressive retries after 429 block the token for 2 min);
 * errors throw and the RiskManager counts them.
 */
export class NobitexAdapter implements ExchangeAdapter {
  private f: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private key;
  private options?: { at: number; amountPrec: Record<string, string>; pricePrec: Record<string, string>; minOrders: Record<string, string> };

  constructor(private o: NobitexOpts) {
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (o.apiSecret) {
      const raw = Buffer.from(o.apiSecret, 'base64url');
      if (raw.length !== 32 && raw.length !== 64) throw new Error('API secret must decode to a 32- or 64-byte Ed25519 key');
      // shortcut: assumes the secret is the raw 32-byte seed (first 32 bytes if 64); confirm against testnet.
      this.key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    }
  }

  /** @internal exposed for tests */
  signedHeaders(method: string, path: string, body: string, ts = Math.floor(this.now() / 1000)) {
    if (!this.key) throw new Error('API key/secret not configured');
    const sig = sign(null, Buffer.from(`${ts}${method}${path}${body}`), this.key).toString('base64url');
    return { 'Nobitex-Key': this.o.apiKey, 'Nobitex-Signature': sig, 'Nobitex-Timestamp': String(ts) };
  }

  private async req(method: 'GET' | 'POST', path: string, body?: object, signed = false): Promise<any> {
    const raw = body === undefined ? '' : JSON.stringify(body); // sign exactly the bytes we send
    const headers: Record<string, string> = { 'User-Agent': UA, ...(raw ? { 'Content-Type': 'application/json' } : {}), ...(signed ? this.signedHeaders(method, path, raw) : {}) };
    let res: Response, text: string;
    try { res = await this.f(this.o.baseUrl + path, { method, headers, body: raw || undefined }); text = await res.text(); }
    catch (e) { throw new NetworkError(`Nobitex ${path}: ${e instanceof Error ? e.message : 'network error'}`); }
    let j: any;
    try { j = JSON.parse(text); } catch { throw new NetworkError(`Nobitex ${path}: HTTP ${res.status} non-JSON`); }
    if (res.status >= 500) throw new NetworkError(`Nobitex ${path}: HTTP ${res.status}`);
    if (!res.ok || j.status === 'failed') throw new Error(`Nobitex ${path}: ${j.code ?? res.status} ${j.message ?? ''}`.trim());
    return j;
  }

  async getQuote(symbol: string) {
    const book = await this.req('GET', `/v3/orderbook/${nobitexSymbol(symbol).id}`);
    return { bid: Number(book.bids?.[0]?.[0]), ask: Number(book.asks?.[0]?.[0]), quoteTime: Number(book.lastUpdate) };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const j = await this.req('GET', `/v3/orderbook/${nobitexSymbol(symbol).id}`);
    const price = Number(j.lastTradePrice);
    if (!(price > 0)) throw new Error(`no last price for ${symbol}`);
    return { price, time: Number(j.lastUpdate) || this.now() };
  }

  private async opts() {
    if (!this.options || this.now() - this.options.at > 3600_000) {
      const j = await this.req('GET', '/v2/options');
      this.options = { at: this.now(), amountPrec: j.nobitex.amountPrecisions, pricePrec: j.nobitex.pricePrecisions, minOrders: j.nobitex.minOrders };
    }
    return this.options;
  }

  async getMarket(symbol: string): Promise<MarketInfo> {
    const { id, dst } = nobitexSymbol(symbol);
    const o = await this.opts();
    const step = Number(o.amountPrec[id]);
    const minNotional = Number(o.minOrders[dst]);
    if (!(step > 0) || !(minNotional > 0)) throw new Error(`no market rules for ${symbol}`);
    return { minQty: step, minNotional, qtyStep: step };
  }

  private async wallet(asset: string) {
    const j = await this.req('POST', '/users/wallets/list', { type: 'spot' }, true);
    return (j.wallets as any[]).find((x) => x.currency === asset.toLowerCase());
  }
  async getBalance(asset: string): Promise<number> { return Number((await this.wallet(asset))?.activeBalance ?? 0); } // excludes funds locked in open orders
  async getTotalBalance(asset: string): Promise<number> { return Number((await this.wallet(asset))?.balance ?? 0); }

  /** Every spot wallet with a non-zero balance (read-only; needs a READ key). */
  async getWallets() {
    const j = await this.req('POST', '/users/wallets/list', { type: 'spot' }, true);
    return (j.wallets as any[])
      .map((w) => ({ currency: String(w.currency), total: Number(w.balance), locked: Number(w.blockedBalance), available: Number(w.activeBalance) }))
      .filter((w) => w.total > 0);
  }

  /** Last price in USDT for the given coins (public endpoint; coins without a USDT market are omitted). */
  async getUsdtPrices(currencies: string[]): Promise<Record<string, number>> {
    const src = currencies.filter((c) => c !== 'usdt' && c !== 'rls');
    if (!src.length) return {};
    const j = await this.req('GET', `/market/stats?srcCurrency=${src.join(',')}&dstCurrency=usdt`);
    const out: Record<string, number> = {};
    for (const c of src) { const v = Number(j.stats?.[`${c}-usdt`]?.latest); if (v > 0) out[c] = v; }
    return out;
  }

  /** All USDT markets with 24h stats (public). */
  async getUsdtMarkets() {
    const j = await this.req('GET', '/market/stats?dstCurrency=usdt');
    return Object.entries(j.stats as Record<string, any>).filter(([k]) => k.endsWith('-usdt')).map(([k, v]) => ({
      symbol: `${k.split('-')[0]!.toUpperCase()}/USDT`, coin: k.split('-')[0]!,
      volumeUsdt: Number(v.volumeDst) || 0, bid: Number(v.bestBuy) || 0, ask: Number(v.bestSell) || 0, last: Number(v.latest) || 0, closed: !!v.isClosed,
    }));
  }

  /** Coins we never auto-trade: not active, test listings, index funds, and tokens flagged "trade only, no deposit/withdraw" (stocks etc.). */
  async getExcludedCoins(): Promise<Set<string>> {
    const j = await this.req('GET', '/v2/options');
    const n = j.nobitex ?? {};
    const active = new Set<string>(n.activeCurrencies ?? []);
    const out = new Set<string>([...(n.testingCurrencies ?? []), ...(n.xchangeTestingCurrencies ?? []), ...Object.keys(n.indexFunds ?? {}), ...Object.keys(n.currencyDisclaimers ?? {})]);
    for (const c of (n.allCurrencies ?? []) as string[]) if (!active.has(c)) out.add(c);
    return out;
  }

  /**
   * After a transport failure on an order request: did the order reach the exchange? Looks it up by clientOrderId.
   * Returns the order, null if (verifiably) it does not exist, and throws UnknownOutcomeError if we can't tell.
   */
  private async recover(clientOrderId: string, src: string, dst: string): Promise<any | null> {
    try {
      const j = await this.req('GET', `/market/orders/list?status=all&details=2&srcCurrency=${src}&dstCurrency=${dst}&pageSize=50`, undefined, true);
      return (j.orders as any[]).find((o) => o.clientOrderId === clientOrderId) ?? null;
    } catch (e) { throw new UnknownOutcomeError(`${clientOrderId}: request failed and lookup failed (${(e as Error).message})`); }
  }

  /** Sends an order request; on a transport failure, resolves the ambiguity via recover(). */
  private async place(body: Record<string, unknown>, src: string, dst: string): Promise<any> {
    try { return (await this.req('POST', '/market/orders/add', body, true)).order; }
    catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      const found = await this.recover(String(body.clientOrderId), src, dst);
      if (!found) throw new Error(`order ${body.clientOrderId} was not placed (verified by lookup after: ${e.message})`);
      return found;
    }
  }

  async cancelAllOrders() {
    await this.req('POST', '/market/orders/cancel-old', { tradeType: 'spot' }, true);
  }

  /** Exchange-side protective stop (stop_market sell). shortcut: untested against the real exchange; try it on the testnet first. */
  stops: StopOrders = {
    place: async (symbol, qty, stopPrice, clientOrderId) => {
      const { src, dst, id } = nobitexSymbol(symbol);
      const m = await this.getMarket(symbol); const o = await this.opts();
      const amount = floorToStep(qty, m.qtyStep);
      if (!(amount >= m.minQty)) throw new Error('stop qty below min after precision rounding');
      const order = await this.place({
        type: 'sell', execution: 'stop_market', srcCurrency: src, dstCurrency: dst,
        amount: amount.toFixed(decimals(o.amountPrec[id]!)), stopPrice: stopPrice.toFixed(decimals(o.pricePrec[id] ?? '0.01')), clientOrderId,
      }, src, dst);
      if (!order?.id) throw new Error('Nobitex returned no stop order id');
      return String(order.id);
    },
    status: async (ref): Promise<OrderInfo> => {
      const o = (await this.req('POST', '/market/orders/status', { id: Number(ref) }, true)).order;
      const filledQty = Number(o.matchedAmount) || 0;
      const state = o.status === 'Done' ? 'filled' : o.status === 'Canceled' ? 'canceled' : 'open';
      return { state, filledQty, avgPrice: Number(o.averagePrice) || (filledQty ? Number(o.totalPrice) / filledQty : 0) };
    },
    cancel: async (ref) => { await this.req('POST', '/market/orders/update-status', { order: Number(ref), status: 'canceled' }, true); }, // throws unless the cancel was applied
  };

  async marketOrder(r: OrderRequest): Promise<Fill> {
    if (!/^[A-Za-z0-9-]{1,32}$/.test(r.clientOrderId)) throw new Error('clientOrderId must match ^[A-Za-z0-9-]{1,32}$');
    const { src, dst, id } = nobitexSymbol(r.symbol);
    const [m, o, t] = [await this.getMarket(r.symbol), await this.opts(), await this.getTicker(r.symbol)];
    const qty = floorToStep(r.qty, m.qtyStep);
    if (!(qty >= m.minQty)) throw new Error('qty below min after precision rounding');
    // Bound the market order to ±1% of last price (docs recommend a price on market orders).
    const buy = r.side === 'buy';
    const pd = decimals(o.pricePrec[id] ?? '0.01');
    const bound = (t.price * (buy ? 1.01 : 0.99)).toFixed(pd);
    let order = await this.place({
      type: r.side, execution: 'market', srcCurrency: src, dstCurrency: dst,
      amount: qty.toFixed(decimals(o.amountPrec[id]!)), price: bound, clientOrderId: r.clientOrderId,
    }, src, dst);
    const orderId = order?.id;
    if (!orderId) throw new Error('Nobitex returned no order id');

    const poll = async () => {
      try { return (await this.req('POST', '/market/orders/status', { id: orderId }, true)).order; }
      catch (e) { throw new UnknownOutcomeError(`order ${orderId}: status check failed (${(e as Error).message})`); }
    };
    const done = (x: any) => x.status === 'Done' || x.status === 'Canceled';
    for (let i = 0; i < 5 && !done(order); i++) { await this.sleep(500); order = await poll(); }
    if (!done(order)) { // still resting: cancel the remainder so it can't fill later behind our back
      try { await this.req('POST', '/market/orders/update-status', { order: orderId, status: 'canceled' }, true); } catch { /* the final status below tells the truth */ }
      order = await poll();
      if (!done(order)) throw new UnknownOutcomeError(`order ${orderId} is still ${order.status} after cancel`);
    }
    const matched = Number(order.matchedAmount);
    if (!(matched > 0)) throw new Error(`order ${orderId} not filled (status ${order.status})`);
    const price = Number(order.averagePrice) || Number(order.totalPrice) / matched;
    // shortcut: fee is estimated from FEE_PCT (the unit of the API's `fee` field is undocumented); verify vs. real fills.
    return { clientOrderId: r.clientOrderId, symbol: r.symbol, side: r.side, qty: matched, price, fee: matched * price * this.o.feePct / 100, time: this.now() };
  }
}
