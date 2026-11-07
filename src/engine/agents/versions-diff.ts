/** Structural diff between two agent definitions (pure — safe for client components). */
import type { AgentDefinition, AgentNode } from "@/db/schema";

// ---------------------------------------------------------------------------------------------
// Structural diff (pure)
// ---------------------------------------------------------------------------------------------
export type FieldChange = { path: string; before: unknown; after: unknown };
export type DefinitionDiff = {
  nodes: { added: AgentNode[]; removed: AgentNode[]; changed: { id: string; label: string; changes: FieldChange[] }[]; unchanged: number };
  edges: { added: AgentDefinition["edges"]; removed: AgentDefinition["edges"]; unchanged: number };
  settings: FieldChange[];
  identical: boolean;
};
const edgeKey = (e: AgentDefinition["edges"][number]) => `${e.from}→${e.to}${e.when ? `[${e.when}]` : ""}`;
function flatten(v: unknown, prefix: string, out: Map<string, unknown>) {
  if (v && typeof v === "object" && !Array.isArray(v)) { const ks = Object.keys(v as object); if (!ks.length) out.set(prefix, {}); for (const k of ks) flatten((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out); }
  else out.set(prefix, v);
}
function fieldChanges(a: unknown, b: unknown, prefix = ""): FieldChange[] {
  const fa = new Map<string, unknown>(), fb = new Map<string, unknown>();
  flatten(a, prefix, fa); flatten(b, prefix, fb);
  const keys = Array.from(new Set([...fa.keys(), ...fb.keys()])).sort();
  const out: FieldChange[] = [];
  for (const k of keys) { const x = fa.get(k), y = fb.get(k); if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: k, before: x, after: y }); }
  return out;
}
export function diffDefinitions(before: AgentDefinition, after: AgentDefinition): DefinitionDiff {
  const bm = new Map(before.nodes.map((n) => [n.id, n])), am = new Map(after.nodes.map((n) => [n.id, n]));
  const added = after.nodes.filter((n) => !bm.has(n.id)), removed = before.nodes.filter((n) => !am.has(n.id));
  const changed: DefinitionDiff["nodes"]["changed"] = []; let unchangedNodes = 0;
  for (const n of after.nodes) {
    const o = bm.get(n.id); if (!o) continue;
    const ch = fieldChanges({ type: o.type, label: o.label, sensitive: o.sensitive ?? null, config: o.config ?? {}, compensate: o.compensate ?? null }, { type: n.type, label: n.label, sensitive: n.sensitive ?? null, config: n.config ?? {}, compensate: n.compensate ?? null });
    if (ch.length) changed.push({ id: n.id, label: n.label, changes: ch }); else unchangedNodes++;
  }
  const be = new Set(before.edges.map(edgeKey)), ae = new Set(after.edges.map(edgeKey));
  const edgesAdded = after.edges.filter((e) => !be.has(edgeKey(e))), edgesRemoved = before.edges.filter((e) => !ae.has(edgeKey(e)));
  const settings = fieldChanges({ schedule: before.schedule ?? null, retries: before.retries ?? null }, { schedule: after.schedule ?? null, retries: after.retries ?? null });
  return {
    nodes: { added, removed, changed, unchanged: unchangedNodes },
    edges: { added: edgesAdded, removed: edgesRemoved, unchanged: after.edges.length - edgesAdded.length },
    settings,
    identical: !added.length && !removed.length && !changed.length && !edgesAdded.length && !edgesRemoved.length && !settings.length,
  };
}
