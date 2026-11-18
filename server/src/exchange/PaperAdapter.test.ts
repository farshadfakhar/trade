import { describe, expect, it } from 'vitest';
import { PaperAdapter } from './PaperAdapter.js';
import { floorToStep } from './types.js';

const mk = () => { const p = new PaperAdapter({ feePct: 0.1, slippagePct: 0.05, startUsdt: 1000, now: () => 5 }); p.setPrice('BTC/USDT', 100); return p; };
const req = (o = {}) => ({ clientOrderId: 'a', symbol: 'BTC/USDT', side: 'buy' as const, qty: 1, ...o });

describe('PaperAdapter', () => {
  it('buy fills with slippage up and fee; balances update', async () => {
    const p = mk(); const f = await p.marketOrder(req());
    expect(f.price).toBeCloseTo(100.05); expect(f.fee).toBeCloseTo(0.100050); expect(f.time).toBe(5);
    expect(await p.getBalance('BTC')).toBe(1);
    expect(await p.getBalance('USDT')).toBeCloseTo(1000 - 100.05 - 0.10005);
  });
  it('sell fills with slippage down and fee', async () => {
    const p = mk(); await p.marketOrder(req());
    const f = await p.marketOrder(req({ clientOrderId: 'b', side: 'sell' }));
    expect(f.price).toBeCloseTo(99.95); expect(await p.getBalance('BTC')).toBe(0);
  });
  it('is idempotent on clientOrderId', async () => {
    const p = mk(); const a = await p.marketOrder(req()); const b = await p.marketOrder(req());
    expect(b).toBe(a); expect(await p.getBalance('BTC')).toBe(1);
  });
  it('rejects insufficient balances, tiny orders, missing price', async () => {
    const p = mk();
    await expect(p.marketOrder(req({ qty: 100 }))).rejects.toThrow(/insufficient quote/);
    await expect(p.marketOrder(req({ clientOrderId: 'c', side: 'sell' }))).rejects.toThrow(/insufficient base/);
    await expect(p.marketOrder(req({ clientOrderId: 'd', qty: 0.000001 }))).rejects.toThrow(/min/);
    await expect(p.marketOrder(req({ clientOrderId: 'e', qty: 0.01 }))).rejects.toThrow(/notional/);
    await expect(p.marketOrder(req({ clientOrderId: 'f', symbol: 'ETH/USDT' }))).rejects.toThrow(/no price/);
    await p.cancelAllOrders(); expect((await p.getMarket('BTC/USDT')).qtyStep).toBeGreaterThan(0);
  });
  it('snapshot/restore round-trips the simulated wallet', async () => {
    const p = mk(); await p.marketOrder(req());
    const q = mk(); q.restore(JSON.parse(JSON.stringify(p.snapshot())));
    expect(await q.getBalance('BTC')).toBe(1); expect(await q.getBalance('USDT')).toBeCloseTo(await p.getBalance('USDT'));
  });
  it('uses per-symbol exchange rules when given', async () => {
    const p = new PaperAdapter({ feePct: 0, slippagePct: 0, startUsdt: 1000, marketFor: async (s) => (s === 'ADA/USDT' ? { minQty: 1, minNotional: 1, qtyStep: 1 } : { minQty: 0.0001, minNotional: 1, qtyStep: 0.0001 }) });
    p.setPrice('ADA/USDT', 0.5);
    const f = await p.marketOrder({ clientOrderId: 'x', symbol: 'ADA/USDT', side: 'buy', qty: 10.7 });
    expect(f.qty).toBe(10); // whole coins only on this market
    expect(await p.getMarket('ADA/USDT')).toMatchObject({ qtyStep: 1 });
  });
  it('floorToStep handles float error', () => expect(floorToStep(0.3, 0.1)).toBe(0.3));
});
