import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  it('defaults to safe paper mode', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ TRADING_MODE: 'paper', BOT_CAPITAL_USDT: 50, RISK_PER_TRADE_PCT: 1, PAIR: 'BTC/USDT' });
  });
  it.each([{ RISK_PER_TRADE_PCT: '50' }, { BOT_CAPITAL_USDT: '-5' }, { PAIR: 'BTC/USD' }, { TRADING_MODE: 'yolo' }, { MAX_OPEN_POSITIONS: '0' }])('refuses bad config %j', (e) =>
    expect(() => loadConfig(e)).toThrow(/Invalid config/));
  it('live needs keys', () => {
    expect(() => loadConfig({ TRADING_MODE: 'live' })).toThrow(/API_KEY/);
    expect(loadConfig({ TRADING_MODE: 'live', EXCHANGE_API_KEY: 'k', EXCHANGE_API_SECRET: 's' }).TRADING_MODE).toBe('live');
  });
});
