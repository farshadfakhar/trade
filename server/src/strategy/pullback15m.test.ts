import { describe, expect, it } from 'vitest';
import { explainPullback15m, pullback15m } from './pullback15m.js';
import type { Candle, Position } from './types.js';

const M = 900_000, H = 3600_000;
const mk15 = (closes: number[], vols: number[]): Candle[] => closes.map((c, i) => ({ time: i * M, open: closes[i - 1] ?? c, high: c * 1.004, low: c * 0.996, close: c, volume: vols[i] ?? 1 }));
const hOf = (f: (i: number) => number): Candle[] => Array.from({ length: 260 }, (_, i) => ({ time: i * H, open: f(i), high: f(i) + 1, low: f(i) - 1, close: f(i), volume: 1 }));
const hUp = hOf((i) => 100 + i), hDown = hOf((i) => 400 - i);

// 300 candles of steady uptrend, a 5-candle dip (RSI < 40, above EMA100), then a bounce on high volume
const up = Array.from({ length: 300 }, (_, i) => 100 * Math.pow(1.0008, i));
const dip = (() => { let p = up.at(-1)!; return Array.from({ length: 5 }, () => (p *= 0.997)); })();
const closes = [...up, ...dip, dip.at(-1)! * 1.008];
const volumes = (last: number) => closes.map((_, i) => (i === closes.length - 1 ? last : 1));
const cs = mk15(closes, volumes(3));
const closeTime = cs.at(-1)!.time + M;
const s = pullback15m();
const pos: Position = { symbol: 'BTC/USDT', qty: 1, entry: 100, stop: 90, target: 110, cost: 100, entryTime: closeTime - M };

describe('pullback15m entry', () => {
  it('buys the trigger: stop is the closer of 6-candle low / 1.5 ATR, first target is 1.5R, half is scaled out', () => {
    const r = s.onCandle(cs, null, { htf: hUp });
    expect(r.action).toBe('buy');
    const entry = cs.at(-1)!.close, risk = entry - r.stop!;
    expect(r.stop!).toBeLessThan(entry); expect(risk / entry * 100).toBeLessThanOrEqual(2);
    expect(r.target!).toBeCloseTo(entry + 1.5 * risk, 6);
    expect(r.partial).toEqual({ fraction: 0.5 });
  });
  it('warms up without enough 15m or 1h history', () => {
    expect(s.onCandle(cs.slice(0, 50), null, { htf: hUp }).reason).toMatch(/not enough 15m/);
    expect(s.onCandle(cs, null, { htf: hUp.slice(0, 50) }).reason).toMatch(/not enough 1h/);
    expect(s.onCandle(cs, null).reason).toMatch(/not enough 1h/); // no htf at all
  });
  it('needs the 1h trend up', () => expect(s.onCandle(cs, null, { htf: hDown }).reason).toBe('1h trend is not up'));
  it('needs the volume confirmation', () => expect(s.onCandle(mk15(closes, volumes(1)), null, { htf: hUp }).reason).toMatch(/no trigger/));
  it('needs a prior pullback', () => expect(s.onCandle(mk15(up, []), null, { htf: hUp }).reason).toBe('no pullback inside the uptrend'));
  it('skips when the stop is too far, or the first target is too small to beat fees', () => {
    expect(pullback15m({ maxStopPct: 0.5 }).onCandle(cs, null, { htf: hUp }).reason).toMatch(/stop too far/);
    expect(pullback15m({ minTargetPct: 5 }).onCandle(cs, null, { htf: hUp }).reason).toMatch(/too small to beat fees/);
  });
  it('cooldown: blocks for 4 candles after a loss, then allows again', () => {
    expect(s.onCandle(cs, null, { htf: hUp, lastLossAt: closeTime - 2 * M }).reason).toBe('cooldown after a loss');
    expect(s.onCandle(cs, null, { htf: hUp, lastLossAt: closeTime - 4 * M }).action).toBe('buy');
  });
});

describe('pullback15m position management', () => {
  it('time stop after 16 candles; holds before that', () => {
    expect(s.onCandle(cs, { ...pos, entryTime: closeTime - 16 * M }, { htf: hUp }).action).toBe('sell');
    expect(s.onCandle(cs, { ...pos, entryTime: closeTime - 15 * M }, { htf: hUp })).toMatchObject({ action: 'hold', reason: 'in position' });
  });
  it('after the first target: trails the stop under EMA20, never below the current stop', () => {
    const r = s.onCandle(cs, { ...pos, partialDone: true, stop: 1 }, { htf: hUp });
    expect(r.action).toBe('hold'); expect(r.newStop!).toBeGreaterThan(1); expect(r.newStop!).toBeLessThan(cs.at(-1)!.close);
    expect(s.onCandle(cs, { ...pos, partialDone: true, stop: 1e9 }, { htf: hUp }).newStop).toBeUndefined();
  });
});

describe('explainPullback15m', () => {
  it('not ready while collecting history', () => expect(explainPullback15m(cs.slice(0, 20), hUp, {}, null).ready).toBe(false));
  it('all conditions met -> says it buys; otherwise names what is missing', () => {
    const ok: any = explainPullback15m(cs, hUp, {}, null);
    expect(ok.entry.every((c: any) => c.ok)).toBe(true); expect(ok.summary).toMatch(/All entry conditions are met/);
    const no: any = explainPullback15m(cs, hDown, {}, null);
    expect(no.entry[0].ok).toBe(false); expect(no.summary).toMatch(/1h uptrend/);
    const cool: any = explainPullback15m(cs, hUp, {}, null, closeTime - 2 * M);
    expect(cool.entry.at(-1).ok).toBe(false); expect(cool.entry.at(-1).detail).toMatch(/candle\(s\) ago/);
  });
  it('in position: describes stop, first target and time stop; after the partial, the trail', () => {
    const a: any = explainPullback15m(cs, hUp, {}, pos);
    expect(a.mode).toBe('in_position'); expect(a.exit).toHaveLength(3); expect(a.summary).toMatch(/sells 50% at 110/);
    const b: any = explainPullback15m(cs, hUp, {}, { ...pos, partialDone: true });
    expect(b.summary).toMatch(/trailing the rest/); expect(b.exit[1].ok).toBe(true);
    expect((explainPullback15m(cs, hUp, {}, { ...pos, entryTime: undefined }) as any).exit[2].detail).toBe('n/a');
  });
});
