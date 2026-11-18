import { describe, expect, it } from 'vitest';
import { emaRsiTrend } from './emaRsiTrend.js';
import type { Candle, Position } from './types.js';

const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ time: i * 3600_000, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
// long uptrend, then a dip (fast < slow), then a recovery that crosses up while still above EMA200
const uptrend = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5);
const dip = Array.from({ length: 40 }, (_, i) => uptrend.at(-1)! - i * 0.8);
const rec = (n: number) => Array.from({ length: n }, (_, i) => dip.at(-1)! + (i + 1) * 3);
const pos: Position = { symbol: 'BTC/USDT', qty: 1, entry: 100, stop: 90, target: 120, cost: 100 };

describe('emaRsiTrend', () => {
  const s = emaRsiTrend({ rsiMax: 100, rsiMin: 0 });
  it('holds while warming up', () => expect(s.onCandle(mk([1, 2, 3]), null).reason).toBe('warming up'));
  it('buys on a cross-up with ATR stop/target at 1:2 risk/reward', () => {
    let hit: ReturnType<typeof s.onCandle> | undefined;
    for (let n = 1; n < 40 && !hit; n++) { const r = s.onCandle(mk([...uptrend, ...dip, ...rec(n)]), null); if (r.action === 'buy') hit = r; }
    expect(hit).toBeDefined();
    const px = hit!.target! - (hit!.target! - hit!.stop!) * 2 / 3; // entry
    expect(hit!.stop!).toBeLessThan(px);
    expect((hit!.target! - px) / (px - hit!.stop!)).toBeCloseTo(2, 6);
  });
  it('does not buy when RSI is outside the band', () => {
    const strict = emaRsiTrend({ rsiMax: 1 });
    for (let n = 1; n < 40; n++) expect(strict.onCandle(mk([...uptrend, ...dip, ...rec(n)]), null).action).toBe('hold');
  });
  it('does not buy below EMA200 even on a cross-up', () => {
    const down = Array.from({ length: 260 }, (_, i) => 300 - i * 0.5);
    const bounce = Array.from({ length: 15 }, (_, i) => down.at(-1)! + (i + 1) * 0.1);
    for (let n = 1; n < 15; n++) expect(emaRsiTrend({ rsiMin: 0, rsiMax: 100 }).onCandle(mk([...down, ...bounce.slice(0, n)]), null).action).toBe('hold');
  });
  it('sells on cross-down only when in a position', () => {
    const fall = [...uptrend, ...Array.from({ length: 30 }, (_, i) => uptrend.at(-1)! - (i + 1) * 3)];
    let sold = false, boughtWhileFlat = false;
    for (let n = 262; n <= fall.length; n++) {
      if (s.onCandle(mk(fall.slice(0, n)), pos).action === 'sell') sold = true;
      if (s.onCandle(mk(fall.slice(0, n)), null).action === 'sell') boughtWhileFlat = true;
    }
    expect(sold).toBe(true); expect(boughtWhileFlat).toBe(false);
  });
  it('holds in position without a cross-down', () => expect(s.onCandle(mk(uptrend), pos).action).toBe('hold'));
});

import { explainEmaRsi } from './emaRsiTrend.js';
describe('explainEmaRsi', () => {
  it('says it is still collecting history', () => {
    const e = explainEmaRsi(mk([1, 2, 3]), {}, null);
    expect(e.ready).toBe(false); expect(e.summary).toMatch(/needs 202/);
  });
  it('flat: lists each entry condition with its status and the plan', () => {
    const e: any = explainEmaRsi(mk(uptrend), {}, null);
    expect(e.mode).toBe('flat'); expect(e.entry).toHaveLength(3);
    expect(e.entry[0].ok).toBe(false); expect(e.entry[0].detail).toMatch(/fresh cross/); // long uptrend: fast already above slow
    expect(e.entry[1].ok).toBe(true);
    expect(e.plan.stop).toBeLessThan(e.plan.entry); expect(e.plan.target).toBeGreaterThan(e.plan.entry);
    expect(e.summary).toMatch(/Still waiting for: EMA20 crosses above EMA50/);
  });
  it('flat: says "waiting for the fast line" when fast is below slow, and says buy when all conditions hold', () => {
    const e: any = explainEmaRsi(mk([...uptrend, ...dip]), {}, null);
    expect(e.entry[0].detail).toMatch(/Waiting for the fast line/);
    const s = emaRsiTrend({ rsiMax: 100, rsiMin: 0 });
    for (let n = 1; n < 40; n++) {
      const cs = mk([...uptrend, ...dip, ...rec(n)]);
      if (s.onCandle(cs, null).action === 'buy') {
        const b: any = explainEmaRsi(cs, { rsiMax: 100, rsiMin: 0 }, null);
        expect(b.entry.every((c: any) => c.ok)).toBe(true); expect(b.summary).toMatch(/All entry conditions are met/); return;
      }
    }
    throw new Error('no buy found');
  });
  it('flags RSI too hot / too weak', () => {
    const hot: any = explainEmaRsi(mk(uptrend), { rsiMax: 10, rsiMin: 5 }, null);
    expect(hot.entry[2].ok).toBe(false); expect(hot.entry[2].detail).toMatch(/overbought/);
    const weak: any = explainEmaRsi(mk([...uptrend, ...dip]), { rsiMin: 90, rsiMax: 100 }, null);
    expect(weak.entry[2].detail).toMatch(/weak momentum/);
  });
  it('in position: shows stop, target and the cross-down rule', () => {
    const e: any = explainEmaRsi(mk(uptrend), {}, pos);
    expect(e.mode).toBe('in_position'); expect(e.exit).toHaveLength(3);
    expect(e.summary).toMatch(/Holding 1 BTC.*stop-loss.*take-profit/);
  });
});
