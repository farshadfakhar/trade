import { useEffect, useState } from 'react';
import { Btn, Card, inputCls } from './components/ui';
import { LiveCtx, api, useLiveSocket } from './api';
import Assets from './pages/Assets';
import Backtest from './pages/Backtest';
import Logs from './pages/Logs';
import Overview from './pages/Overview';
import Scanner from './pages/Scanner';
import Settings from './pages/Settings';
import Trades from './pages/Trades';

const tabs = { Overview, Scanner, Assets, Trades, Backtest, Logs, Settings } as const;
type Tab = keyof typeof tabs;

function Login({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const go = (e: React.FormEvent) => { e.preventDefault(); api('/login', { body: { password: pw } }).then(onOk).catch((x) => setErr(x.message)); };
  return (
    <form onSubmit={go} className="mx-auto mt-32 w-80"><Card title="Trading bot login">
      <input autoFocus type="password" className={inputCls} placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <div className="mt-2 text-sm text-red-400">{err}</div>}
      <Btn tone="green" className="mt-3 w-full" type="submit">Sign in</Btn>
    </Card></form>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('Overview');
  useEffect(() => { api('/me').then(() => setAuthed(true)).catch(() => setAuthed(false)); const u = () => setAuthed(false); window.addEventListener('unauth', u); return () => window.removeEventListener('unauth', u); }, []);
  const live = useLiveSocket(authed === true);
  if (authed === null) return null;
  if (!authed) return <Login onOk={() => setAuthed(true)} />;

  const s = live.status; const Page = tabs[tab];
  const act = (p: Promise<unknown>) => p.catch((e) => window.alert(e.message));
  const panic = () => {
    if (!window.confirm('PANIC: cancel all open orders and stop the bot?')) return;
    const marketClose = !!s?.position && window.confirm('Also sell the open position at market now?\n\nOK = sell, Cancel = keep the position.');
    act(api('/bot/panic', { body: { marketClose } }));
  };
  const stale = s && s.running && Date.now() - s.lastDataTime > 90_000;

  return (
    <LiveCtx.Provider value={live}>
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-2 backdrop-blur">
        <span title={s?.mode === 'live' ? 'LIVE: real money is being used' : 'PAPER: practice mode, pretend money on real prices'} className={`rounded px-2 py-1 text-xs font-bold tracking-wider ${s?.mode === 'live' ? 'bg-red-600 text-white' : 'bg-sky-600 text-white'}`}>{s ? (s.mode === 'live' ? 'LIVE · REAL MONEY' : 'PAPER · PRACTICE') : '…'}</span>
        <span className="text-sm">{s?.running ? <span className="text-emerald-400">● bot is running</span> : <span className="text-zinc-500">● bot is stopped</span>}</span>
        <span className={`text-sm ${live.connected ? 'text-zinc-500' : 'text-red-400'}`}>{live.connected ? 'live updates on' : 'connection lost'}</span>
        <span className={`text-xs ${stale || s?.lastError ? 'text-amber-400' : 'text-zinc-500'}`}>{s?.lastDataTime ? `data ${new Date(s.lastDataTime).toLocaleTimeString()}` : 'no data yet'}{s?.lastError ? ` · ${s.lastError}` : ''}</span>
        <nav className="ml-4 flex gap-1">{(Object.keys(tabs) as Tab[]).map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1 text-sm ${t === tab ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`}>{t}</button>)}</nav>
        <div className="ml-auto flex gap-2">
          {s?.running ? <Btn onClick={() => act(api('/bot/stop', { body: {} }))}>Stop</Btn> : <Btn tone="green" onClick={() => act(api('/bot/start', { body: {} }))}>Start</Btn>}
          <Btn tone="red" title="Emergency: stop the bot now" onClick={panic}>PANIC</Btn>
          <Btn onClick={() => api('/logout', { body: {} }).then(() => setAuthed(false))}>Sign out</Btn>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4"><Page /></main>
    </LiveCtx.Provider>
  );
}
