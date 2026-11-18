import { PaperAdapter } from '../exchange/PaperAdapter.js';
import type { MarketInfo } from '../exchange/types.js';
import { Executor } from '../execution/Executor.js';
import { RiskManager, type RiskConfig } from '../risk/RiskManager.js';
import type { Candle, Strategy } from '../strategy/types.js';

export interface BacktestCfg extends RiskConfig { SLIPPAGE_PCT: number }
export interface TradeRow { time: number; entry: number; exit: number; qty: number; pnl: number; reason: string }
export interface Report {
  symbol: string; from: number; to: number; candles: number; startEquity: number; endEquity: number;
  netPnl: number; returnPct: number; buyHoldPct: number; trades: number; winRate: number;
  profitFactor: number | null; maxDrawdownPct: number; sharpe: number; killed: boolean;
  equityCurve: { time: number; equity: number }[]; tradeList: TradeRow[];
}

const WINDOW = 400; // candles handed to the strategy (EMA200 needs ~200 + warm-up)

/** Same Strategy -> RiskManager -> Executor -> PaperAdapter path as live. */
export async function backtest(symbol: string, candles: Candle[], strategy: Strategy, cfg: BacktestCfg, market: MarketInfo, candleMs = 3600_000, from = 0, htf?: { candles: Candle[]; ms: number }): Promise<Report> {
  const adapter = new PaperAdapter({ feePct: cfg.FEE_PCT, slippagePct: cfg.SLIPPAGE_PCT, startUsdt: cfg.BOT_CAPITAL_USDT, market });
  const rm = new RiskManager(cfg);
  const tradeList: TradeRow[] = [];
  const ex = new Executor({
    adapter, rm, strategy, symbol, capital: cfg.BOT_CAPITAL_USDT, riskPct: cfg.RISK_PER_TRADE_PCT, feePct: cfg.FEE_PCT,
    setPrice: (s, p, t) => adapter.setPrice(s, p, t),
    sink: (k, d) => { if (k === 'trade') tradeList.push({ time: d.time as number, entry: d.entry as number, exit: d.exit as number, qty: d.qty as number, pnl: d.pnl as number, reason: d.reason as string }); },
  });

  const equityCurve: Report['equityCurve'] = [];
  const startIdx = candles.findIndex((c) => c.time >= from);
  const traded = startIdx < 0 ? [] : candles.slice(startIdx);
  let h = 0; // htf pointer: only higher-timeframe candles that had CLOSED by this candle's close
  for (let i = Math.max(startIdx, 0); startIdx >= 0 && i < candles.length; i++) {
    const c = candles[i]!;
    const closeTime = c.time + candleMs;
    adapter.setPrice(symbol, c.close, closeTime);
    let htfSlice: Candle[] | undefined;
    if (htf) { while (h < htf.candles.length && htf.candles[h]!.time + htf.ms <= closeTime) h++; htfSlice = htf.candles.slice(Math.max(0, h - 300), h); }
    await ex.onCandle(candles.slice(Math.max(0, i + 1 - WINDOW), i + 1), closeTime, undefined, undefined, htfSlice);
    equityCurve.push({ time: closeTime, equity: ex.equity(c.close) });
  }

  const start = cfg.BOT_CAPITAL_USDT;
  const end = equityCurve.at(-1)?.equity ?? start;
  let peak = start, maxDd = 0;
  const rets: number[] = [];
  let prev = start;
  for (const { equity } of equityCurve) { peak = Math.max(peak, equity); maxDd = Math.max(maxDd, (peak - equity) / peak * 100); rets.push(equity / prev - 1); prev = equity; }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const wins = tradeList.filter((t) => t.pnl > 0);
  const gl = tradeList.filter((t) => t.pnl <= 0).reduce((a, t) => a - t.pnl, 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  return {
    symbol, from: traded[0]?.time ?? 0, to: traded.at(-1)?.time ?? 0, candles: traded.length,
    startEquity: start, endEquity: end, netPnl: end - start, returnPct: (end / start - 1) * 100,
    buyHoldPct: traded.length ? (traded.at(-1)!.close / traded[0]!.close - 1) * 100 : 0,
    trades: tradeList.length, winRate: tradeList.length ? wins.length / tradeList.length * 100 : 0,
    profitFactor: gl > 0 ? gw / gl : null, maxDrawdownPct: maxDd,
    sharpe: sd > 0 ? mean / sd * Math.sqrt(365 * 86400_000 / candleMs) : 0,
    killed: rm.status(Date.now()).killed, equityCurve, tradeList,
  };
}
