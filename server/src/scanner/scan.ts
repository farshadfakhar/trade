import type { Report } from '../backtest/backtest.js';
import type { Candle } from '../strategy/types.js';
import { filterUniverse, type UniverseCfg, type UsdtMarket } from './universe.js';

export interface ScanCfg extends UniverseCfg { minOosTrades: number; minOosPf: number; maxDdPct: number; minHistoryDays: number; lookbackDays: number; oosShare: number }
export interface Metrics { returnPct: number; trades: number; pf: number | null; ddPct: number; killed: boolean }
export interface CoinResult { symbol: string; volumeUsdt: number; spreadPct: number; historyDays: number; is?: Metrics; oos?: Metrics; passes: boolean; reasons: string[]; score: number }
export interface ScanResult { at: number; strategy: string; universe: number; scanned: number; results: CoinResult[]; best: string | null; cfg: ScanCfg }
export interface ScanDeps {
  markets(): Promise<UsdtMarket[]>;
  excluded(): Promise<Set<string>>;
  candles(symbol: string): Promise<Candle[]>;
  /** Backtest `candles` for `symbol`, trading from `fromMs` on (earlier candles are warm-up). */
  run(symbol: string, candles: Candle[], fromMs: number, spreadPct: number): Promise<Report>;
  now(): number;
}

const DAY = 86400_000;
const metrics = (r: Report): Metrics => ({ returnPct: r.returnPct, trades: r.trades, pf: r.profitFactor, ddPct: r.maxDrawdownPct, killed: r.killed });

/**
 * Walk-forward coin scan: the strategy runs UNCHANGED (no per-coin tuning, so fewer ways to overfit) on an earlier and a later
 * period. A coin must be profitable after fees in BOTH, with enough trades, a decent profit factor and a bounded drawdown in the later one.
 * Passing is a minimum bar, not a forecast.
 */
export async function scan(deps: ScanDeps, cfg: ScanCfg, strategy: string): Promise<ScanResult> {
  const universe = filterUniverse(await deps.markets(), await deps.excluded(), cfg);
  const results: CoinResult[] = [];
  for (const u of universe) {
    const base = { symbol: u.symbol, volumeUsdt: u.volumeUsdt, spreadPct: u.spreadPct };
    try {
      const all = await deps.candles(u.symbol);
      const win = all.filter((c) => c.time >= deps.now() - cfg.lookbackDays * DAY);
      const historyDays = win.length ? (win[win.length - 1]!.time - win[0]!.time) / DAY : 0;
      if (historyDays < cfg.minHistoryDays) { results.push({ ...base, historyDays, passes: false, score: -Infinity, reasons: [`only ${Math.round(historyDays)} days of history (need ${cfg.minHistoryDays})`] }); continue; }
      const start = win[0]!.time, cut = start + (win[win.length - 1]!.time - start) * (1 - cfg.oosShare);
      // everything before the window stays available to the backtest as indicator warm-up
      const is = metrics(await deps.run(u.symbol, all.filter((c) => c.time < cut), start, u.spreadPct));
      const oos = metrics(await deps.run(u.symbol, all, cut, u.spreadPct));
      const reasons: string[] = [];
      if (!(is.returnPct > 0)) reasons.push(`not profitable in the earlier period (${is.returnPct.toFixed(1)}%)`);
      if (!(oos.returnPct > 0)) reasons.push(`not profitable in the later period (${oos.returnPct.toFixed(1)}%)`);
      if (oos.trades < cfg.minOosTrades) reasons.push(`only ${oos.trades} trades in the later period (need ${cfg.minOosTrades})`);
      if (!((oos.pf ?? 0) >= cfg.minOosPf)) reasons.push(`profit factor ${oos.pf == null ? 'n/a' : oos.pf.toFixed(2)} below ${cfg.minOosPf}`);
      if (oos.ddPct > cfg.maxDdPct) reasons.push(`drawdown ${oos.ddPct.toFixed(1)}% above ${cfg.maxDdPct}%`);
      if (oos.killed) reasons.push('the kill switch would have tripped');
      const passes = reasons.length === 0;
      results.push({ ...base, historyDays, is, oos, passes, reasons: passes ? ['passes every gate'] : reasons, score: passes ? oos.returnPct : -Infinity });
    } catch (e) { results.push({ ...base, historyDays: 0, passes: false, score: -Infinity, reasons: [`scan failed: ${e instanceof Error ? e.message : String(e)}`] }); }
  }
  results.sort((a, b) => (b.passes ? 1 : 0) - (a.passes ? 1 : 0) || b.score - a.score || b.volumeUsdt - a.volumeUsdt);
  return { at: deps.now(), strategy, universe: universe.length, scanned: results.length, results, best: results.find((r) => r.passes)?.symbol ?? null, cfg };
}

/** Keep the current coin while it still passes (no churn); otherwise the best passing coin; otherwise none (stay in cash). */
export function choose(r: ScanResult, current: string | null): string | null {
  if (current && r.results.some((x) => x.symbol === current && x.passes)) return current;
  return r.best;
}
