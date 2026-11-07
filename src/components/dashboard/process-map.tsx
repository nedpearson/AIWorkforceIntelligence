"use client";
import * as React from "react";
import type { ProcessMap } from "@/db/schema";

/**
 * Directly-follows graph rendered as an SVG, laid out left → right in layers (BFS from the entry step).
 * Node size = average time spent on the step; edge label = how many times one step was followed by the other.
 * Edges that go backwards (loops / rework) are drawn dashed above the flow.
 */
type Laid = { id: string; label: string; count: number; avgMs: number; x: number; y: number; r: number; layer: number };

function layout(map: ProcessMap, width: number) {
  const nodes = map.nodes; const edges = map.edges;
  const incoming = new Map<string, number>(); for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + e.count);
  const out = new Map<string, string[]>(); for (const e of edges) { const a = out.get(e.from) ?? []; a.push(e.to); out.set(e.from, a); }
  // entry = node with the least incoming relative to its count (first step), tie → largest count
  const entry = [...nodes].sort((a, b) => (incoming.get(a.id)! / Math.max(1, a.count)) - (incoming.get(b.id)! / Math.max(1, b.count)) || b.count - a.count)[0];
  const layer = new Map<string, number>();
  if (entry) { layer.set(entry.id, 0); const q = [entry.id]; while (q.length) { const id = q.shift()!; for (const t of out.get(id) ?? []) if (!layer.has(t)) { layer.set(t, layer.get(id)! + 1); q.push(t); } } }
  let next = (Math.max(-1, ...layer.values()) + 1); for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, next++);
  const layers = new Map<number, typeof nodes>(); for (const n of nodes) { const l = layer.get(n.id)!; const a = layers.get(l) ?? []; a.push(n); layers.set(l, a); }
  const L = layers.size; const maxPer = Math.max(1, ...[...layers.values()].map((a) => a.length));
  const maxMs = Math.max(1, ...nodes.map((n) => n.avgMs));
  const colW = Math.max(150, (width - 40) / Math.max(1, L)); const rowH = 92;
  const height = Math.max(180, maxPer * rowH + 60);
  const laid: Laid[] = [];
  [...layers.entries()].sort((a, b) => a[0] - b[0]).forEach(([l, arr], li) => {
    arr.sort((a, b) => b.count - a.count);
    arr.forEach((n, i) => { const r = 14 + 20 * Math.sqrt(n.avgMs / maxMs); laid.push({ ...n, layer: l, r, x: 30 + li * colW + colW / 2, y: 50 + (height - 100) * (arr.length === 1 ? 0.5 : i / (arr.length - 1)) }); });
  });
  return { laid, height, width: Math.max(width, 30 + L * colW + 30) };
}

const fmtMin = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

export function ProcessMapView({ map, testid = "process-map" }: { map: ProcessMap | null | undefined; testid?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(760);
  React.useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); setW(el.clientWidth); return () => ro.disconnect(); }, []);
  const [hover, setHover] = React.useState<string | null>(null);
  if (!map || !map.nodes.length) return <p className="text-xs text-ink-3">No process map recorded for this workflow yet. It is produced by the analysis run.</p>;
  const { laid, height, width } = layout(map, w);
  const byId = new Map(laid.map((n) => [n.id, n]));
  const maxEdge = Math.max(1, ...map.edges.map((e) => e.count));
  return (
    <div ref={ref} className="w-full overflow-x-auto scrollbar-thin" data-testid={testid}>
      <svg width={width} height={height} role="img" aria-label="Process map" className="block">
        <defs><marker id="pm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink-3)" /></marker></defs>
        {map.edges.map((e, i) => {
          const a = byId.get(e.from), b = byId.get(e.to); if (!a || !b) return null;
          const back = b.layer <= a.layer; const sw = 1 + 3 * (e.count / maxEdge);
          const dim = hover && hover !== e.from && hover !== e.to;
          const x1 = a.x + (back ? 0 : a.r), y1 = a.y - (back ? a.r : 0), x2 = b.x - (back ? 0 : b.r), y2 = b.y - (back ? b.r : 0);
          const d = back ? `M${x1},${y1} C${x1},${y1 - 70} ${x2},${y2 - 70} ${x2},${y2}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
          const mx = (x1 + x2) / 2, my = back ? Math.min(y1, y2) - 52 : (y1 + y2) / 2 - 6;
          return (
            <g key={i} opacity={dim ? 0.2 : 1}>
              <path d={d} fill="none" stroke="var(--color-ink-3)" strokeWidth={sw} strokeDasharray={back ? "5 4" : undefined} markerEnd="url(#pm-arrow)" />
              <rect x={mx - 16} y={my - 8} width={32} height={14} rx={7} fill="var(--color-surface)" stroke="var(--color-border)" />
              <text x={mx} y={my + 3} textAnchor="middle" fontSize={10} fill="var(--color-ink-2)">{e.count}</text>
            </g>
          );
        })}
        {laid.map((n) => (
          <g key={n.id} transform={`translate(${n.x},${n.y})`} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} data-testid={`pm-node-${n.layer}`} style={{ cursor: "default" }}>
            <circle r={n.r} fill="var(--color-brand-soft)" stroke="var(--color-brand)" strokeWidth={hover === n.id ? 2.5 : 1.5} />
            <text y={4} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--color-brand)">{fmtMin(n.avgMs)}</text>
            <text y={n.r + 14} textAnchor="middle" fontSize={10} fill="var(--color-ink)">{n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label}</text>
            <text y={n.r + 26} textAnchor="middle" fontSize={9} fill="var(--color-ink-3)">{n.count} times</text>
            <title>{`${n.label}\nPerformed ${n.count} times · ${fmtMin(n.avgMs)} on average`}</title>
          </g>
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-ink-3">Circles are steps (bigger = more time per step). Numbers on arrows = how often one step was followed by the next. Dashed arrows going back = rework loops.</p>
    </div>
  );
}
