/** An order/stop was (maybe) sent but we could not learn what happened. Never retry blindly: a human must check the exchange. */
export class UnknownOutcomeError extends Error {}

export type Side = 'buy' | 'sell';

export interface MarketInfo { minQty: number; minNotional: number; qtyStep: number }
export interface Ticker { price: number; time: number } // time = epoch ms of the quote
export interface OrderRequest { clientOrderId: string; symbol: string; side: Side; qty: number }
export interface Fill { clientOrderId: string; symbol: string; side: Side; qty: number; price: number; fee: number; time: number }

export interface OrderInfo { state: 'open' | 'filled' | 'canceled'; filledQty: number; avgPrice: number }
/** Exchange-side protective stops. Absent on the paper adapter (stops are simulated from candles). */
export interface StopOrders {
  /** Places a sell stop-market; returns an exchange order ref to track/cancel it. */
  place(symbol: string, qty: number, stopPrice: number, clientOrderId: string): Promise<string>;
  status(ref: string): Promise<OrderInfo>;
  cancel(ref: string): Promise<void>;
}

/** Strategy code never sees this; only the executor (behind RiskManager) does. */
export interface ExchangeAdapter {
  getTicker(symbol: string): Promise<Ticker>;
  getMarket(symbol: string): Promise<MarketInfo>;
  /** Must be idempotent on clientOrderId: a repeat returns the original fill. */
  marketOrder(req: OrderRequest): Promise<Fill>;
  cancelAllOrders(): Promise<void>;
  getBalance(asset: string): Promise<number>; // spendable (excludes funds locked in orders)
  getTotalBalance?(asset: string): Promise<number>; // including locked funds
  stops?: StopOrders;
}

/** Floor qty to the exchange step (epsilon guards float error, e.g. 0.3/0.1). */
export function floorToStep(qty: number, step: number): number {
  const n = Math.floor(qty / step + 1e-9);
  return Number((n * step).toFixed(12));
}
