import { loadConfig } from '../config/index.js';
import { TF_SECONDS } from '../data/candles.js';
import { prisma } from '../db/client.js';
import { strategyInfo } from '../strategy/index.js';
import { backtest, type Report } from './backtest.js';
import { loadForBacktest } from './load.js';

// usage: tsx src/backtest/cli.ts [--strategy emaRsi|donchian|pullback|pullback15m] [--symbol BTC/USDT] [--from 2024-01-01] [--to 2026-01-01]
//        [--resolution 60|240|D|15] [--split 2025-01-01] [--params '{"rsiMax":65}'] [--no-fees | --compare-fees] [--refresh]
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith('--')) args.set(argv[i]!.slice(2), argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i]!);

const cfg = loadConfig();
const name = args.get('strategy') ?? 'emaRsi';
const info = strategyInfo[name];
if (!info) throw new Error(`unknown strategy; choose one of: ${Object.keys(strategyInfo).join(', ')}`);
const symbol = args.get('symbol') ?? 'BTC/USDT';
const res = args.get('resolution') ?? info.resolution;
const tf = (r: string) => (TF_SECONDS[r] ?? (() => { throw new Error('resolution must be 15, 60, 240 or D'); })()) * 1000;
const ms = (d: string) => { const t = Date.parse(d); if (Number.isNaN(t)) throw new Error(`bad date ${d}`); return t; };
const candleMs = tf(res);
const to = ms(args.get('to') ?? new Date().toISOString().slice(0, 10));
const from = ms(args.get('from') ?? (res === '15' ? new Date(to - 6 * 86400_000).toISOString().slice(0, 10) : '2024-01-01'));

// Candles before `from` are fetched too, only as indicator warm-up.
const { candles, htf } = await loadForBacktest(prisma, cfg.NOBITEX_BASE_URL, info, symbol, res, from, to, args.has('refresh'), console.log);
const first = candles.find((c) => c.time >= from);
console.log(`${name} ${symbol} ${res}: ${candles.length} candles loaded, trading from ${first ? new Date(first.time).toISOString().slice(0, 16) : 'n/a'} to ${new Date(candles.at(-1)?.time ?? 0).toISOString().slice(0, 16)}`);
if (res === '15' && first && first.time > from + 86400_000) console.log('NOTE: Nobitex serves 15m candles for only the last ~7 days, so this is all the history that exists.');

const strategy = info.make(JSON.parse(args.get('params') ?? '{}'));
// Nobitex BTC/USDT rules; fine for backtests of other pairs too since sizes here are tiny.
const market = { minQty: 0.000001, minNotional: 0.5, qtyStep: 0.000001 };
const variants = args.has('compare-fees') ? [['WITH fees', cfg], ['WITHOUT fees', { ...cfg, FEE_PCT: 0, SLIPPAGE_PCT: 0 }]] as const : args.has('no-fees') ? [['WITHOUT fees', { ...cfg, FEE_PCT: 0, SLIPPAGE_PCT: 0 }]] as const : [['', cfg]] as const;
const show = (label: string, r: Report) => {
  const { equityCurve, tradeList, ...s } = r;
  console.log(`\n== ${label} ==`);
  console.table({ ...s, from: new Date(s.from).toISOString().slice(0, 16), to: new Date(s.to).toISOString().slice(0, 16) });
};

const split = args.get('split');
for (const [tag, c] of variants) {
  const t = (l: string) => (tag ? `${l} · ${tag}` : l);
  if (split) {
    const s = ms(split);
    show(t('IN-SAMPLE (tune here)'), await backtest(symbol, candles.filter((x) => x.time < s), strategy, c, market, candleMs, from, htf));
    show(t('OUT-OF-SAMPLE (judge here)'), await backtest(symbol, candles, strategy, c, market, candleMs, s, htf)); // earlier candles are warm-up only
  } else show(t('FULL RANGE'), await backtest(symbol, candles, strategy, c, market, candleMs, from, htf));
}
console.log('\nPast results are not a promise. Gate: profitable after fees, max DD < 20%, >= 50 trades, beats hold or has much lower DD, and holds out-of-sample.');
await prisma.$disconnect();
