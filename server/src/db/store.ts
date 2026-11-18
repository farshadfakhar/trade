import type { PrismaClient } from '@prisma/client';
import type { Sink } from '../execution/Executor.js';
import type { Candle } from '../strategy/types.js';

export async function loadCandles(db: PrismaClient, symbol: string, tf: string, from: number, to: number): Promise<Candle[]> {
  const rows = await db.candle.findMany({ where: { symbol, timeframe: tf, time: { gte: BigInt(from), lte: BigInt(to) } }, orderBy: { time: 'asc' } });
  return rows.map((r) => ({ time: Number(r.time), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

export async function saveCandles(db: PrismaClient, symbol: string, tf: string, candles: Candle[]) {
  if (!candles.length) return;
  const [a, b] = [candles[0]!.time, candles[candles.length - 1]!.time];
  await db.$transaction([
    db.candle.deleteMany({ where: { symbol, timeframe: tf, time: { gte: BigInt(a), lte: BigInt(b) } } }),
    db.candle.createMany({ data: candles.map((c) => ({ symbol, timeframe: tf, ...c, time: BigInt(c.time) })) }),
  ]);
}

/** Audit trail: every signal, risk decision, order, trade and error is persisted. Fire-and-forget; DB errors go to stderr. */
export function dbSink(db: PrismaClient): Sink {
  return (kind, d) => {
    const log = (level: string, message: string) => db.log.create({ data: { level, kind, message, data: JSON.stringify(d) } });
    const w: Promise<unknown>[] = [];
    if (kind === 'signal') w.push(db.signal.create({ data: { symbol: String(d.symbol), action: String(d.action), reason: String(d.reason), data: JSON.stringify(d) } }));
    if (kind === 'order') w.push(db.order.upsert({ where: { clientOrderId: String(d.clientOrderId) }, create: { clientOrderId: String(d.clientOrderId), symbol: String(d.symbol), side: String(d.side), qty: Number(d.qty), price: Number(d.price), fee: Number(d.fee) }, update: {} }));
    if (kind === 'trade') w.push(db.trade.create({ data: { symbol: String(d.symbol), entry: Number(d.entry), exit: Number(d.exit), qty: Number(d.qty), pnl: Number(d.pnl), reason: String(d.reason) } }));
    w.push(log(kind === 'error' ? 'error' : kind === 'risk' && d.approved === false ? 'warn' : 'info', kind === 'risk' ? (d.approved ? 'approved' : String(d.reason)) : kind));
    void Promise.all(w).catch((e) => console.error('audit write failed', e));
  };
}
