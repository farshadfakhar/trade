import { ATR, EMA, RSI } from 'technicalindicators';
import type { Candle, Position, Signal, Strategy } from './types.js';

export interface PullbackParams { trend: number; rsiPeriod: number; rsiBuy: number; rsiExit: number; atrPeriod: number; stopAtr: number; targetAtr: number }
export const pullbackDefaults: PullbackParams = { trend: 200, rsiPeriod: 14, rsiBuy: 30, rsiExit: 55, atrPeriod: 14, stopAtr: 2, targetAtr: 4 };

/** Buy a dip inside an uptrend (close above EMA, RSI oversold); sell when RSI recovers. The ATR stop caps the loss. */
export function pullback(over: Partial<PullbackParams> = {}): Strategy {
  const p = { ...pullbackDefaults, ...over };
  const need = Math.max(p.trend, p.rsiPeriod, p.atrPeriod) + 2;
  return {
    onCandle(candles: Candle[], position: Position | null): Signal {
      if (candles.length < need) return { action: 'hold', reason: 'warming up' };
      const close = candles.map((x) => x.close);
      const rsi = RSI.calculate({ period: p.rsiPeriod, values: close }).at(-1)!;
      if (position) return rsi > p.rsiExit ? { action: 'sell', reason: `RSI ${rsi.toFixed(1)} recovered above ${p.rsiExit}` } : { action: 'hold', reason: 'in position' };
      if (rsi >= p.rsiBuy) return { action: 'hold', reason: 'not oversold' };
      const px = close[close.length - 1]!;
      if (px <= EMA.calculate({ period: p.trend, values: close }).at(-1)!) return { action: 'hold', reason: 'below trend filter' };
      const atr = ATR.calculate({ period: p.atrPeriod, high: candles.map((x) => x.high), low: candles.map((x) => x.low), close }).at(-1)!;
      return { action: 'buy', stop: px - p.stopAtr * atr, target: px + p.targetAtr * atr, reason: `dip in uptrend, RSI ${rsi.toFixed(1)}` };
    },
  };
}
