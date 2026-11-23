import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import bcrypt from 'bcryptjs';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';
import type { Report } from '../backtest/backtest.js';
import { settingsSchema, type Config, type Settings } from '../config/index.js';
import { shortPairs, type PaperShorts, type ShortPair } from '../execution/PaperShorts.js';
import type { Bot } from '../execution/Bot.js';
import type { Candle } from '../strategy/types.js';

export interface Store {
  trades(limit: number): Promise<Record<string, unknown>[]>;
  logs(level: string | undefined, limit: number): Promise<Record<string, unknown>[]>;
  equity(limit: number): Promise<{ at: Date; equity: number }[]>;
}
export interface BacktestReq { symbol: string; resolution?: string; from: number; to: number; strategy?: string; noFees?: boolean; params: Record<string, number> }
export interface Deps {
  cfg: Pick<Config, 'DASHBOARD_PASSWORD_HASH' | 'JWT_SECRET' | 'COOKIE_SECURE'> & { TRUST_PROXY?: boolean };
  bot: Bot; store: Store; staticDir?: string;
  paperShorts?: Record<ShortPair, PaperShorts>;
  candles(symbol: string, resolution: string): Promise<Candle[]>;
  backtest(r: BacktestReq): Promise<Report>;
  strategyView(): Promise<unknown>;
  assets(): Promise<unknown>;
  watchlist(): Promise<unknown>;
  settings: { get(): { risk: Required<Settings>; strategy: Record<string, number> }; set(risk: Settings, strategy: Record<string, number>): void };
  strategies(): unknown;
  scan: { get(): unknown; run(): 'started' | 'disabled' | 'busy' };
}

const pairSchema = z.string().regex(/^[A-Z0-9]+\/USDT$/, 'pair must look like BTC/USDT');
const paramsSchema = z.record(z.string(), z.number().min(0).max(100000)); // unknown names are rejected where they are applied (main.ts)
const btSchema = z.object({
  symbol: pairSchema, resolution: z.enum(['15', '60', '240', 'D']).optional(), strategy: z.string().optional(), noFees: z.boolean().optional(),
  from: z.string().transform(Date.parse), to: z.string().transform(Date.parse), params: paramsSchema.default({}),
}).refine((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.to > b.from && b.to - b.from <= 3.5 * 365 * 86400_000, 'from/to must be valid dates, at most 3.5 years apart');

// Text cells starting with = + - @ are neutralised against spreadsheet formula injection; numbers pass through.
const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const originHost = (o: string) => { try { return new URL(o).host; } catch { return ''; } };

export async function buildServer(d: Deps) {
  if (d.cfg.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  if (!d.cfg.DASHBOARD_PASSWORD_HASH) throw new Error('DASHBOARD_PASSWORD_HASH is not set (run: npm run hash-password -- <password>)');

  const app = Fastify({ logger: false, trustProxy: d.cfg.TRUST_PROXY ?? false });
  await app.register(cookie);
  await app.register(jwt, { secret: d.cfg.JWT_SECRET, cookie: { cookieName: 'token', signed: false }, sign: { expiresIn: '12h' } });
  await app.register(websocket);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(code).send({ error: code === 500 ? 'internal error' : err.message }); // never leak internals
  });

  // Everything except login requires a valid cookie session. WebSocket upgrades go through this hook too.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path === '/api/login' || !(path.startsWith('/api/') || path === '/ws')) return;
    try { await req.jwtVerify({ onlyCookie: true }); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
    // CSRF / cross-site WebSocket guard: SameSite=strict is same-SITE only, so also require a same-origin Origin on writes and on /ws.
    const o = req.headers.origin;
    if (o && (path === '/ws' || !['GET', 'HEAD'].includes(req.method)) && originHost(o) !== req.headers.host) return reply.code(403).send({ error: 'bad origin' });
  });

  const fails = new Map<string, { n: number; reset: number }>(); // shortcut: in-memory login throttle; use a shared store if you run >1 instance
  app.post('/api/login', async (req, reply) => {
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    const now = Date.now();
    for (const [k, v] of fails) if (v.reset <= now) fails.delete(k);
    const f = fails.get(req.ip) ?? { n: 0, reset: now + 15 * 60_000 };
    if (f.n >= 5) return reply.code(429).send({ error: 'too many attempts; try again later' });
    fails.set(req.ip, { n: f.n + 1, reset: f.reset }); // counted BEFORE the slow compare, so a burst of parallel guesses can't slip through
    if (!(await bcrypt.compare(password, d.cfg.DASHBOARD_PASSWORD_HASH))) return reply.code(401).send({ error: 'wrong password' });
    fails.delete(req.ip);
    reply.setCookie('token', app.jwt.sign({ u: 'admin' }), { httpOnly: true, sameSite: 'strict', secure: d.cfg.COOKIE_SECURE, path: '/', maxAge: 12 * 3600 });
    return { ok: true };
  });
  app.post('/api/logout', async (_r, reply) => { reply.clearCookie('token', { path: '/' }); return { ok: true }; });
  app.get('/api/me', async () => ({ ok: true }));

  const shortPair = z.object({ pair: z.enum(shortPairs) });
  if (d.paperShorts) {
    const shorts = d.paperShorts;
    app.get('/api/paper-shorts', async (req) => shorts[shortPair.parse(req.query).pair].status());
    app.post('/api/paper-shorts/start', async (req) => shorts[shortPair.parse(req.body).pair].start());
    app.post('/api/paper-shorts/stop', async (req) => shorts[shortPair.parse(req.body).pair].stop());
  }

  app.get('/api/status', async () => d.bot.status());

  app.post('/api/bot/start', async (_r, reply) => { try { d.bot.start(); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); } return d.bot.status(); });
  app.post('/api/bot/stop', async () => { d.bot.stop(); d.bot.pushStatus(); return d.bot.status(); });
  app.post('/api/bot/panic', async (req) => {
    const { marketClose } = z.object({ marketClose: z.boolean().default(false) }).parse(req.body ?? {});
    return { ...(await d.bot.panic(marketClose)), status: d.bot.status() };
  });
  app.post('/api/position/close', async (_r, reply) => {
    if (!d.bot.status().position) return reply.code(409).send({ error: 'no open position' });
    await d.bot.closeNow(); return d.bot.status();
  });
  app.post('/api/risk/reset-kill', async () => { d.bot.resetKill(); return d.bot.status(); });
  app.post('/api/problems/ack', async () => { d.bot.ackProblems(); return d.bot.status(); });
  app.post('/api/live/confirm', async (req, reply) => {
    const { text } = z.object({ text: z.string() }).parse(req.body);
    if (d.bot.status().mode !== 'live') return reply.code(409).send({ error: 'server is in PAPER mode; LIVE requires TRADING_MODE=live in .env and a restart' });
    if (text !== 'I UNDERSTAND') return reply.code(400).send({ error: 'type exactly: I UNDERSTAND' });
    d.bot.liveConfirmed = true; d.bot.pushStatus(); return d.bot.status();
  });

  app.get('/api/settings', async () => d.settings.get());
  app.put('/api/settings', async (req, reply) => {
    if (d.bot.running) return reply.code(409).send({ error: 'stop the bot before changing settings' });
    const body = z.object({ risk: settingsSchema.default({}), strategy: paramsSchema.default({}) }).parse(req.body);
    d.settings.set(body.risk, body.strategy);
    return d.settings.get();
  });

  app.get('/api/strategy', async () => d.strategyView());
  app.get('/api/strategies', async () => d.strategies());
  app.get('/api/scan', async () => d.scan.get());
  app.post('/api/scan/run', async (_r, reply) => {
    const r = d.scan.run();
    if (r === 'disabled') return reply.code(409).send({ error: 'AUTO_SCAN is off. Set AUTO_SCAN=true in .env and restart.' });
    if (r === 'busy') return reply.code(409).send({ error: 'a scan is already running' });
    return reply.code(202).send({ started: true });
  });
  app.get('/api/assets', async () => d.assets());
  app.get('/api/watchlist', async () => d.watchlist());

  const lim = (q: any, max = 1000) => Math.min(Number(q?.limit) || 200, max);
  app.get('/api/trades', async (req) => d.store.trades(lim(req.query)));
  app.get('/api/trades.csv', async (_r, reply) => {
    const rows = await d.store.trades(5000);
    const cols = ['at', 'symbol', 'entry', 'exit', 'qty', 'pnl', 'reason'];
    reply.header('Content-Type', 'text/csv').header('Content-Disposition', 'attachment; filename="trades.csv"');
    return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c])).join(','))].join('\n');
  });
  app.get('/api/logs', async (req) => d.store.logs(z.enum(['info', 'warn', 'error']).optional().parse((req.query as any)?.level), lim(req.query)));
  app.get('/api/equity', async (req) => d.store.equity(lim(req.query, 5000)));
  app.get('/api/candles', async (req) => {
    const q = z.object({ symbol: pairSchema, resolution: z.enum(['15', '60', '240', 'D']).default('60') }).parse(req.query);
    return d.candles(q.symbol, q.resolution);
  });

  let btBusy = false;
  app.post('/api/backtest', async (req, reply) => {
    const b = btSchema.parse(req.body);
    if (d.bot.running && d.bot.status().mode === 'live') return reply.code(409).send({ error: 'backtests are disabled while the live bot is running (shared exchange rate limit)' });
    if (btBusy) return reply.code(409).send({ error: 'a backtest is already running' });
    btBusy = true;
    try { return await d.backtest(b); } finally { btBusy = false; }
  });

  const clients = new Set<{ send(s: string): void; readyState: number }>();
  d.bot.on('event', (e) => { const m = JSON.stringify(e); for (const c of clients) if (c.readyState === 1) c.send(m); });
  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'status', ...d.bot.status() }));
    socket.on('close', () => clients.delete(socket));
  });

  if (d.staticDir) { // built dashboard + SPA fallback (API misses stay JSON 404s)
    await app.register(fastifyStatic, { root: d.staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'not found' })));
  }
  return app;
}
