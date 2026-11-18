import { useEffect, useState } from 'react';
import { Btn, Card, inputCls } from '../components/ui';
import { api, useLive } from '../api';

type Vals = Record<string, number | string[]>;
interface Settings { risk: Vals; strategy: Vals }
const riskLabels: Record<string, string> = { RISK_PER_TRADE_PCT: 'Risk per trade (%)', MAX_OPEN_POSITIONS: 'Max open positions', MAX_TRADES_PER_DAY: 'Max trades per day', DAILY_LOSS_LIMIT_PCT: 'Daily loss limit (%)', MAX_DRAWDOWN_PCT: 'Max drawdown kill switch (%)' };

export default function SettingsPage() {
  const { status: s } = useLive();
  const [d, setD] = useState<Settings>();
  const [msg, setMsg] = useState<{ ok: boolean; t: string }>();
  const [phrase, setPhrase] = useState('');
  useEffect(() => { api<Settings>('/settings').then(setD).catch((e) => setMsg({ ok: false, t: e.message })); }, []);
  if (!d || !s) return <div className="text-zinc-500">Loading…</div>;

  const set = (g: 'risk' | 'strategy', k: string, v: string) => setD({ ...d, [g]: { ...d[g], [k]: v === '' ? '' : Number(v) } } as Settings);
  const save = async () => {
    try { setD(await api<Settings>('/settings', { method: 'PUT', body: { risk: d.risk, strategy: d.strategy } })); setMsg({ ok: true, t: 'Saved (kept in memory until the server restarts).' }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); }
  };
  const field = (g: 'risk' | 'strategy', k: string, label: string) => (
    <label key={k} className="block text-sm"><span className="text-zinc-400">{label}</span><input className={`${inputCls} num mt-1`} type="number" step="any" disabled={s.running} value={String(d[g][k] ?? '')} onChange={(e) => set(g, k, e.target.value)} /></label>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Risk limits">
        <div className="grid grid-cols-2 gap-3">{Object.entries(riskLabels).map(([k, l]) => field('risk', k, l))}</div>
        <p className="mt-3 text-xs text-zinc-500">Bot capital: {s.limits.capital} USDT (set in .env only). Stop-loss is mandatory and cannot be turned off.</p>
      </Card>
      <Card title="Strategy: EMA/RSI trend (1h)">
        <div className="grid grid-cols-3 gap-3">{Object.keys(d.strategy).map((k) => field('strategy', k, k))}</div>
      </Card>
      <div className="flex items-center gap-3 lg:col-span-2">
        <Btn tone="green" disabled={s.running} onClick={save}>Save</Btn>
        {s.running && <span className="text-sm text-amber-400">Stop the bot to edit settings.</span>}
        {msg && <span className={`text-sm ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.t}</span>}
      </div>
      <Card title="LIVE trading" className="lg:col-span-2">
        {s.mode === 'paper' && <p className="text-sm text-zinc-400">The server is in <b className="text-sky-400">PAPER</b> mode. To trade real money, set <code>TRADING_MODE=live</code> and your Nobitex key in <code>.env</code> and restart, then confirm here. Only do that after the backtest and paper gates have passed.</p>}
        {s.mode === 'live' && (s.liveConfirmed
          ? <p className="text-sm text-red-400">LIVE confirmed for this session. Real orders will be placed.</p>
          : <div className="flex items-center gap-2"><input className={`${inputCls} w-56`} placeholder='Type "I UNDERSTAND"' value={phrase} onChange={(e) => setPhrase(e.target.value)} />
              <Btn tone="red" disabled={phrase !== 'I UNDERSTAND'} onClick={() => api('/live/confirm', { body: { text: phrase } }).catch((e) => setMsg({ ok: false, t: e.message }))}>Enable LIVE</Btn></div>)}
      </Card>
    </div>
  );
}
