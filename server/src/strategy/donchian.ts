import { ATR, EMA } from 'technicalindicators';
import type { Candle, Position, Signal, Strategy } from './types.js';

export interface DonchianParams { entryLen: number; exitLen: number; atrPeriod: number; stopAtr: number; targetAtr: number; trend: number /* 0 = no trend filter */ }
// Defaults = the variant that held up best on data it was not tuned on (4h, EMA200 filter). See the README for the evidence and its limits.
export const donchianDefaults: DonchianParams = { entryLen: 20, exitLen: 10, atrPeriod: 14, stopAtr: 2.5, targetAtr: 12, trend: 200 };

const max = (a: number[]) => a.reduce((x, y) => (y > x ? y : x), -Infinity);
const min = (a: number[]) => a.reduce((x, y) => (y < x ? y : x), Infinity);

/** Breakout trend following: buy a close above the N-candle high, exit on a close below the M-candle low. Winners run (far target); the ATR stop caps the loss. */
export function donchian(over: Partial<DonchianParams> = {}): Strategy {
  const p = { ...donchianDefaults, ...over };
  const need = Math.max(p.entryLen, p.exitLen, p.atrPeriod, p.trend) + 2;
  return {
    onCandle(candles: Candle[], position: Position | null): Signal {
      if (candles.length < need) return { action: 'hold', reason: 'warming up' };
      const c = candles[candles.length - 1]!;
      const before = candles.slice(0, -1); // channel excludes the current candle: no look-ahead
      if (position) {
        const low = min(before.slice(-p.exitLen).map((x) => x.low));
        return c.close < low ? { action: 'sell', reason: `close below ${p.exitLen}-candle low` } : { action: 'hold', reason: 'in position' };
      }
      const high = max(before.slice(-p.entryLen).map((x) => x.high));
      if (c.close <= high) return { action: 'hold', reason: 'no breakout' };
      if (p.trend > 0) {
        const t = EMA.calculate({ period: p.trend, values: candles.map((x) => x.close) });
        if (c.close <= t[t.length - 1]!) return { action: 'hold', reason: 'below trend filter' };
      }
      const atr = ATR.calculate({ period: p.atrPeriod, high: candles.map((x) => x.high), low: candles.map((x) => x.low), close: candles.map((x) => x.close) }).at(-1)!;
      return { action: 'buy', stop: c.close - p.stopAtr * atr, target: c.close + p.targetAtr * atr, reason: `breakout above ${p.entryLen}-candle high` };
    },
  };
}

const n2 = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: x < 10 ? 4 : 2, minimumFractionDigits: x < 10 ? 4 : 2 });
const pctOf = (a: number, b: number) => `${(((a - b) / b) * 100).toFixed(2)}%`;
export interface DonchianCond { label: string; ok: boolean; detail: string }

/** Plain-language view for the dashboard, from the latest CLOSED candle. */
export function explainDonchian(candles: Candle[], over: Partial<DonchianParams>, position: Position | null) {
  const p = { ...donchianDefaults, ...over };
  const need = Math.max(p.entryLen, p.exitLen, p.atrPeriod, p.trend) + 2;
  if (candles.length < need) return { ready: false as const, summary: `Collecting history: needs ${need} closed candles, has ${candles.length}.` };
  const c = candles[candles.length - 1]!, before = candles.slice(0, -1);
  const high = max(before.slice(-p.entryLen).map((x) => x.high)), low = min(before.slice(-p.exitLen).map((x) => x.low));
  const closes = candles.map((x) => x.close);
  const trend = p.trend > 0 ? EMA.calculate({ period: p.trend, values: closes }).at(-1)! : undefined;
  const atr = ATR.calculate({ period: p.atrPeriod, high: candles.map((x) => x.high), low: candles.map((x) => x.low), close: closes }).at(-1)!;
  const px = c.close, stop = px - p.stopAtr * atr, target = px + p.targetAtr * atr;
  const facts = [`Price ${n2(px)} · breakout level ${n2(high)} · exit level ${n2(low)}`, ...(trend ? [`Long-term average (EMA${p.trend}) ${n2(trend)}`] : [])];
  const base = { ready: true as const, price: px, facts, trigger: { label: `Buys if a candle closes above ${n2(high)}`, price: high, awayPct: ((high - px) / px) * 100 } };

  if (position) {
    const exit: DonchianCond[] = [
      { label: 'Stop-loss', ok: false, detail: `Sells if price falls to ${n2(position.stop)} (${pctOf(position.stop, px)} from now)` },
      { label: `Trend break: a candle closes below the lowest price of the last ${p.exitLen} candles`, ok: px < low, detail: `Exit level ${n2(low)} (${pctOf(low, px)} from now)` },
      { label: 'Take-profit', ok: false, detail: `Sells if price reaches ${n2(position.target)} (${pctOf(position.target, px)} from now). Usually the trend-break exit comes first.` },
    ];
    return { ...base, mode: 'in_position' as const, entry: [] as DonchianCond[], exit, plan: null,
      summary: `Holding ${position.qty} ${position.symbol.split('/')[0]}. It sells at the first of: stop-loss ${n2(position.stop)}, a candle closing below ${n2(low)} (trend ended), or the far target ${n2(position.target)}.` };
  }
  const entry: DonchianCond[] = [
    { label: `A candle closes above the highest price of the last ${p.entryLen} candles (a breakout)`, ok: px > high, detail: `Price ${n2(px)} vs breakout level ${n2(high)} (${pctOf(px, high)})` },
    ...(trend ? [{ label: `Price is above its long-term average (EMA${p.trend}): the bigger trend is up`, ok: px > trend, detail: `Price ${n2(px)} vs ${n2(trend)} (${pctOf(px, trend)})` }] : []),
  ];
  const missing = entry.filter((e) => !e.ok);
  return { ...base, mode: 'flat' as const, entry, exit: [] as DonchianCond[], plan: { entry: px, stop, target },
    summary: missing.length === 0
      ? `All entry conditions are met on the latest closed candle. The bot buys if the risk limits allow: stop ${n2(stop)}.`
      : `Not buying yet. It buys when the price breaks out above recent highs while the bigger trend is up. Still waiting for: ${missing.map((e) => e.label).join('; ')}.` };
}
