export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number } // time = open time, epoch ms
export interface Position { symbol: string; qty: number; entry: number; stop: number; target: number; cost: number; stopRef?: string; entryTime?: number; partial?: { fraction: number }; partialDone?: boolean } // cost = USDT paid incl. fee
/** `target` = full take-profit, or the FIRST target when `partial` is set. `newStop` (on hold) raises the stop (trailing). */
export type Signal = { action: 'buy' | 'sell' | 'hold'; stop?: number; target?: number; reason: string; partial?: { fraction: number }; newStop?: number };
/** `htf` = higher-timeframe candles that had CLOSED by the time of the last candle (no look-ahead). `lastLossAt` = close time of the last losing trade. */
export interface StrategyCtx { htf?: Candle[]; lastLossAt?: number }
/** Receives CLOSED candles only (last = most recently closed). */
export interface Strategy { onCandle(candles: Candle[], position: Position | null, ctx?: StrategyCtx): Signal }
