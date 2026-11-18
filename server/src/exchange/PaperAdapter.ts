import { floorToStep, type ExchangeAdapter, type Fill, type MarketInfo, type OrderRequest, type Ticker } from './types.js';

export interface PaperOpts { feePct: number; slippagePct: number; startUsdt: number; market?: MarketInfo; now?: () => number;
  /** Per-symbol exchange rules (min size / precision); without it every symbol uses `market`. */
  marketFor?: (symbol: string) => Promise<MarketInfo> }

/** Simulated fills on externally supplied prices (setPrice). Same interface as live. */
export class PaperAdapter implements ExchangeAdapter {
  private prices = new Map<string, Ticker>();
  private balances = new Map<string, number>();
  private fills = new Map<string, Fill>();
  private market: MarketInfo;
  private now: () => number;

  constructor(private o: PaperOpts) {
    this.balances.set('USDT', o.startUsdt);
    this.market = o.market ?? { minQty: 0.00001, minNotional: 5, qtyStep: 0.00001 };
    this.now = o.now ?? Date.now;
  }

  /** Simulated wallet, so a multi-week paper run survives restarts. */
  snapshot() { return { balances: [...this.balances] as [string, number][] }; }
  restore(s: { balances: [string, number][] }) { this.balances = new Map(s.balances); }

  setPrice(symbol: string, price: number, time = this.now()) { this.prices.set(symbol, { price, time }); }

  async getTicker(symbol: string): Promise<Ticker> {
    const t = this.prices.get(symbol);
    if (!t) throw new Error(`no price for ${symbol}`);
    return t;
  }

  async getMarket(symbol: string): Promise<MarketInfo> { return this.o.marketFor ? this.o.marketFor(symbol) : this.market; }
  async getBalance(asset: string) { return this.balances.get(asset) ?? 0; }
  async cancelAllOrders() { /* market orders fill instantly; nothing rests */ }

  async marketOrder(req: OrderRequest): Promise<Fill> {
    const prev = this.fills.get(req.clientOrderId);
    if (prev) return prev;

    const { price: mid, time } = await this.getTicker(req.symbol);
    const rules = await this.getMarket(req.symbol);
    const qty = floorToStep(req.qty, rules.qtyStep);
    if (!(qty >= rules.minQty)) throw new Error('qty below min after precision rounding');

    const [base, quote] = req.symbol.split('/') as [string, string];
    const buy = req.side === 'buy';
    const price = mid * (1 + (buy ? 1 : -1) * this.o.slippagePct / 100);
    const notional = qty * price;
    if (notional < rules.minNotional) throw new Error('notional below exchange minimum');
    const fee = notional * this.o.feePct / 100;

    const q = this.balances.get(quote) ?? 0;
    const b = this.balances.get(base) ?? 0;
    if (buy) {
      if (q < notional + fee) throw new Error('insufficient quote balance');
      this.balances.set(quote, q - notional - fee);
      this.balances.set(base, b + qty);
    } else {
      if (b < qty) throw new Error('insufficient base balance');
      this.balances.set(base, b - qty);
      this.balances.set(quote, q + notional - fee);
    }
    const fill: Fill = { clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side, qty, price, fee, time };
    this.fills.set(req.clientOrderId, fill);
    return fill;
  }
}
