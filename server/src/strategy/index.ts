import { donchian } from './donchian.js';
import { emaRsiTrend } from './emaRsiTrend.js';
import { pullback } from './pullback.js';
import type { Strategy } from './types.js';

import { donchianDefaults } from './donchian.js';
import { defaultParams } from './emaRsiTrend.js';
import { pullbackDefaults } from './pullback.js';
import { pullback15m, pullback15mDefaults } from './pullback15m.js';

export interface StrategyInfo { make: (params: any) => Strategy; resolution: string; htfResolution?: string; defaults: Record<string, number> }

/** Selectable strategies: which candles they trade on, an optional higher-timeframe feed, and their default parameters. */
export const strategyInfo: Record<string, StrategyInfo> = {
  emaRsi: { make: emaRsiTrend, resolution: '60', defaults: { ...defaultParams } },
  donchian: { make: donchian, resolution: '240', defaults: { ...donchianDefaults } },
  pullback: { make: pullback, resolution: '240', defaults: { ...pullbackDefaults } },
  pullback15m: { make: pullback15m, resolution: '15', htfResolution: '60', defaults: { ...pullback15mDefaults } },
};
export const strategies: Record<string, (params: any) => Strategy> = Object.fromEntries(Object.entries(strategyInfo).map(([k, v]) => [k, v.make]));
