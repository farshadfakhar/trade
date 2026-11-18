import { useEffect, useState } from 'react';
import { Card, inputCls } from '../components/ui';
import { api, useLive } from '../api';

interface Row { id: number; at: string; level: string; kind: string; message: string; data: string }
const color: Record<string, string> = { error: 'text-red-400', warn: 'text-amber-400', info: 'text-zinc-400' };

export default function Logs() {
  const { tick } = useLive();
  const [level, setLevel] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    const load = () => api<Row[]>(`/logs?limit=300${level ? `&level=${level}` : ''}`).then(setRows).catch(() => {});
    load(); const t = setInterval(load, 5000); return () => clearInterval(t);
  }, [level, tick]);
  return (
    <Card title="Audit log: every signal, risk decision, order and error">
      <select className={`${inputCls} mb-3 w-40`} value={level} onChange={(e) => setLevel(e.target.value)}>
        <option value="">All levels</option><option value="info">info</option><option value="warn">warn (rejections)</option><option value="error">error</option>
      </select>
      <div className="max-h-[70vh] overflow-auto font-mono text-xs">
        {rows.map((r) => (
          <details key={r.id} className="border-t border-zinc-800 py-1">
            <summary className="cursor-pointer"><span className="text-zinc-600">{new Date(r.at).toLocaleString()}</span> <span className={color[r.level]}>{r.level.toUpperCase()}</span> <span className="text-zinc-500">{r.kind}</span> {r.message}</summary>
            <pre className="whitespace-pre-wrap p-2 text-zinc-500">{r.data}</pre>
          </details>))}
        {!rows.length && <div className="p-4 text-zinc-500">Nothing logged yet.</div>}
      </div>
    </Card>
  );
}
