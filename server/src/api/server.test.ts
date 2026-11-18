import bcrypt from 'bcryptjs';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type Deps } from './server.js';

const hash = bcrypt.hashSync('correct horse battery', 4);
const secret = 'x'.repeat(32);

function fakeBot(over: Record<string, unknown> = {}) {
  const b: any = Object.assign(new EventEmitter(), {
    running: false, liveConfirmed: false,
    status: () => ({ mode: b.mode, running: b.running, position: b.position ?? null }),
    mode: 'paper', start() { if (b.failStart) throw new Error('kill switch'); b.running = true; }, stop() { b.running = false; },
    pushStatus() {}, ackProblems() { b.acked = true; }, panic: async (m: boolean) => ({ errors: [], m }), closeNow: async () => { b.position = null; }, resetKill() { b.reset = true; },
  }, over);
  return b;
}

function deps(bot = fakeBot()): Deps & { bot: any; calls: any } {
  const calls: any = { settings: [], bt: 0 };
  let risk: any = { RISK_PER_TRADE_PCT: 1, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_DAY: 5, DAILY_LOSS_LIMIT_PCT: 3, MAX_DRAWDOWN_PCT: 10 };
  return {
    calls, bot,
    cfg: { DASHBOARD_PASSWORD_HASH: hash, JWT_SECRET: secret, COOKIE_SECURE: false },
    store: {
      trades: async () => [{ at: new Date(0), symbol: 'BTC/USDT', entry: 1, exit: 2, qty: 3, pnl: -1.5, reason: '=cmd|x' }],
      logs: async (level) => [{ level }], equity: async () => [],
    },
    strategyView: async () => ({ summary: 'waiting' }), strategies: () => ({ current: 'emaRsi', list: {} }), scan: { get: () => ({ enabled: true }), run: () => (calls.scanRun?.() ?? 'started') }, assets: async () => ({ configured: false }), watchlist: async () => ({ banner: { tone: 'wait' }, rows: [] }),
    candles: async () => [], backtest: async (r) => { calls.bt++; return { trades: 0 } as any; },
    settings: { get: () => ({ risk, strategy: {} as any }), set: (r, s) => { risk = { ...risk, ...r }; calls.settings.push([r, s]); } },
  };
}

async function login(app: any) {
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct horse battery' } });
  return { r, cookie: r.headers['set-cookie'] as string };
}

describe('auth', () => {
  it('refuses to start with weak config', async () => {
    await expect(buildServer({ ...deps(), cfg: { ...deps().cfg, JWT_SECRET: 'short' } })).rejects.toThrow(/JWT_SECRET/);
    await expect(buildServer({ ...deps(), cfg: { ...deps().cfg, DASHBOARD_PASSWORD_HASH: '' } })).rejects.toThrow(/PASSWORD_HASH/);
  });
  it('protects every /api route and /ws without a session', async () => {
    const app = await buildServer(deps());
    for (const [m, u] of [['GET', '/api/status'], ['POST', '/api/bot/start'], ['POST', '/api/bot/panic'], ['GET', '/api/trades.csv'], ['PUT', '/api/settings'], ['POST', '/api/backtest'], ['GET', '/ws']] as const)
      expect((await app.inject({ method: m, url: u })).statusCode, `${m} ${u}`).toBe(401);
    const forged = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer abc' } });
    expect(forged.statusCode).toBe(401);
  });
  it('login: wrong password 401, right password sets an httpOnly strict cookie; throttles after 5 failures', async () => {
    const app = await buildServer(deps());
    const { r, cookie } = await login(app);
    expect(r.statusCode).toBe(200); expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Strict/i);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct horse battery' } })).statusCode).toBe(429);
  });
  it('logout clears the cookie', async () => {
    const app = await buildServer(deps());
    const { cookie } = await login(app);
    const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(out.headers['set-cookie']).toMatch(/token=;/);
  });
});

describe('routes (authenticated)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>, d: ReturnType<typeof deps>, h: { cookie: string };
  beforeAll(async () => { d = deps(); app = await buildServer(d); h = { cookie: (await login(app)).cookie }; });
  const call = (method: any, url: string, payload?: any) => app.inject({ method, url, headers: h, payload });

  it('status, start (409 when blocked), stop', async () => {
    expect((await call('GET', '/api/status')).json().mode).toBe('paper');
    expect((await call('POST', '/api/bot/start')).json().running).toBe(true);
    d.bot.failStart = true; d.bot.running = false;
    const r = await call('POST', '/api/bot/start'); expect(r.statusCode).toBe(409); expect(r.json().error).toMatch(/kill switch/);
    expect((await call('POST', '/api/bot/stop')).json().running).toBe(false);
  });
  it('panic, close position, reset kill', async () => {
    expect((await call('POST', '/api/bot/panic', { marketClose: true })).json().errors).toEqual([]);
    expect((await call('POST', '/api/position/close')).statusCode).toBe(409);
    d.bot.position = { qty: 1 }; expect((await call('POST', '/api/position/close')).statusCode).toBe(200);
    await call('POST', '/api/risk/reset-kill'); expect(d.bot.reset).toBe(true);
    expect((await call('POST', '/api/bot/panic', { marketClose: 'yes' })).statusCode).toBe(400);
  });
  it('rejects cross-origin writes (CSRF) but allows same-origin and no-Origin', async () => {
    const post = (origin?: string) => app.inject({ method: 'POST', url: '/api/bot/stop', headers: { ...h, ...(origin ? { origin, host: 'bot.example' } : {}) } });
    expect((await post('https://evil.example')).statusCode).toBe(403);
    expect((await post('not a url')).statusCode).toBe(403);
    expect((await post('https://bot.example')).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: { ...h, origin: 'https://evil.example', host: 'bot.example' } })).statusCode).toBe(200); // reads are not state-changing
  });
  it('serves the strategy explanation and assets only to a logged-in user', async () => {
    expect((await call('GET', '/api/strategy')).json().summary).toBe('waiting');
    expect((await call('GET', '/api/assets')).json().configured).toBe(false);
    expect((await call('GET', '/api/watchlist')).json().banner.tone).toBe('wait');
    expect((await app.inject({ url: '/api/watchlist' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/assets' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/strategy' })).statusCode).toBe(401);
  });
  it('scan: shows state; manual rescan starts, or explains why not', async () => {
    expect((await call('GET', '/api/scan')).json().enabled).toBe(true);
    expect((await call('POST', '/api/scan/run')).statusCode).toBe(202);
    d.calls.scanRun = () => 'disabled'; expect((await call('POST', '/api/scan/run')).json().error).toMatch(/AUTO_SCAN is off/);
    d.calls.scanRun = () => 'busy'; expect((await call('POST', '/api/scan/run')).statusCode).toBe(409);
    delete d.calls.scanRun;
    expect((await app.inject({ method: 'POST', url: '/api/scan/run' })).statusCode).toBe(401);
  });
  it('acknowledges reconciliation problems', async () => {
    await call('POST', '/api/problems/ack'); expect(d.bot.acked).toBe(true);
  });
  it('LIVE needs live server mode AND the exact phrase', async () => {
    expect((await call('POST', '/api/live/confirm', { text: 'I UNDERSTAND' })).statusCode).toBe(409); // paper server
    d.bot.mode = 'live';
    expect((await call('POST', '/api/live/confirm', { text: 'i understand' })).statusCode).toBe(400);
    expect((await call('POST', '/api/live/confirm', { text: 'I UNDERSTAND' })).statusCode).toBe(200);
    expect(d.bot.liveConfirmed).toBe(true);
  });
  it('settings validate bounds, reject unknown keys (e.g. capital) and refuse while running', async () => {
    expect((await call('PUT', '/api/settings', { risk: { RISK_PER_TRADE_PCT: 50 } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/settings', { risk: { BOT_CAPITAL_USDT: 99999 } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/settings', { strategy: { rsiMax: -1 } })).statusCode).toBe(400);
    const ok = await call('PUT', '/api/settings', { risk: { RISK_PER_TRADE_PCT: 0.5 }, strategy: { rsiMax: 65 } });
    expect(ok.json().risk.RISK_PER_TRADE_PCT).toBe(0.5);
    d.bot.running = true; expect((await call('PUT', '/api/settings', {})).statusCode).toBe(409); d.bot.running = false;
  });
  it('trades CSV neutralises formulas and keeps negative numbers', async () => {
    const r = await call('GET', '/api/trades.csv');
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.body).toContain(",-1.5,'=cmd|x"); expect(r.body.split('\n')[0]).toBe('at,symbol,entry,exit,qty,pnl,reason');
  });
  it('logs level filter, pair format, backtest validation and single-flight', async () => {
    expect((await call('GET', '/api/logs?level=error')).json()[0].level).toBe('error');
    expect((await call('GET', '/api/logs?level=bogus')).statusCode).toBe(400);
    expect((await call('GET', '/api/candles?symbol=DOGE/EUR')).statusCode).toBe(400);
    expect((await call('GET', '/api/candles?symbol=BTC/USDT')).statusCode).toBe(200);
    const bad = { symbol: 'BTC/USDT', from: '2020-01-01', to: '2026-01-01' }; // > 3.5y
    expect((await call('POST', '/api/backtest', bad)).statusCode).toBe(400);
    expect((await call('POST', '/api/backtest', { ...bad, symbol: 'not a pair', from: '2025-01-01' })).statusCode).toBe(400);
    expect((await call('POST', '/api/backtest', { ...bad, from: '2025-01-01' })).statusCode).toBe(200);
    expect(d.calls.bt).toBe(1);
    d.bot.running = true; d.bot.mode = 'live'; // shared rate limit with the live feed
    expect((await call('POST', '/api/backtest', { ...bad, from: '2025-01-01' })).statusCode).toBe(409);
    d.bot.running = false; d.bot.mode = 'paper';
  });
  it('hides internals on unexpected errors', async () => {
    d.store.equity = async () => { throw new Error('SELECT secret FROM db'); };
    const r = await call('GET', '/api/equity'); expect(r.statusCode).toBe(500); expect(r.body).not.toMatch(/secret/);
  });
});

describe('login throttle', () => {
  it('counts attempts before the slow compare: a parallel burst cannot exceed 5 guesses', async () => {
    const app = await buildServer(deps());
    const rs = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } })));
    expect(rs.filter((r) => r.statusCode === 401).length).toBe(5);
    expect(rs.filter((r) => r.statusCode === 429).length).toBe(7);
  });
});

describe('static dashboard', () => {
  it('serves the SPA publicly, falls back to index.html, keeps /api JSON 404s and auth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-')); writeFileSync(join(dir, 'index.html'), '<html>app</html>');
    const app = await buildServer({ ...deps(), staticDir: dir });
    expect((await app.inject({ url: '/' })).body).toContain('app');
    expect((await app.inject({ url: '/some/client/route' })).body).toContain('app');
    const nf = await app.inject({ url: '/api/nope' }); expect(nf.statusCode).toBe(401); // auth runs before routing
    const { cookie } = await login(app);
    const nf2 = await app.inject({ url: '/api/nope', headers: { cookie } }); expect(nf2.statusCode).toBe(404); expect(nf2.json().error).toBe('not found');
  });
});
