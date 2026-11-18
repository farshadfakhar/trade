import { ATR, EMA, RSI } from 'technicalindicators';
import type { Candle, Position, Signal, Strategy } from './types.js';

export interface EmaRsiParams { fast: number; slow: number; trend: number; rsiPeriod: number; rsiMin: number; rsiMax: number; atrPeriod: number; stopAtr: number; targetAtr: number }
export const defaultParams: EmaRsiParams = { fast: 20, slow: 50, trend: 200, rsiPeriod: 14, rsiMin: 45, rsiMax: 70, atrPeriod: 14, stopAtr: 1.5, targetAtr: 3 };

const last = (a: number[], n = 1) => a[a.length - n]!;

/** Indicator values at the latest closed candle (null while there is too little history). */
export function analyze(candles: Candle[], p: EmaRsiParams) {
  if (candles.length < p.trend + 2) return null;
  const close = candles.map((c) => c.close);
  const fast = EMA.calculate({ period: p.fast, values: close });
  const slow = EMA.calculate({ period: p.slow, values: close });
  return { // arrays are right-aligned; compare the last two bars
    px: last(close), fast: last(fast), slow: last(slow),
    up: last(fast, 2) <= last(slow, 2) && last(fast) > last(slow),
    down: last(fast, 2) >= last(slow, 2) && last(fast) < last(slow),
    trend: last(EMA.calculate({ period: p.trend, values: close })),
    rsi: last(RSI.calculate({ period: p.rsiPeriod, values: close })),
    atr: last(ATR.calculate({ period: p.atrPeriod, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close })),
  };
}

export function emaRsiTrend(over: Partial<EmaRsiParams> = {}): Strategy {
  const p = { ...defaultParams, ...over };
  return {
    onCandle(candles: Candle[], position: Position | null): Signal {
      const a = analyze(candles, p);
      if (!a) return { action: 'hold', reason: 'warming up' };
      if (position) return a.down ? { action: 'sell', reason: 'EMA fast crossed below slow' } : { action: 'hold', reason: 'in position' };
      if (!a.up) return { action: 'hold', reason: 'no crossover' };
      if (a.px <= a.trend) return { action: 'hold', reason: 'below EMA trend filter' };
      if (a.rsi < p.rsiMin || a.rsi > p.rsiMax) return { action: 'hold', reason: `RSI ${a.rsi.toFixed(1)} outside ${p.rsiMin}-${p.rsiMax}` };
      return { action: 'buy', stop: a.px - p.stopAtr * a.atr, target: a.px + p.targetAtr * a.atr, reason: `EMA cross up, RSI ${a.rsi.toFixed(1)}, ATR ${a.atr.toFixed(2)}` };
    },
  };
}

export interface Cond { label: string; ok: boolean; detail: string }
const n2 = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pct = (a: number, b: number) => `${(((a - b) / b) * 100).toFixed(2)}%`;

/** Plain-language view of what the strategy is waiting for, from the latest CLOSED candle. */
export function explainEmaRsi(candles: Candle[], over: Partial<EmaRsiParams>, position: Position | null) {
  const p = { ...defaultParams, ...over };
  const a = analyze(candles, p);
  if (!a) return { ready: false as const, summary: `Collecting history: needs ${p.trend + 2} closed candles, has ${candles.length}.` };

  const entry: Cond[] = [
    { label: `EMA${p.fast} crosses above EMA${p.slow} (on the latest closed candle)`, ok: a.up,
      detail: `EMA${p.fast} ${n2(a.fast)} vs EMA${p.slow} ${n2(a.slow)} (${pct(a.fast, a.slow)}). ` + (a.up ? 'It just crossed.' : a.fast < a.slow ? 'Waiting for the fast line to rise above the slow one.' : 'Already above; the bot only buys at the moment of crossing, so it waits for the next fresh cross.') },
    { label: `Price above EMA${p.trend} (long-term uptrend)`, ok: a.px > a.trend, detail: `Price ${n2(a.px)} vs EMA${p.trend} ${n2(a.trend)} (${pct(a.px, a.trend)})` },
    { label: `RSI(${p.rsiPeriod}) between ${p.rsiMin} and ${p.rsiMax}`, ok: a.rsi >= p.rsiMin && a.rsi <= p.rsiMax, detail: `RSI is ${a.rsi.toFixed(1)}` + (a.rsi > p.rsiMax ? ' (overbought: too hot)' : a.rsi < p.rsiMin ? ' (weak momentum)' : '') },
  ];
  const stop = a.px - p.stopAtr * a.atr, target = a.px + p.targetAtr * a.atr;
  const base = { ready: true as const, price: a.px, indicators: { fast: a.fast, slow: a.slow, trend: a.trend, rsi: a.rsi, atr: a.atr }, params: p,
    facts: [`Price ${n2(a.px)} · RSI ${a.rsi.toFixed(1)} · ATR ${n2(a.atr)}`, `EMA${p.fast} ${n2(a.fast)} · EMA${p.slow} ${n2(a.slow)} · EMA${p.trend} ${n2(a.trend)}`] };

  if (position) {
    const exit: Cond[] = [
      { label: 'Stop-loss', ok: false, detail: `Sells if price falls to ${n2(position.stop)} (${pct(position.stop, a.px)} from now)` },
      { label: 'Take-profit', ok: false, detail: `Sells if price rises to ${n2(position.target)} (${pct(position.target, a.px)} from now)` },
      { label: `EMA${p.fast} crosses below EMA${p.slow}`, ok: a.down, detail: `EMA${p.fast} ${n2(a.fast)} vs EMA${p.slow} ${n2(a.slow)} (${pct(a.fast, a.slow)}). Sells at the close of the candle where it crosses.` },
    ];
    return { ...base, mode: 'in_position' as const, entry: [], exit, plan: null,
      summary: `Holding ${position.qty} ${position.symbol.split('/')[0]}. It will sell at the first of: price ≤ ${n2(position.stop)} (stop-loss), price ≥ ${n2(position.target)} (take-profit), or EMA${p.fast} crossing below EMA${p.slow}.` };
  }
  const missing = entry.filter((c) => !c.ok);
  return { ...base, mode: 'flat' as const, entry, exit: [], plan: { entry: a.px, stop, target },
    summary: missing.length === 0
      ? `All entry conditions are met on the latest closed candle. The bot buys if the risk limits allow, with stop ${n2(stop)} and target ${n2(target)}.`
      : `Not buying yet. Still waiting for: ${missing.map((c) => c.label).join('; ')}. When all three are true on a closed candle it buys (stop ≈ ${n2(stop)}, target ≈ ${n2(target)} at today's price).` };
}
