import { describe, expect, it } from 'vitest';
import { newPaperShortState, updateShorts } from './PaperShorts.js';
import type { Candle } from '../strategy/types.js';

const hour = 3_600_000, quarter = hour / 4, now = 60 * hour;
const bar = (time: number, close: number): Candle => ({ time, close, open: close, high: 101, low: 99, volume: 1 });
const hourly = Array.from({ length: 60 }, (_, i) => bar(i * hour, 160 - i));
const bars = Array.from({ length: 21 }, (_, i) => bar(now - (21 - i) * quarter, i === 20 ? 98.9 : 100));
const sample = { bid: 99, ask: 100.8, quoteTime: now, bars, hourly, market: { minQty: .001, minNotional: .5, qtyStep: .001 } };
const fee = .0013, slip = .0005;

describe('paper shorts', () => {
  it('skips expensive entries in the filtered book and closes baseline at the adjusted ask', () => {
    const state = newPaperShortState();
    const view = updateShorts(state, sample, now, fee, slip);
    expect(view.checks.every((check) => check.ok)).toBe(true);
    expect(view.costPct!).toBeGreaterThan(view.maxCostPct!);
    expect(view.nextClose).toBe(now + quarter);
    expect(state.baseline.position).not.toBeNull();
    expect(state.filtered).toMatchObject({ position: null, skipped: 1 });
    updateShorts(state, { ...sample, bars: [], hourly: [], bid: 94, ask: 94.5 }, now + 15_000, fee, slip);
    expect(state.baseline.position).toBeNull();
    const trade = state.baseline.trades[0]!;
    expect(trade.cover).toBeCloseTo(94.5 * (1 + slip));
    expect(trade.fees).toBeGreaterThan(0);
    expect(trade.net).toBeGreaterThan(0);
    expect(state.baseline.cash).toBeCloseTo(10 + trade.net);
  });

  it('rejects stale quotes and skips stale entry signals', () => {
    const state = newPaperShortState();
    expect(() => updateShorts(state, sample, now + 31_000, fee, slip)).toThrow('No fresh bid and ask');
    const view = updateShorts(state, { ...sample, quoteTime: now + 61_000 }, now + 61_000, fee, slip);
    expect(view.checks.at(-1)).toMatchObject({ label: 'The entry window is open', ok: false });
    expect(state.baseline.position).toBeNull();
  });
});
