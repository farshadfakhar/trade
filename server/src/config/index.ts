import { z } from 'zod';

const num = (min: number, max: number) => z.coerce.number().min(min).max(max);

const pair = z.string().regex(/^[A-Z0-9]+\/USDT$/, 'pairs must look like BTC/USDT');
const limits = {
  RISK_PER_TRADE_PCT: num(0.01, 5),
  MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(5),
  MAX_TRADES_PER_DAY: z.coerce.number().int().min(1).max(50),
  DAILY_LOSS_LIMIT_PCT: num(0.1, 10),
  MAX_DRAWDOWN_PCT: num(1, 30),
};
/** Risk limits editable at runtime from the dashboard (same bounds as .env). Capital is .env-only. */
export const settingsSchema = z.object({ ...limits }).partial().strict();
export type Settings = z.infer<typeof settingsSchema>;

const schema = z.object({
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  NOBITEX_BASE_URL: z.string().url().default('https://apiv2.nobitex.ir'), // testnet: https://testnetapiv2.nobitex.ir
  EXCHANGE_API_KEY: z.string().default(''), // Nobitex-Key (public)
  EXCHANGE_API_SECRET: z.string().default(''), // Ed25519 private key, URL-safe base64
  STRATEGY: z.enum(['emaRsi', 'donchian', 'pullback', 'pullback15m']).default('emaRsi'), // what the live/paper bot trades
  // Coin scanner (AUTO_SCAN=true): picks the coin to trade from liquid USDT markets, re-checked on a schedule.
  AUTO_SCAN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SCAN_INTERVAL_HOURS: num(1, 168).default(24),
  SCAN_MIN_VOLUME_USDT: z.coerce.number().min(0).default(100_000),
  SCAN_MAX_SPREAD_PCT: num(0.01, 5).default(0.3),
  SCAN_TOP_N: z.coerce.number().int().min(1).max(30).default(12),
  SCAN_MIN_OOS_TRADES: z.coerce.number().int().min(1).default(8),
  SCAN_MIN_OOS_PF: num(1, 10).default(1.2),
  SCAN_MAX_DD_PCT: num(1, 50).default(12),
  BOT_CAPITAL_USDT: z.coerce.number().positive().default(50),
  RISK_PER_TRADE_PCT: limits.RISK_PER_TRADE_PCT.default(1),
  MAX_OPEN_POSITIONS: limits.MAX_OPEN_POSITIONS.default(1),
  MAX_TRADES_PER_DAY: limits.MAX_TRADES_PER_DAY.default(5),
  DAILY_LOSS_LIMIT_PCT: limits.DAILY_LOSS_LIMIT_PCT.default(3),
  MAX_DRAWDOWN_PCT: limits.MAX_DRAWDOWN_PCT.default(10),
  PAIR: pair.default('BTC/USDT'), // the coin to trade; with AUTO_SCAN the scanner chooses instead
  STALE_DATA_SECONDS: z.coerce.number().positive().default(60),
  MAX_EXCHANGE_ERRORS: z.coerce.number().int().min(1).default(3),
  FEE_PCT: num(0, 1).default(0.13),
  SLIPPAGE_PCT: num(0, 1).default(0.05),
  // Dashboard server
  DASHBOARD_PASSWORD_HASH: z.string().default(''), // bcrypt; see `npm run hash-password`
  JWT_SECRET: z.string().default(''), // >= 32 chars; checked when the server starts
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'), // true only behind your own reverse proxy (Caddy), so login throttling sees real client IPs
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'), // false only for plain-http local dev
}).refine((c) => c.TRADING_MODE !== 'live' || (c.EXCHANGE_API_KEY && c.EXCHANGE_API_SECRET), {
  message: 'live mode requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET', path: ['EXCHANGE_API_KEY'],
});

export type Config = z.infer<typeof schema>;

/** Throws (bot refuses to start) on any invalid value. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error('Invalid config: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
