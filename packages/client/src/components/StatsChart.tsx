import { useMemo, useState } from 'react';
import type { GameState, HistoryPoint } from '@monopoly/engine';

type Metric = 'netWorth' | 'rentReceived' | 'rentPaid';
const METRICS: { key: Metric; label: string }[] = [
  { key: 'netWorth', label: 'Net worth' },
  { key: 'rentReceived', label: 'Rent received' },
  { key: 'rentPaid', label: 'Rent paid' },
];

// Plot geometry in viewBox units; the SVG scales to the panel width.
const W = 320, H = 170, L = 40, R = 24, T = 10, B = 22;

const compact = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${n}`);

/** A rounded step (1, 2 or 5 × 10^k) so the gridlines land on readable values. */
function niceStep(max: number, lines = 4) {
  const raw = Math.max(max, 1) / lines;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
}

/** Line chart of one money measure per player across the turns, with a hover readout. */
export function StatsChart({ state, history }: { state: GameState; history: HistoryPoint[] }) {
  const [metric, setMetric] = useState<Metric>('netWorth');
  const [hover, setHover] = useState<number | null>(null);
  const players = state.turnOrder.map((id) => state.players.find((p) => p.id === id)!);

  const { x, y, ticks, maxTurn, minTurn } = useMemo(() => {
    const minTurn = history[0]?.turn ?? 1;
    const maxTurn = Math.max(history[history.length - 1]?.turn ?? 1, minTurn + 1);
    const max = Math.max(1, ...history.flatMap((h) => Object.values(h[metric])));
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    const x = (turn: number) => L + ((turn - minTurn) / (maxTurn - minTurn)) * (W - L - R);
    const y = (v: number) => T + (1 - v / top) * (H - T - B);
    return { x, y, ticks, maxTurn, minTurn };
  }, [history, metric]);

  if (history.length < 2) return <p className="muted small">The graph appears after the first turn.</p>;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const turn = minTurn + ((e.clientX - box.left) / box.width * W - L) / (W - L - R) * (maxTurn - minTurn);
    let best = 0;
    history.forEach((h, i) => { if (Math.abs(h.turn - turn) < Math.abs(history[best].turn - turn)) best = i; });
    setHover(best);
  };
  const point = hover !== null ? history[hover] : null;
  // Each line ends in its player's token, nudged apart so close finishes stay readable.
  const lastPoint = history[history.length - 1];
  const ends = players
    .map((p) => ({ p, y: y(lastPoint[metric][p.id] ?? 0) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 11);
  const overflow = ends.length ? Math.max(0, ends[ends.length - 1].y - (H - B)) : 0;
  for (const e of ends) e.y -= overflow;
  const label = METRICS.find((m) => m.key === metric)!.label;

  return (
    <div className="chart">
      <div className="chart-tabs" role="tablist" aria-label="Graph">
        {METRICS.map((m) => (
          <button key={m.key} role="tab" aria-selected={metric === m.key} className={metric === m.key ? 'on' : ''} onClick={() => setMetric(m.key)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} by turn for each player`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
              <text className="chart-axis" x={L - 5} y={y(t) + 3} textAnchor="end">{compact(t)}</text>
            </g>
          ))}
          <text className="chart-axis" x={L} y={H - 6} textAnchor="start">turn {minTurn}</text>
          <text className="chart-axis" x={W - R} y={H - 6} textAnchor="end">turn {maxTurn}</text>
          {point && <line className="chart-cross" x1={x(point.turn)} x2={x(point.turn)} y1={T} y2={H - B} />}
          {players.map((p) => {
            const d = history.map((h, i) => `${i ? 'L' : 'M'}${x(h.turn).toFixed(1)},${y(h[metric][p.id] ?? 0).toFixed(1)}`).join('');
            const last = history[history.length - 1];
            return (
              <g key={p.id}>
                <path d={d} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={p.bankrupt ? 0.45 : 1} />
                <circle className="chart-dot" cx={x(last.turn)} cy={y(last[metric][p.id] ?? 0)} r={3.5} fill={p.color} />
                {point && <circle className="chart-dot" cx={x(point.turn)} cy={y(point[metric][p.id] ?? 0)} r={4} fill={p.color} />}
              </g>
            );
          })}
          {ends.map(({ p, y: ey }) => (
            <text key={p.id} className="chart-end" x={W - R + 4} y={ey + 4}>{p.token}</text>
          ))}
          <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} onPointerDown={onMove} />
        </svg>
        {point && (
          <div className="chart-tip" style={x(point.turn) > W / 2 ? { left: `${(L / W) * 100 + 2}%` } : { right: `${(R / W) * 100 + 2}%` }}>
            <div className="chart-tip-head">Turn {point.turn}</div>
            {[...players].sort((a, b) => (point[metric][b.id] ?? 0) - (point[metric][a.id] ?? 0)).map((p) => (
              <div key={p.id} className="chart-tip-row">
                <span className="chart-swatch" style={{ background: p.color }} />
                <span title={p.name}>{p.token}</span>
                <b>${point[metric][p.id] ?? 0}</b>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chart-legend">
        {players.map((p) => (
          <span key={p.id}><span className="chart-swatch" style={{ background: p.color }} />{p.token} {p.name}</span>
        ))}
      </div>
    </div>
  );
}
