/**
 * PURE layered layout for a directly-follows graph (Sugiyama-lite):
 *  1. drop back edges found by DFS (rework loops) so the rest is a DAG;
 *  2. layer = longest path from a source;
 *  3. order nodes within a layer by barycenter of their predecessors (a few sweeps) to reduce crossings.
 */
export type LayoutNode = { id: string; x: number; y: number; layer: number };
export type LayoutResult = { nodes: Map<string, LayoutNode>; width: number; height: number; backEdges: Set<string> };

export function layeredLayout(ids: string[], edges: { from: string; to: string; count?: number }[], opts: { colGap?: number; rowGap?: number; pad?: number } = {}): LayoutResult {
  const colGap = opts.colGap ?? 230, rowGap = opts.rowGap ?? 92, pad = opts.pad ?? 80;
  const out = new Map<string, string[]>(); const indeg = new Map<string, number>();
  for (const id of ids) { out.set(id, []); indeg.set(id, 0); }
  for (const e of edges) if (out.has(e.from) && out.has(e.to) && e.from !== e.to) out.get(e.from)!.push(e.to);
  // 1. back edges via iterative DFS, starting from sources (then anything unvisited)
  const state = new Map<string, 0 | 1 | 2>(); const back = new Set<string>();
  for (const e of edges) if (indeg.has(e.to) && e.from !== e.to) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const roots = [...ids.filter((i) => (indeg.get(i) ?? 0) === 0), ...ids];
  for (const r of roots) {
    if (state.get(r)) continue;
    const stack: { id: string; i: number }[] = [{ id: r, i: 0 }]; state.set(r, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]; const next = out.get(top.id)![top.i++];
      if (next === undefined) { state.set(top.id, 2); stack.pop(); continue; }
      const s = state.get(next) ?? 0;
      if (s === 1) back.add(`${top.id}→${next}`);
      else if (s === 0) { state.set(next, 1); stack.push({ id: next, i: 0 }); }
    }
  }
  // 2. longest-path layering on the DAG (Kahn)
  const dagOut = new Map<string, string[]>(); const din = new Map<string, number>();
  for (const id of ids) { dagOut.set(id, []); din.set(id, 0); }
  for (const [from, tos] of out) for (const to of tos) if (!back.has(`${from}→${to}`)) { dagOut.get(from)!.push(to); din.set(to, (din.get(to) ?? 0) + 1); }
  const layer = new Map<string, number>(); const q = ids.filter((i) => din.get(i) === 0); for (const i of q) layer.set(i, 0);
  while (q.length) { const n = q.shift()!; for (const m of dagOut.get(n)!) { layer.set(m, Math.max(layer.get(m) ?? 0, (layer.get(n) ?? 0) + 1)); din.set(m, din.get(m)! - 1); if (din.get(m) === 0) q.push(m); } }
  for (const i of ids) if (!layer.has(i)) layer.set(i, 0);
  // 3. ordering
  const layers: string[][] = []; for (const i of ids) { const l = layer.get(i)!; (layers[l] ??= []).push(i); }
  const preds = new Map<string, string[]>(); for (const id of ids) preds.set(id, []);
  for (const [from, tos] of dagOut) for (const to of tos) preds.get(to)!.push(from);
  const pos = new Map<string, number>(); layers.forEach((L) => L.forEach((id, i) => pos.set(id, i)));
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let l = 1; l < layers.length; l++) {
      const L = layers[l] ?? []; const bc = new Map(L.map((id) => { const p = preds.get(id)!; return [id, p.length ? p.reduce((s, x) => s + (pos.get(x) ?? 0), 0) / p.length : (pos.get(id) ?? 0)]; }));
      L.sort((a, b) => bc.get(a)! - bc.get(b)!); L.forEach((id, i) => pos.set(id, i));
    }
  }
  const maxRows = Math.max(1, ...layers.map((L) => L?.length ?? 0));
  const nodes = new Map<string, LayoutNode>();
  layers.forEach((L, l) => { const off = ((maxRows - (L?.length ?? 0)) * rowGap) / 2; (L ?? []).forEach((id, i) => nodes.set(id, { id, layer: l, x: pad + l * colGap, y: pad + off + i * rowGap })); });
  return { nodes, width: pad * 2 + Math.max(0, layers.length - 1) * colGap, height: pad * 2 + (maxRows - 1) * rowGap, backEdges: back };
}
