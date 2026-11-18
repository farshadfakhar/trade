import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from './db/client.js';
import { backtest } from './backtest/backtest.js';
import { buildServer, type Store } from './api/server.js';
import { loadConfig } from './config/index.js';
import { TF_SECONDS, fetchRecent } from './data/candles.js';
import { dbSink } from './db/store.js';
import { NobitexAdapter } from './exchange/NobitexAdapter.js';
import { PaperAdapter } from './exchange/PaperAdapter.js';
import type { ExchangeAdapter } from './exchange/types.js';
import { closedOnly } from './data/candles.js';
import { Bot } from './execution/Bot.js';
import { Executor, type Sink } from './execution/Executor.js';
import { RiskManager } from './risk/RiskManager.js';
import { choose, scan, type ScanResult } from './scanner/scan.js';
import { loadCandles } from './db/store.js';
import { getCandles } from './backtest/load.js';
import { explainEmaRsi } from './strategy/emaRsiTrend.js';
import { explainDonchian } from './strategy/donchian.js';
import { explainPullback15m } from './strategy/pullback15m.js';
import { strategyInfo } from './strategy/index.js';
import { loadForBacktest } from './backtest/load.js';
import { saveCandles } from './db/store.js';

const cfg = loadConfig();
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const symbol = cfg.PAIR;
const info = strategyInfo[cfg.STRATEGY]!;
const RES = info.resolution; // candles the strategy trades on
const HTF = info.htfResolution; // optional higher-timeframe trend feed
const feed = { baseUrl: cfg.NOBITEX_BASE_URL };
const market = { minQty: 0.000001, minNotional: 0.5, qtyStep: 0.000001 };

if (cfg.AUTO_SCAN && info.resolution === '15') throw new Error('AUTO_SCAN needs a strategy with years of candle history (emaRsi, donchian or pullback); Nobitex serves 15m candles for only ~7 days.');
// Public Nobitex data (markets, exchange rules). Works without an API key.
const publicNobitex = new NobitexAdapter({ baseUrl: cfg.NOBITEX_BASE_URL, apiKey: '', apiSecret: '', feePct: cfg.FEE_PCT });
const rulesFor = (s: string) => publicNobitex.getMarket(s).catch(() => market); // real min size / precision per coin; falls back to a generic rule if Nobitex is unreachable
const paper = cfg.TRADING_MODE === 'paper' ? new PaperAdapter({ feePct: cfg.FEE_PCT, slippagePct: cfg.SLIPPAGE_PCT, startUsdt: cfg.BOT_CAPITAL_USDT, market, marketFor: rulesFor }) : undefined;
const adapter: ExchangeAdapter = paper ?? new NobitexAdapter({ baseUrl: cfg.NOBITEX_BASE_URL, apiKey: cfg.EXCHANGE_API_KEY, apiSecret: cfg.EXCHANGE_API_SECRET, feePct: cfg.FEE_PCT });
const setPrice = paper ? (s: string, p: number, t: number) => paper.setPrice(s, p, t) : undefined;

const rm = new RiskManager({ ...cfg });
let params: Record<string, number> = { ...info.defaults };
const audit = dbSink(prisma);
let bot!: Bot;
const sink: Sink = (k, d) => { audit(k, d); bot.note(k, d); };
// Engine state survives restarts so a restart can't reset the daily limit, trade cap, kill switch or open position.
// Paper mode also saves its simulated wallet, but only resumes it if mode, strategy, pair and capital are unchanged.
const sig = { mode: cfg.TRADING_MODE, strategy: cfg.STRATEGY, symbol: cfg.AUTO_SCAN ? 'auto' : symbol, capital: cfg.BOT_CAPITAL_USDT };
let writes: Promise<unknown> = Promise.resolve();
const persist = () => {
  const value = JSON.stringify({ sig, rm: rm.snapshot(), ...executor.state(), paper: paper?.snapshot() });
  writes = writes.then(() => prisma.state.upsert({ where: { key: 'engine' }, create: { key: 'engine', value }, update: { value } })).catch((e) => { console.error('state write failed; stopping the bot so state cannot diverge', e); bot.stop(); });
};
const reserve = async (clientOrderId: string) => prisma.orderIntent.create({ data: { clientOrderId } }).then(() => true, () => false);
// ---- coin scanner state ----
const scanState: { running: boolean; last?: ScanResult; selected: string | null; error?: string } = { running: false, selected: null };
const entryBlock = cfg.AUTO_SCAN
  ? () => !scanState.last ? 'waiting for the first coin scan'
    : !scanState.selected ? 'no coin passes the scanner gates: staying in cash'
    : scanState.selected !== bot.symbol ? `scanner prefers ${scanState.selected}; switching when flat` : undefined
  : undefined;
const executor = new Executor({ adapter, rm, strategy: info.make(params), symbol, capital: cfg.BOT_CAPITAL_USDT, riskPct: cfg.RISK_PER_TRADE_PCT, feePct: cfg.FEE_PCT, sink, setPrice, persist, entryBlock, reserve: cfg.TRADING_MODE === 'live' ? reserve : undefined });
bot = new Bot({
  mode: cfg.TRADING_MODE, symbol, resolution: RES, tfMs: TF_SECONDS[RES]! * 1000, adapter, rm, executor, setPrice,
  fetchRecent: (s) => fetchRecent(s, RES, 450, feed),
  htf: HTF ? { resolution: HTF, fetch: (s) => fetchRecent(s, HTF, 450, feed) } : undefined,
  // Record every closed candle we see: Nobitex serves 15m history for only ~7 days, so this builds our own for future backtests.
  onClosed: (closed) => void saveCandles(prisma, bot.symbol, RES, closed.slice(-3)).catch((e) => console.error('candle record failed', e)),
  onEquity: (equity) => void prisma.equitySnapshot.create({ data: { equity } }).catch((e) => console.error('equity write failed', e)),
});

if (cfg.TRADING_MODE === 'live') {
  const saved = await prisma.state.findUnique({ where: { key: 'engine' } });
  if (saved) { const j = JSON.parse(saved.value); rm.restore(j.rm); executor.restore(j); if (executor.position) bot.adoptSymbol(executor.position.symbol); console.log('restored engine state from the database'); }
  try {
    const total = await (adapter.getTotalBalance ?? adapter.getBalance).call(adapter, 'usdt');
    // USDT in a tracked position is legitimately spent; everything else must still cover the bot's capital.
    if (total + (executor.position?.cost ?? 0) < cfg.BOT_CAPITAL_USDT) executor.problems.push(`exchange USDT balance ${total} (+ ${executor.position?.cost ?? 0} in the open position) is below BOT_CAPITAL_USDT ${cfg.BOT_CAPITAL_USDT}`);
  } catch (e) { executor.problems.push(`cannot reach the exchange with these API credentials: ${(e as Error).message}`); }
  await executor.reconcile(Date.now());
  for (const p of executor.problems) console.error('RECONCILE PROBLEM:', p);
} else {
  const saved = await prisma.state.findUnique({ where: { key: 'engine' } });
  const j = saved ? JSON.parse(saved.value) : undefined;
  if (j && j.paper && JSON.stringify(j.sig) === JSON.stringify(sig)) { rm.restore(j.rm); executor.restore(j); paper!.restore(j.paper); if (executor.position) bot.adoptSymbol(executor.position.symbol); console.log('resumed the paper-trading session from the database'); }
  else if (saved) { await prisma.state.deleteMany({ where: { key: 'engine' } }); console.log('settings changed since the last paper session: starting a fresh one'); }
}

const cache = new Map<string, { at: number; c: any }>(); // 30 s cache: Nobitex allows 60 candle requests/min
const candlesCached = async (s: string, res: string) => {
  const k = s + res, hit = cache.get(k);
  if (hit && Date.now() - hit.at < 30_000) return hit.c as Awaited<ReturnType<typeof fetchRecent>>;
  const c = await fetchRecent(s, res, 500, feed);
  cache.set(k, { at: Date.now(), c });
  return c;
};

// Read-only account view works in paper mode too, as long as a READ key is configured.
const reader = adapter instanceof NobitexAdapter ? adapter : cfg.EXCHANGE_API_KEY && cfg.EXCHANGE_API_SECRET ? new NobitexAdapter({ baseUrl: cfg.NOBITEX_BASE_URL, apiKey: cfg.EXCHANGE_API_KEY, apiSecret: cfg.EXCHANGE_API_SECRET, feePct: cfg.FEE_PCT }) : undefined;
let assetsCache: { at: number; v: unknown } | undefined;
const assets = async () => {
  if (!reader) return { configured: false };
  if (assetsCache && Date.now() - assetsCache.at < 60_000) return assetsCache.v;
  const wallets = await reader.getWallets();
  const prices = await reader.getUsdtPrices(wallets.map((w) => w.currency)).catch(() => ({} as Record<string, number>)); // prices are a nicety; balances still show
  const rows = wallets.map((w) => ({ ...w, valueUsdt: w.currency === 'usdt' ? w.total : prices[w.currency] ? w.total * prices[w.currency]! : null }));
  const v = { configured: true, mode: cfg.TRADING_MODE, botCoin: bot.symbol.split('/')[0]!.toLowerCase(), botCapital: cfg.BOT_CAPITAL_USDT, rows, totalUsdt: rows.reduce((a, r) => a + (r.valueUsdt ?? 0), 0), at: Date.now() };
  assetsCache = { at: Date.now(), v };
  return v;
};

const tfLabel = ({ '15': '15m', '60': '1h', '240': '4h', D: '1d' } as Record<string, string>)[RES]!;
/** Plain-language explanation of what the active strategy is waiting for on one coin. */
const explainFor = (closed: Awaited<ReturnType<typeof fetchRecent>>, htfClosed: Awaited<ReturnType<typeof fetchRecent>>, position: typeof executor.position): any =>
  cfg.STRATEGY === 'emaRsi' ? explainEmaRsi(closed, params, position)
  : cfg.STRATEGY === 'donchian' ? explainDonchian(closed, params, position)
  : cfg.STRATEGY === 'pullback15m' ? explainPullback15m(closed, htfClosed, params, position, executor.lastLossAt)
  : { ready: false, summary: `A plain-language explanation is not available yet for the "${cfg.STRATEGY}" strategy. The risk checks below still apply.` };

const strategyView = async () => {
  const now = Date.now();
  const symbol = bot.symbol;
  const closed = closedOnly(await candlesCached(symbol, RES), RES, now);
  const st = bot.status();
  const htfClosed = HTF ? closedOnly(await candlesCached(symbol, HTF), HTF, now) : [];
  const e = explainFor(closed, htfClosed, executor.position);
  const gate = (label: string, ok: boolean, detail: string) => ({ label, ok, detail });
  const gates = [
    gate('Bot is running', st.running, st.running ? 'Checking the market every 30 seconds' : 'Stopped: press Start'),
    gate('Kill switch (max drawdown)', !st.risk.killed, st.risk.killed ? 'ACTIVE: reset it manually' : `Peak ${st.risk.peak.toFixed(2)}, limit ${st.limits.maxDrawdownPct}%`),
    gate('Daily loss limit', !st.risk.dailyHalted, `Today ${st.risk.dailyPnl.toFixed(2)} USDT, halts at -${st.limits.dailyLossPct}%`),
    gate('Trades today', st.risk.tradesToday < st.limits.maxTrades, `${st.risk.tradesToday} of ${st.limits.maxTrades}`),
    gate('Open position slot free', st.risk.openPositions < rm.c.MAX_OPEN_POSITIONS, `${st.risk.openPositions} of ${rm.c.MAX_OPEN_POSITIONS} used`),
    gate('Nothing needs your attention', st.problems.length === 0, st.problems.join('; ') || 'OK'),
  ];
  const lastClosed = closed[closed.length - 1], ms = TF_SECONDS[RES]! * 1000;
  return { ...e, strategy: cfg.STRATEGY, params, symbol, timeframe: tfLabel, resolution: RES, running: st.running, gates, lastCandleClose: lastClosed ? lastClosed.time + ms : null, nextCandleClose: lastClosed ? lastClosed.time + 2 * ms : null };
};
// ---- coin scanner ----
const SCAN_LOOKBACK_DAYS = 900;
const scanCfg = { minVolumeUsdt: cfg.SCAN_MIN_VOLUME_USDT, maxSpreadPct: cfg.SCAN_MAX_SPREAD_PCT, topN: cfg.SCAN_TOP_N, minOosTrades: cfg.SCAN_MIN_OOS_TRADES, minOosPf: cfg.SCAN_MIN_OOS_PF, maxDdPct: cfg.SCAN_MAX_DD_PCT, minHistoryDays: 365, lookbackDays: SCAN_LOOKBACK_DAYS, oosShare: 0.4 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const saveScan = () => prisma.state.upsert({ where: { key: 'scan' }, create: { key: 'scan', value: JSON.stringify(scanState) }, update: { value: JSON.stringify(scanState) } }).catch((e) => console.error('scan state write failed', e));
const runScan = async () => {
  if (scanState.running) return;
  scanState.running = true; scanState.error = undefined; bot.note('scan', { running: true });
  try {
    const result = await scan({
      markets: () => publicNobitex.getUsdtMarkets(),
      excluded: () => publicNobitex.getExcludedCoins(),
      candles: async (s) => {
        const to = Date.now(), from = to - (SCAN_LOOKBACK_DAYS + 60) * 86400_000;
        await getCandles(prisma, cfg.NOBITEX_BASE_URL, s, RES, from, to); // bulk history, cached in SQLite
        await saveCandles(prisma, s, RES, await fetchRecent(s, RES, 120, feed)); // refresh the recent tail so the scan is current
        await sleep(1100); // stay under Nobitex's 60 candle requests/min
        return loadCandles(prisma, s, RES, from, to);
      },
      // a wider spread costs about half a spread on each side: add it to the backtest's slippage
      run: async (s, candles, fromMs, spreadPct) => backtest(s, candles, info.make(params), { ...cfg, SLIPPAGE_PCT: cfg.SLIPPAGE_PCT + spreadPct / 2, MAX_OPEN_POSITIONS: 1 }, await rulesFor(s), TF_SECONDS[RES]! * 1000, fromMs),
      now: Date.now,
    }, scanCfg, cfg.STRATEGY);
    scanState.last = result;
    scanState.selected = choose(result, executor.position ? executor.position.symbol : scanState.selected); // keep a coin we hold or already chose while it still passes (no churn)
    if (scanState.selected) bot.requestSymbol(scanState.selected);
    console.log(`scan done: ${result.results.filter((r) => r.passes).length}/${result.scanned} coins pass; selected ${scanState.selected ?? 'none (staying in cash)'}`);
  } catch (e) { scanState.error = (e as Error).message; console.error('scan failed', e); }
  finally { scanState.running = false; await saveScan(); bot.note('scan', { running: false }); bot.pushStatus(); }
};
if (cfg.AUTO_SCAN) {
  const saved = await prisma.state.findUnique({ where: { key: 'scan' } });
  if (saved) { const j = JSON.parse(saved.value); scanState.last = j.last; scanState.selected = j.selected ?? null; }
  const every = cfg.SCAN_INTERVAL_HOURS * 3600_000;
  const first = scanState.last ? Math.max(3000, scanState.last.at + every - Date.now()) : 3000;
  setTimeout(() => { void runScan(); setInterval(() => void runScan(), every); }, first);
  console.log(`AUTO_SCAN on: first scan in ${Math.round(first / 1000)} s, then every ${cfg.SCAN_INTERVAL_HOURS} h. No entries until a coin passes the gates.`);
}
const scanApi = {
  get: () => ({ enabled: cfg.AUTO_SCAN, running: scanState.running, error: scanState.error ?? null, selected: scanState.selected, current: bot.symbol, pending: bot.pendingSymbol ?? null, intervalHours: cfg.SCAN_INTERVAL_HOURS, last: scanState.last ?? null }),
  run: () => (!cfg.AUTO_SCAN ? 'disabled' as const : scanState.running ? 'busy' as const : (void runScan(), 'started' as const)),
};

// ---- beginner overview: one plain-language banner + the status of every coin the scanner approved ----
let wlCache: { at: number; v: unknown } | undefined;
const watchlist = async () => {
  if (wlCache && Date.now() - wlCache.at < 45_000) return wlCache.v;
  const now = Date.now(), st = bot.status(), sc = scanApi.get();
  const held = executor.position?.symbol;
  const approved = (sym: string) => !cfg.AUTO_SCAN || scanState.last?.results.find((r) => r.symbol === sym)?.passes === true;
  const names = cfg.AUTO_SCAN ? [...new Set([...(held ? [held] : []), ...(scanState.last?.results ?? []).filter((r) => r.passes).map((r) => r.symbol), bot.symbol, ...(scanState.last?.results ?? []).map((r) => r.symbol)])].slice(0, 12) : [bot.symbol];
  const rows: any[] = [];
  for (const sym of names) {
    const scanRes = scanState.last?.results.find((r) => r.symbol === sym);
    const row: any = { symbol: sym, role: !approved(sym) ? 'Not approved' : sym === bot.symbol ? 'Trading now' : 'Backup candidate', scan: scanRes ? { oosReturnPct: scanRes.oos?.returnPct ?? null, pf: scanRes.oos?.pf ?? null, trades: scanRes.oos?.trades ?? null, passes: scanRes.passes, reasons: scanRes.reasons } : null };
    if (!approved(sym) && executor.position?.symbol !== sym) { // failed the scan: no live analysis needed, just say why
      row.status = 'blocked'; row.trigger = null; row.missing = [];
      row.headline = `Not approved by the scanner, so the bot will not buy it. Reason: ${scanRes ? scanRes.reasons[0] : 'no scan result yet'}.`;
      rows.push(row); continue;
    }
    try {
      const all = await candlesCached(sym, RES);
      const closed = closedOnly(all, RES, now), price = all[all.length - 1]!.close;
      const pos = executor.position?.symbol === sym ? executor.position : null;
      const htfClosed = HTF && sym === bot.symbol ? closedOnly(await candlesCached(sym, HTF), HTF, now) : [];
      const e = explainFor(closed, htfClosed, pos);
      row.price = price; row.trigger = e.trigger ?? null; row.missing = (e.entry ?? []).filter((c: any) => !c.ok).map((c: any) => c.label);
      if (pos) { const u = pos.qty * price - pos.cost; row.status = 'holding'; row.headline = `The bot owns this coin right now (${u >= 0 ? 'up' : 'down'} ${Math.abs(u).toFixed(2)} USDT so far). It sells at the stop-loss, the trend end, or the target.`; }
      else if (!e.ready) { row.status = 'unknown'; row.headline = e.summary; }
      else if ((e.entry ?? []).length > 0 && e.entry.every((c: any) => c.ok)) { row.status = 'ready'; row.headline = sym === bot.symbol ? 'Looks good to buy. The bot buys when the current candle closes, if the safety limits allow.' : `Conditions are met, but the bot trades one coin at a time and is busy with ${bot.symbol}.`; }
      else { row.status = 'waiting'; row.headline = e.trigger ? `${e.trigger.label} (${e.trigger.awayPct.toFixed(1)}% away). Not time to buy yet.` : 'Not time to buy yet.'; }
    } catch (err) { row.status = 'unknown'; row.headline = `Could not load prices right now (${(err as Error).message}).`; }
    rows.push(row);
  }
  const coin = bot.symbol.split('/')[0];
  const banner = ((): { tone: string; title: string; text: string } => {
    if (st.problems.length) return { tone: 'bad', title: 'Needs your attention', text: st.problems.join(' ') };
    if (st.risk.killed) return { tone: 'bad', title: 'Safety stop is on', text: 'The bot lost 10% from its best point, so it stopped itself. Nothing trades until you reset it on the Overview page.' };
    if (!st.running) return { tone: 'warn', title: 'The bot is stopped', text: 'It is not watching the market. Press Start (top right) to begin.' };
    if (st.risk.dailyHalted) return { tone: 'wait', title: 'Paused for today', text: 'Daily loss limit reached. It continues tomorrow (UTC) to protect your money.' };
    if (st.position) return { tone: 'good', title: `In a trade: ${coin}`, text: `The bot bought ${coin} and is watching it. It will sell automatically at the stop-loss, when the trend ends, or at the target.` };
    if (cfg.AUTO_SCAN && sc.running && !sc.last) return { tone: 'wait', title: 'Scanning the market for the first time', text: 'It checks liquid coins and tests the strategy on each one. This takes a few minutes. No trades happen until it finishes.' };
    if (cfg.AUTO_SCAN && !scanState.selected) {
      const res = scanState.last?.results ?? [], killed = res.filter((r) => r.reasons.some((x) => /kill switch/.test(x))).length;
      const why = killed > 0 ? ` In ${killed} of ${res.length} coins the bot's safety stop would have triggered during the past test${rm.c.RISK_PER_TRADE_PCT > 2 ? `, which usually means the risk per trade (${rm.c.RISK_PER_TRADE_PCT}%) is too high` : ''}.` : '';
      return { tone: 'wait', title: 'Staying in cash: no coin looks good enough right now', text: `None of the scanned coins passed the safety tests, so the bot does nothing. This is safe, not a fault. It scans again automatically.${why}` };
    }
    const r0 = rows.find((r) => r.symbol === bot.symbol);
    if (r0?.status === 'ready') return { tone: 'good', title: `Ready to buy ${coin}`, text: 'The conditions are met. The bot buys when the current candle closes, if the safety limits allow.' };
    return { tone: 'wait', title: `Watching ${coin}, waiting for a good moment`, text: `Most of the time the bot does nothing. It only buys when its rules line up, and that can take days. Having no trades is normal.` };
  })();
  const advice: string[] = [];
  if (rm.c.RISK_PER_TRADE_PCT > 2) advice.push(`Risk per trade is ${rm.c.RISK_PER_TRADE_PCT}% of the bot's money. The recommended amount is 1%. At ${rm.c.RISK_PER_TRADE_PCT}%, just ${Math.ceil(rm.c.MAX_DRAWDOWN_PCT / rm.c.RISK_PER_TRADE_PCT)} losing trades in a row would trigger the safety stop. You can lower it in Settings.`);
  if (rm.c.MAX_OPEN_POSITIONS > 1 && cfg.AUTO_SCAN) advice.push(`"Max open positions" is ${rm.c.MAX_OPEN_POSITIONS}, but the bot trades one coin at a time, so only 1 is ever used.`);
  const v = { banner, advice, mode: cfg.TRADING_MODE, rows, scanner: { enabled: cfg.AUTO_SCAN, running: sc.running, lastScanAt: scanState.last?.at ?? null, nextScanAt: scanState.last ? scanState.last.at + cfg.SCAN_INTERVAL_HOURS * 3600_000 : null, selected: scanState.selected, strategy: cfg.STRATEGY, timeframe: tfLabel } };
  wlCache = { at: Date.now(), v };
  return v;
};

const store: Store = {
  trades: (n) => prisma.trade.findMany({ orderBy: { id: 'desc' }, take: n }),
  logs: (level, n) => prisma.log.findMany({ where: level ? { level } : {}, orderBy: { id: 'desc' }, take: n }),
  equity: (n) => prisma.equitySnapshot.findMany({ orderBy: { id: 'desc' }, take: n }).then((r) => r.reverse()),
};

const app = await buildServer({
  cfg, bot, store,
  staticDir: existsSync(webDist) ? webDist : undefined,
  candles: candlesCached, strategyView, assets, scan: scanApi, watchlist,
  backtest: async (r) => {
    const si = strategyInfo[r.strategy ?? cfg.STRATEGY];
    if (!si) throw Object.assign(new Error(`unknown strategy; choose one of: ${Object.keys(strategyInfo).join(', ')}`), { statusCode: 400 });
    const bad = Object.keys(r.params).filter((k) => !(k in si.defaults));
    if (bad.length) throw Object.assign(new Error(`unknown parameter(s) for this strategy: ${bad.join(', ')}`), { statusCode: 400 });
    const res = r.resolution ?? si.resolution;
    const { candles, htf } = await loadForBacktest(prisma, cfg.NOBITEX_BASE_URL, si, r.symbol, res, r.from, r.to);
    const base = (r.strategy ?? cfg.STRATEGY) === cfg.STRATEGY ? params : si.defaults; // the active strategy starts from its saved settings
    return backtest(r.symbol, candles, si.make({ ...base, ...r.params }), { ...cfg, ...(r.noFees ? { FEE_PCT: 0, SLIPPAGE_PCT: 0 } : {}), MAX_OPEN_POSITIONS: rm.c.MAX_OPEN_POSITIONS }, market, TF_SECONDS[res]! * 1000, r.from, htf);
  },
  strategies: () => ({ current: cfg.STRATEGY, saved: params, list: Object.fromEntries(Object.entries(strategyInfo).map(([k, v]) => [k, { resolution: v.resolution, htfResolution: v.htfResolution ?? null, defaults: v.defaults }])) }),
  settings: {
    get: () => ({ risk: { RISK_PER_TRADE_PCT: rm.c.RISK_PER_TRADE_PCT, MAX_OPEN_POSITIONS: rm.c.MAX_OPEN_POSITIONS, MAX_TRADES_PER_DAY: rm.c.MAX_TRADES_PER_DAY, DAILY_LOSS_LIMIT_PCT: rm.c.DAILY_LOSS_LIMIT_PCT, MAX_DRAWDOWN_PCT: rm.c.MAX_DRAWDOWN_PCT, }, strategy: params }),
    set: (risk, strategy) => {
      const bad = Object.keys(strategy).filter((k) => !(k in info.defaults));
      if (bad.length) throw Object.assign(new Error(`unknown parameter(s) for ${cfg.STRATEGY}: ${bad.join(', ')}`), { statusCode: 400 });
      Object.assign(rm.c, risk);
      if (risk.RISK_PER_TRADE_PCT !== undefined) executor.o.riskPct = risk.RISK_PER_TRADE_PCT;
      params = { ...params, ...strategy };
      executor.o.strategy = info.make(params);
      // shortcut: runtime settings are in-memory only and revert to .env/defaults on restart.
    },
  },
});

await app.listen({ host: cfg.HOST, port: cfg.PORT });
console.log(`dashboard API on http://${cfg.HOST}:${cfg.PORT} — mode: ${cfg.TRADING_MODE.toUpperCase()} — bot is STOPPED until you press Start`);
if (cfg.TRADING_MODE === 'live') console.warn('LIVE MODE. Cannot verify API-key permissions automatically: make sure the Nobitex key has READ+TRADE only (no WITHDRAW) and an IP whitelist.');

const shutdown = async () => { bot.stop(); await bot.drain(); persist(); await writes; await app.close(); await prisma.$disconnect(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
