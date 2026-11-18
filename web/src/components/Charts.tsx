import { CandlestickSeries, ColorType, LineSeries, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type ISeriesMarkersPluginApi, type Time } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { Candle, Position, TradeRow } from '../api';

const base = { layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#a1a1aa' }, grid: { vertLines: { color: '#27272a' }, horzLines: { color: '#27272a' } }, timeScale: { timeVisible: true }, autoSize: true } as const;
const ts = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export interface Overlay { name: string; color: string; data: { time: number; value: number }[] }

export function PriceChart({ candles, trades, position, overlays = [] }: { candles: Candle[]; trades: TradeRow[]; position: Position | null; overlays?: Overlay[] }) {
  const el = useRef<HTMLDivElement>(null);
  const r = useRef<{ chart: IChartApi; k: ISeriesApi<'Candlestick'>; lines: ISeriesApi<'Line'>[]; pl: IPriceLine[]; markers?: ISeriesMarkersPluginApi<Time> }>();

  useEffect(() => {
    const chart = createChart(el.current!, base);
    const k = chart.addSeries(CandlestickSeries, { upColor: '#10b981', downColor: '#ef4444', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#ef4444' });
    r.current = { chart, k, lines: [], pl: [] };
    return () => chart.remove();
  }, []);

  useEffect(() => {
    const c = r.current; if (!c || !candles.length) return;
    c.k.setData(candles.map((x) => ({ time: ts(x.time), open: x.open, high: x.high, low: x.low, close: x.close })));
    c.lines.forEach((l) => c.chart.removeSeries(l));
    c.lines = overlays.map((o) => {
      const l = c.chart.addSeries(LineSeries, { color: o.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      l.setData(o.data.map((d) => ({ time: ts(d.time), value: d.value })));
      return l;
    });
    // Exits only: the DB stores no entry time. Snap each exit to the candle it happened in.
    const t0 = candles[0]!.time;
    const markers = trades.filter((t) => Date.parse(t.at) >= t0).map((t) => {
      const when = Date.parse(t.at); const cand = [...candles].reverse().find((x) => x.time <= when)!;
      return { time: ts(cand.time), position: 'aboveBar' as const, color: t.pnl >= 0 ? '#10b981' : '#ef4444', shape: 'arrowDown' as const, text: `${t.reason} ${t.pnl.toFixed(2)}` };
    }).sort((a, b) => a.time - b.time);
    if (c.markers) c.markers.setMarkers(markers); else c.markers = createSeriesMarkers(c.k, markers);
  }, [candles, trades, overlays]);

  useEffect(() => {
    const c = r.current; if (!c) return;
    c.pl.forEach((l) => c.k.removePriceLine(l)); c.pl = [];
    if (position) {
      const line = (price: number, color: string, title: string) => c.pl.push(c.k.createPriceLine({ price, color, lineStyle: 2, lineWidth: 1, title }));
      line(position.entry, '#a1a1aa', 'bought'); line(position.stop, '#ef4444', 'stop-loss'); line(position.target, '#10b981', 'target');
    }
  }, [position]);

  return <div ref={el} className="h-[420px] w-full" />;
}

export function LineChart({ series, height = 220 }: { series: { name: string; color: string; data: { time: number; value: number }[] }[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chart = createChart(el.current!, base);
    for (const s of series) {
      const l = chart.addSeries(LineSeries, { color: s.color, lineWidth: 2, title: s.name });
      // lightweight-charts needs strictly ascending, unique times
      const seen = new Set<number>();
      l.setData(s.data.map((d) => ({ time: ts(d.time), value: d.value })).filter((d) => !seen.has(d.time) && !!seen.add(d.time)).sort((a, b) => a.time - b.time));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series]);
  return <div ref={el} style={{ height }} className="w-full" />;
}
