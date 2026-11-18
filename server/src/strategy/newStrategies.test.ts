import { describe, expect, it } from 'vitest';
import { donchian } from './donchian.js';
import { strategies } from './index.js';
import { pullback } from './pullback.js';
import type { Candle, Position } from './types.js';

const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ time: i * 3600_000, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
const pos: Position = { symbol: 'BTC/USDT', qty: 1, entry: 100, stop: 90, target: 200, cost: 100 };
const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);

describe('donchian', () => {
  const s = donchian({ entryLen: 20, exitLen: 10, trend: 0 });
  it('warms up', () => expect(s.onCandle(mk(flat(5)), null).reason).toBe('warming up'));
  it('buys a close above the prior 20-candle high, with ATR stop below and far target above', () => {
    const r = s.onCandle(mk([...flat(40), 110]), null);
    expect(r.action).toBe('buy'); expect(r.stop!).toBeLessThan(110); expect(r.target!).toBeGreaterThan(110 + 3);
  });
  it('does not count the current candle in its own channel (no look-ahead)', () => {
    // current high would be 101 > 100 close; close 100.5 is below prior highs of 101 -> no buy
    expect(s.onCandle(mk([...flat(40), 100.5]), null).action).toBe('hold');
  });
  it('trend filter blocks breakouts below the EMA', () => {
    const f = donchian({ trend: 30 });
    expect(f.onCandle(mk([...flat(40, 200), ...flat(20, 100), 103]), null).reason).toBe('below trend filter');
  });
  it('exits on a close below the prior 10-candle low, otherwise holds', () => {
    expect(s.onCandle(mk([...flat(40), 90]), pos).action).toBe('sell');
    expect(s.onCandle(mk([...flat(40), 100]), pos).action).toBe('hold');
  });
});

describe('pullback', () => {
  const up = Array.from({ length: 260 }, (_, i) => 100 + i);
  const s = pullback({ rsiBuy: 40 });
  it('warms up', () => expect(s.onCandle(mk([1, 2]), null).reason).toBe('warming up'));
  it('buys an oversold dip above the trend average', () => {
    const dip = [...up, ...Array.from({ length: 8 }, (_, i) => up.at(-1)! - (i + 1) * 4)];
    const r = s.onCandle(mk(dip), null);
    expect(r.action).toBe('buy'); expect(r.stop!).toBeLessThan(dip.at(-1)!); expect(r.target!).toBeGreaterThan(dip.at(-1)!);
  });
  it('does not buy when not oversold, or when below the trend average', () => {
    expect(s.onCandle(mk(up), null).reason).toBe('not oversold');
    const down = Array.from({ length: 260 }, (_, i) => 400 - i);
    expect(s.onCandle(mk(down), null).reason).toBe('below trend filter');
  });
  it('sells once RSI recovers, holds otherwise', () => {
    expect(s.onCandle(mk(up), pos).action).toBe('sell');
    const dip = [...up, ...Array.from({ length: 8 }, (_, i) => up.at(-1)! - (i + 1) * 4)];
    expect(s.onCandle(mk(dip), pos).action).toBe('hold');
  });
});

it('registry builds every strategy', () => {
  for (const k of ['emaRsi', 'donchian', 'pullback']) expect(strategies[k]!({}).onCandle(mk(flat(5)), null).action).toBe('hold');
});

import { explainDonchian } from './donchian.js';
describe('explainDonchian', () => {
  it('collecting history', () => expect(explainDonchian(mk(flat(5)), {}, null).ready).toBe(false));
  it('flat: breakout and trend conditions with the level the price must reach', () => {
    const e: any = explainDonchian(mk([...flat(250, 100), 100.5]), { trend: 0 }, null); // close 100.5 < prior high 101
    expect(e.mode).toBe('flat'); expect(e.entry).toHaveLength(1); expect(e.entry[0].ok).toBe(false);
    expect(e.trigger.price).toBe(101); expect(e.trigger.awayPct).toBeGreaterThan(0); expect(e.summary).toMatch(/Not buying yet/);
    const withTrend: any = explainDonchian(mk([...flat(250, 100), 100.5]), {}, null);
    expect(withTrend.entry).toHaveLength(2);
  });
  it('all conditions met -> says it buys', () => {
    const e: any = explainDonchian(mk([...Array.from({ length: 250 }, (_, i) => 50 + i * 0.2), 200]), {}, null);
    expect(e.entry.every((c: any) => c.ok)).toBe(true); expect(e.summary).toMatch(/All entry conditions are met/); expect(e.plan.stop).toBeLessThan(200);
  });
  it('in position: stop, trend-break and target', () => {
    const e: any = explainDonchian(mk(flat(250, 100)), {}, pos);
    expect(e.mode).toBe('in_position'); expect(e.exit).toHaveLength(3); expect(e.summary).toMatch(/Holding 1 BTC/);
  });
});
