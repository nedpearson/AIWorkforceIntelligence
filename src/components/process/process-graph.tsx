"use client";
/**
 * Interactive SVG process graph (organization-wide directly-follows graph).
 *  - node radius ∝ √(hours per week)  ·  edge width ∝ log(frequency)
 *  - pan/zoom with buttons, mouse drag / wheel, and keyboard (+ / − / arrows / 0) when the canvas is focused
 *  - every node is a focusable button (Enter / Space → onSelect)
 *  - animated flow dots along edges, disabled under prefers-reduced-motion (and via the "Animate" toggle)
 */
import * as React from "react";
import { ZoomIn, ZoomOut, Maximize2, Play, Pause } from "lucide-react";
import type { GraphNode, GraphEdge } from "@/engine/process-mining-org";
import { ACCENT_HEX } from "@/components/ui/enterprise";
import { fmtNum } from "@/lib/utils";
import { layeredLayout } from "./layout";

function useReducedMotion() {
  const [r, setR] = React.useState(true);
  React.useEffect(() => { const m = window.matchMedia("(prefers-reduced-motion: reduce)"); setR(m.matches); const h = () => setR(m.matches); m.addEventListener("change", h); return () => m.removeEventListener("change", h); }, []);
  return r;
}
const nodeColor = (n: GraphNode) => (n.type === "handoff" ? ACCENT_HEX.indigo : n.reworkRate > 0.15 ? ACCENT_HEX.coral : ACCENT_HEX.cyan);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function ProcessGraph({ nodes, edges, selected, onSelect, height = 520 }: { nodes: GraphNode[]; edges: GraphEdge[]; selected: string | null; onSelect: (id: string) => void; height?: number }) {
  const layout = React.useMemo(() => layeredLayout(nodes.map((n) => n.id), edges), [nodes, edges]);
  const reduced = useReducedMotion();
  const [animate, setAnimate] = React.useState(true);
  const wrap = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const [size, setSize] = React.useState({ w: 800, h: height });
  React.useEffect(() => { const el = wrap.current; if (!el) return; const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: height })); ro.observe(el); return () => ro.disconnect(); }, [height]);
  const fit = React.useCallback(() => {
    const fitK = Math.min(size.w / Math.max(layout.width, 1), size.h / Math.max(layout.height, 1), 1.4);
    // On narrow screens a whole-graph fit is unreadable: keep labels legible and start at the left (drag / arrows to explore).
    const k = size.w < 640 ? Math.max(fitK, 0.6) : fitK;
    setView({ k, x: k > fitK ? 8 : (size.w - layout.width * k) / 2, y: (size.h - layout.height * k) / 2 });
  }, [size, layout]);
  React.useEffect(() => { fit(); }, [fit]);
  const zoom = (f: number, cx = size.w / 2, cy = size.h / 2) => setView((v) => { const k = Math.min(4, Math.max(0.2, v.k * f)); return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }; });
  const pan = (dx: number, dy: number) => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  const drag = React.useRef<{ x: number; y: number } | null>(null);

  const maxH = Math.max(...nodes.map((n) => n.hoursPerWeek), 0.0001);
  const maxC = Math.max(...edges.map((e) => e.perWeek), 1);
  const r2 = (v: number) => Math.round(v * 100) / 100; // identical server/client output (avoids float hydration drift)
  const r = (n: GraphNode) => r2(10 + 22 * Math.sqrt(n.hoursPerWeek / maxH));
  const w = (e: GraphEdge) => r2(1 + 7 * (Math.log1p(e.perWeek) / Math.log1p(maxC)));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moving = animate && !reduced;
  const related = selected ? new Set([selected, ...edges.filter((e) => e.from === selected || e.to === selected).flatMap((e) => [e.from, e.to])]) : null;

  const pathOf = (e: GraphEdge) => {
    const a = layout.nodes.get(e.from), b = layout.nodes.get(e.to); if (!a || !b) return "";
    if (e.from === e.to) return `M ${a.x - 6} ${a.y - r(byId.get(a.id)!)} c -30 -50 42 -50 12 0`;
    const back = layout.backEdges.has(`${e.from}→${e.to}`) || b.x <= a.x;
    if (back) { const dy = Math.max(60, Math.abs(b.x - a.x) * 0.25); const midY = Math.max(a.y, b.y) + dy; return `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`; }
    const mx = (a.x + b.x) / 2; return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  };

  const btn = "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink";
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1.5" role="toolbar" aria-label="Graph controls">
        <button type="button" className={btn} onClick={() => zoom(1.25)} aria-label="Zoom in" data-testid="graph-zoom-in"><ZoomIn size={16} /></button>
        <button type="button" className={btn} onClick={() => zoom(0.8)} aria-label="Zoom out" data-testid="graph-zoom-out"><ZoomOut size={16} /></button>
        <button type="button" className={btn} onClick={fit} aria-label="Fit graph to view" data-testid="graph-fit"><Maximize2 size={16} /></button>
        {!reduced && <button type="button" className={btn} onClick={() => setAnimate(!animate)} aria-pressed={animate} aria-label={animate ? "Pause flow animation" : "Play flow animation"} data-testid="graph-animate">{animate ? <Pause size={16} /> : <Play size={16} />}</button>}
      </div>
      <div ref={wrap} tabIndex={0} data-testid="process-graph" aria-label={`Process graph: ${nodes.length} steps and ${edges.length} transitions. Use plus and minus to zoom, arrow keys to pan, 0 to fit, Tab to move between steps.`}
        className="relative w-full cursor-grab touch-none overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle,var(--color-surface-3)_1px,transparent_1px)] [background-size:18px_18px] focus-visible:ring-2 focus-visible:ring-indigo active:cursor-grabbing"
        style={{ height }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const k = e.key; const step = 60;
          if (k === "+" || k === "=") zoom(1.2); else if (k === "-" || k === "_") zoom(1 / 1.2); else if (k === "0") fit();
          else if (k === "ArrowLeft") pan(step, 0); else if (k === "ArrowRight") pan(-step, 0); else if (k === "ArrowUp") pan(0, step); else if (k === "ArrowDown") pan(0, -step); else return;
          e.preventDefault();
        }}
        onWheel={(e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - rect.left, e.clientY - rect.top); }}
        onPointerDown={(e) => { if ((e.target as Element).closest("[data-node]")) return; drag.current = { x: e.clientX, y: e.clientY }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!drag.current) return; pan(e.clientX - drag.current.x, e.clientY - drag.current.y); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={() => { drag.current = null; }}>
        <svg width={size.w} height={height} className="block select-none">
          <defs>
            <marker id="pg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--color-ink-3)" /></marker>
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((e, i) => {
              const d = pathOf(e); if (!d) return null;
              const dim = related && !(related.has(e.from) && related.has(e.to) && (e.from === selected || e.to === selected));
              const isBack = layout.backEdges.has(`${e.from}→${e.to}`) || e.from === e.to;
              return (
                <g key={`${e.from}→${e.to}`} opacity={dim ? 0.15 : 0.85}>
                  <path d={d} fill="none" stroke={isBack ? ACCENT_HEX.coral : "var(--color-ink-3)"} strokeOpacity={isBack ? 0.7 : 0.45} strokeWidth={w(e)} strokeDasharray={isBack ? "6 4" : undefined} markerEnd="url(#pg-arrow)"><title>{`${byId.get(e.from)?.label} → ${byId.get(e.to)?.label}: ${fmtNum(e.perWeek, 1)} per week${isBack ? " (loop back / rework)" : ""}`}</title></path>
                  {moving && !dim && i < 80 && (
                    <circle r={r2(2.2 + w(e) / 3)} fill={isBack ? ACCENT_HEX.coral : ACCENT_HEX.royal}>
                      <animateMotion dur={`${r2(Math.max(1.6, 5 - 3 * (Math.log1p(e.perWeek) / Math.log1p(maxC))))}s`} repeatCount="indefinite" path={d} begin={`${(i % 7) * 0.35}s`} />
                    </circle>
                  )}
                </g>
              );
            })}
            {nodes.map((n) => {
              const p = layout.nodes.get(n.id); if (!p) return null;
              const rad = r(n); const sel = selected === n.id; const dim = related && !related.has(n.id);
              return (
                <g key={n.id} data-node transform={`translate(${p.x} ${p.y})`} opacity={dim ? 0.3 : 1} role="button" tabIndex={0} aria-pressed={sel} data-testid={`graph-node-${n.id}`}
                  aria-label={`${short(n.app, 18)} ${short(n.action, 26)} (${n.label}): ${fmtNum(n.hoursPerWeek, 1)} hours per week, ${fmtNum(n.perWeek, 0)} times per week, average ${fmtNum(n.avgMs / 1000, 0)} seconds`}
                  className="cursor-pointer outline-none [&:focus-visible>circle:first-child]:stroke-[var(--color-indigo)] [&:focus-visible>circle:first-child]:stroke-[4px]"
                  onClick={() => onSelect(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n.id); } }}>
                  <circle r={rad + (sel ? 5 : 0)} fill={nodeColor(n)} fillOpacity={0.18} stroke={sel ? ACCENT_HEX.indigo : nodeColor(n)} strokeWidth={sel ? 3 : 1.5} />
                  <circle r={Math.max(4, rad * 0.55)} fill={nodeColor(n)} />
                  <text y={rad + 14} textAnchor="middle" className="fill-[var(--color-ink)] text-[11px] font-semibold">{short(n.app, 18)}</text>
                  <text y={rad + 27} textAnchor="middle" className="fill-[var(--color-ink-2)] text-[10px]">{" "}{short(n.action, 26)}</text>
                  {/* no <title>: its text joins the visible labels without a space, so the accessible name (aria-label, which
                      already carries the full label) no longer contained the visible text (axe label-content-name-mismatch) */}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2" aria-label="Graph legend">
        <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: ACCENT_HEX.cyan }} />Process step</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: ACCENT_HEX.indigo }} />Hand-off</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: ACCENT_HEX.coral }} />Step in a workflow with &gt;15% rework</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 border-t-2 border-dashed" style={{ borderColor: ACCENT_HEX.coral }} />Loop back</li>
        <li>Node size = hours/week · line width = frequency · drag to pan, Ctrl+scroll or buttons to zoom</li>
      </ul>
    </div>
  );
}
