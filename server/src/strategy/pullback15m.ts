import { ATR, EMA, RSI } from 'technicalindicators';
import type { Cond } from './emaRsiTrend.js';
import type { Candle, Position, Signal, Strategy, StrategyCtx } from './types.js';

export interface Pullback15mParams {
  htfTrend: number; htfSlopeLookback: number;       // 1h trend filter: close > EMA(htfTrend) and EMA now > EMA `htfSlopeLookback` candles ago
  rsiPeriod: number; rsiLevel: number; pullbackEma: number; triggerEma: number; volLen: number;
  atrPeriod: number; atrStop: number; lowLen: number; maxStopPct: number; // stop = closer of (lowest low of lowLen candles, entry - atrStop*ATR); skip if farther than maxStopPct
  minTargetPct: number; tpR: number; partialFraction: number;             // first target = tpR * risk; skip if it is closer than minTargetPct (fees)
  timeStopCandles: number; cooldownCandles: number;
}
export const pullback15mDefaults: Pullback15mParams = {
  htfTrend: 200, htfSlopeLookback: 10, rsiPeriod: 14, rsiLevel: 40, pullbackEma: 100, triggerEma: 20, volLen: 20,
  atrPeriod: 14, atrStop: 1.5, lowLen: 6, maxStopPct: 2, minTargetPct: 0.6, tpR: 1.5, partialFraction: 0.5, timeStopCandles: 16, cooldownCandles: 4,
};

const last = <T,>(a: T[], n = 1) => a[a.length - n]!;

/** Everything the strategy looks at on the latest CLOSED 15m candle (null while history is too short). */
export function analyze15m(candles: Candle[], htf: Candle[], p: Pullback15mParams) {
  if (candles.length < Math.max(p.pullbackEma, p.volLen, p.atrPeriod, p.rsiPeriod, p.triggerEma, p.lowLen) + 3) return { warm: false as const, need: 'not enough 15m candles' };
  if (htf.length < p.htfTrend + p.htfSlopeLookback + 2) return { warm: false as const, need: 'not enough 1h candles' };
  const close = candles.map((c) => c.close);
  const hEma = EMA.calculate({ period: p.htfTrend, values: htf.map((c) => c.close) });
  const rsi = RSI.calculate({ period: p.rsiPeriod, values: close });
  const ema100 = EMA.calculate({ period: p.pullbackEma, values: close });
  const ema20 = EMA.calculate({ period: p.triggerEma, values: close });
  const atr = last(ATR.calculate({ period: p.atrPeriod, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close }));
  const c = last(candles);
  const before = candles.slice(-1 - p.volLen, -1); // the 20 candles BEFORE this one, so the candle is not compared with itself
  const avgVol = before.reduce((a, x) => a + x.volume, 0) / before.length;
  const entry = c.close;
  const lowest = Math.min(...candles.slice(-p.lowLen).map((x) => x.low));
  const stop = Math.max(lowest, entry - p.atrStop * atr); // "whichever is closer" to entry
  const risk = entry - stop;
  const target = entry + p.tpR * risk;
  return {
    warm: true as const, c, entry, atr, stop, risk, target, avgVol, ema20: last(ema20),
    htfClose: last(htf).close, htfEma: last(hEma), htfEmaPrev: hEma[hEma.length - 1 - p.htfSlopeLookback]!,
    rsi: last(rsi), rsiPrev: last(rsi, 2), prevClose: last(close, 2), prevEma100: last(ema100, 2),
    stopPct: (risk / entry) * 100, targetPct: ((target - entry) / entry) * 100,
  };
}

const candleMsOf = (c: Candle[]) => c[c.length - 1]!.time - c[c.length - 2]!.time;

export function pullback15m(over: Partial<Pullback15mParams> = {}): Strategy {
  const p = { ...pullback15mDefaults, ...over };
  return {
    onCandle(candles: Candle[], position: Position | null, ctx: StrategyCtx = {}): Signal {
      const a = analyze15m(candles, ctx.htf ?? [], p);
      if (!a.warm) return { action: 'hold', reason: `warming up: ${a.need}` };
      const ms = candleMsOf(candles), closeTime = a.c.time + ms;

      if (position) {
        if (position.entryTime !== undefined && closeTime - position.entryTime >= p.timeStopCandles * ms) return { action: 'sell', reason: `time stop (${p.timeStopCandles} candles)` };
        // After the first target is taken, the stop is at breakeven (set by the executor) and trails under EMA20.
        if (position.partialDone && a.ema20 > position.stop && a.ema20 < a.entry) return { action: 'hold', reason: 'trailing under EMA20', newStop: a.ema20 };
        return { action: 'hold', reason: 'in position' };
      }

      if (ctx.lastLossAt !== undefined && closeTime - ctx.lastLossAt < p.cooldownCandles * ms) return { action: 'hold', reason: 'cooldown after a loss' };
      if (!(a.htfClose > a.htfEma && a.htfEma > a.htfEmaPrev)) return { action: 'hold', reason: '1h trend is not up' };
      if (!(a.rsiPrev < p.rsiLevel && a.prevClose > a.prevEma100)) return { action: 'hold', reason: 'no pullback inside the uptrend' };
      if (!(a.rsi >= p.rsiLevel && a.entry > a.ema20 && a.c.volume > a.avgVol)) return { action: 'hold', reason: 'no trigger (RSI cross up, close above EMA20, volume above average)' };
      if (!(a.risk > 0) || a.stopPct > p.maxStopPct) return { action: 'hold', reason: `stop too far (${a.stopPct.toFixed(2)}% > ${p.maxStopPct}%)` };
      if (a.targetPct < p.minTargetPct) return { action: 'hold', reason: `first target ${a.targetPct.toFixed(2)}% is too small to beat fees (< ${p.minTargetPct}%)` };
      return { action: 'buy', stop: a.stop, target: a.target, partial: { fraction: p.partialFraction }, reason: `pullback trigger: RSI ${a.rsi.toFixed(1)}, stop ${a.stopPct.toFixed(2)}%, first target ${a.targetPct.toFixed(2)}%` };
    },
  };
}

const n2 = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** Plain-language view for the dashboard. */
export function explainPullback15m(candles: Candle[], htf: Candle[], over: Partial<Pullback15mParams>, position: Position | null, lastLossAt?: number) {
  const p = { ...pullback15mDefaults, ...over };
  const a = analyze15m(candles, htf, p);
  if (!a.warm) return { ready: false as const, summary: `Collecting history: ${a.need}.` };
  const ms = candleMsOf(candles), closeTime = a.c.time + ms;
  const facts = [`15m price ${n2(a.entry)} · RSI ${a.rsi.toFixed(1)} (prev ${a.rsiPrev.toFixed(1)}) · ATR ${n2(a.atr)}`, `1h close ${n2(a.htfClose)} vs EMA${p.htfTrend} ${n2(a.htfEma)} (was ${n2(a.htfEmaPrev)} ${p.htfSlopeLookback} candles ago)`];

  if (position) {
    const exit: Cond[] = [
      { label: 'Stop-loss', ok: false, detail: `Sells everything if price falls to ${n2(position.stop)}${position.partialDone ? ' (breakeven or trailing under EMA20)' : ''}` },
      position.partialDone
        ? { label: 'First target', ok: true, detail: 'Already taken: half was sold, the rest trails under EMA20' }
        : { label: `First target (sells ${p.partialFraction * 100}%)`, ok: false, detail: `At ${n2(position.target)}; then the stop moves to breakeven` },
      { label: `Time stop (${p.timeStopCandles} candles)`, ok: false, detail: position.entryTime ? `Sells everything at ${new Date(position.entryTime + p.timeStopCandles * ms).toLocaleTimeString()} if nothing else happened` : 'n/a' },
    ];
    return { ready: true as const, mode: 'in_position' as const, entry: [] as Cond[], exit, plan: null, price: a.entry, facts,
      summary: `Holding ${position.qty} ${position.symbol.split('/')[0]}. Stop ${n2(position.stop)}; ${position.partialDone ? 'first half already sold, trailing the rest' : `sells ${p.partialFraction * 100}% at ${n2(position.target)} then protects the rest`}; everything is sold after ${p.timeStopCandles} candles at the latest.` };
  }

  const cool = ctx(lastLossAt, closeTime, ms, p.cooldownCandles);
  const entry: Cond[] = [
    { label: `1h uptrend: close above EMA${p.htfTrend} and EMA rising`, ok: a.htfClose > a.htfEma && a.htfEma > a.htfEmaPrev, detail: `1h close ${n2(a.htfClose)} vs EMA ${n2(a.htfEma)}; EMA ${a.htfEma > a.htfEmaPrev ? 'rising' : 'not rising'}` },
    { label: `Pullback: RSI dipped below ${p.rsiLevel} while price stayed above EMA${p.pullbackEma}`, ok: a.rsiPrev < p.rsiLevel && a.prevClose > a.prevEma100, detail: `previous candle RSI ${a.rsiPrev.toFixed(1)}, close ${n2(a.prevClose)} vs EMA${p.pullbackEma} ${n2(a.prevEma100)}` },
    { label: `Trigger: RSI back above ${p.rsiLevel}, close above EMA${p.triggerEma}, volume above average`, ok: a.rsi >= p.rsiLevel && a.entry > a.ema20 && a.c.volume > a.avgVol, detail: `RSI ${a.rsi.toFixed(1)}; close ${n2(a.entry)} vs EMA${p.triggerEma} ${n2(a.ema20)}; volume ${a.c.volume.toFixed(3)} vs avg ${a.avgVol.toFixed(3)}` },
    { label: `Stop no farther than ${p.maxStopPct}% away`, ok: a.risk > 0 && a.stopPct <= p.maxStopPct, detail: `Would be ${a.stopPct.toFixed(2)}% (${n2(a.stop)})` },
    { label: `First target at least ${p.minTargetPct}% away (so fees stay small)`, ok: a.targetPct >= p.minTargetPct, detail: `Would be ${a.targetPct.toFixed(2)}% (${n2(a.target)})` },
    { label: `No cooldown (${p.cooldownCandles} candles after a loss)`, ok: cool.ok, detail: cool.detail },
  ];
  const missing = entry.filter((c) => !c.ok);
  return { ready: true as const, mode: 'flat' as const, entry, exit: [] as Cond[], price: a.entry, facts,
    plan: { entry: a.entry, stop: a.stop, target: a.target },
    summary: missing.length === 0
      ? `All entry conditions are met on the latest closed 15m candle. The bot buys if the risk limits allow: stop ${n2(a.stop)}, first target ${n2(a.target)}.`
      : `Not buying yet. Still waiting for: ${missing.map((c) => c.label).join('; ')}.` };
}

function ctx(lastLossAt: number | undefined, closeTime: number, ms: number, cooldown: number) {
  if (lastLossAt === undefined || closeTime - lastLossAt >= cooldown * ms) return { ok: true, detail: 'No recent loss' };
  return { ok: false, detail: `Last loss was ${Math.round((closeTime - lastLossAt) / ms)} candle(s) ago` };
}
