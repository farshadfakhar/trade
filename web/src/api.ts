import { createContext, useContext, useEffect, useRef, useState } from 'react';

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch('/api' + path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (r.status === 401 && path !== '/login') window.dispatchEvent(new Event('unauth'));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

export interface Position { symbol: string; qty: number; entry: number; stop: number; target: number; cost: number; partial?: { fraction: number }; partialDone?: boolean }
export interface Status {
  mode: 'paper' | 'live'; running: boolean; liveConfirmed: boolean; symbol: string; lastDataTime: number; lastError: string;
  equity: number; realized: number; position: Position | null; problems: string[];
  risk: { killed: boolean; dailyHalted: boolean; dailyPnl: number; tradesToday: number; openPositions: number; peak: number; errors: number };
  limits: { dailyLossPct: number; maxDrawdownPct: number; maxTrades: number; capital: number };
}
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface TradeRow { id: number; at: string; symbol: string; entry: number; exit: number; qty: number; pnl: number; reason: string }

interface Live { status: Status | null; connected: boolean; tick: number }
export const LiveCtx = createContext<Live>({ status: null, connected: false, tick: 0 });
export const useLive = () => useContext(LiveCtx);

/** WebSocket with auto-reconnect. `tick` bumps on every trade/error/panic so pages can refetch. */
export function useLiveSocket(enabled: boolean): Live {
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const ws = useRef<WebSocket>();
  useEffect(() => {
    if (!enabled) return;
    let stop = false, timer: number;
    const open = () => {
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.current = s;
      s.onopen = () => setConnected(true);
      s.onclose = () => { setConnected(false); if (!stop) timer = window.setTimeout(open, 2000); };
      s.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.type === 'status') setStatus(e);
        else setTick((t) => t + 1);
      };
    };
    open();
    return () => { stop = true; clearTimeout(timer); ws.current?.close(); };
  }, [enabled]);
  return { status, connected, tick };
}

export const f2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '–' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const pnlColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400');
export const ema = (v: number[], p: number) => { const k = 2 / (p + 1); let e = v[0]!; return v.map((x, i) => (i === 0 ? e : (e = x * k + e * (1 - k)))); };
