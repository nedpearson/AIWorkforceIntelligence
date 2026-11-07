/**
 * Zod schema + graph helpers for AgentDefinition. Shared by the runner, the builder UI
 * server actions and the n8n adapter. Pure — no DB.
 */
import { z } from "zod";
import type { AgentDefinition, AgentNode } from "@/db/schema";

export const NODE_TYPES = ["trigger", "action", "condition", "approval", "llm", "http", "transform", "notify", "end"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const agentNodeSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "node ids: letters, numbers, _ and -"),
  type: z.enum(NODE_TYPES),
  label: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
  sensitive: z.boolean().optional(),
  compensate: z.record(z.string(), z.unknown()).optional(),
});
export const agentEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.enum(["true", "false", "approved", "rejected"]).optional(),
});
export const agentDefinitionSchema = z.object({
  nodes: z.array(agentNodeSchema).min(1).max(200),
  edges: z.array(agentEdgeSchema).max(400),
  schedule: z.string().max(120).optional(),
  retries: z.object({ max: z.number().int().min(0).max(10), backoffMs: z.number().int().min(0).max(60_000) }).optional(),
}).superRefine((d, ctx) => {
  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (ids.has(n.id)) ctx.addIssue({ code: "custom", message: `duplicate node id "${n.id}"` });
    ids.add(n.id);
  }
  for (const e of d.edges) {
    if (!ids.has(e.from)) ctx.addIssue({ code: "custom", message: `edge from unknown node "${e.from}"` });
    if (!ids.has(e.to)) ctx.addIssue({ code: "custom", message: `edge to unknown node "${e.to}"` });
  }
  if (!d.nodes.some((n) => n.type === "trigger")) ctx.addIssue({ code: "custom", message: "definition needs a trigger node" });
  if (!d.nodes.some((n) => n.type === "end")) ctx.addIssue({ code: "custom", message: "definition needs an end node" });
});

export function validateDefinition(input: unknown): { ok: true; definition: AgentDefinition } | { ok: false; errors: string[] } {
  const r = agentDefinitionSchema.safeParse(input);
  if (r.success) return { ok: true, definition: r.data as AgentDefinition };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`) };
}

/** Node depth by longest path from the trigger (used for column layout in the builder). */
export function layoutColumns(def: AgentDefinition): Map<string, number> {
  const depth = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const e of def.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const start = def.nodes.find((n) => n.type === "trigger") ?? def.nodes[0];
  if (!start) return depth;
  const queue: [string, number][] = [[start.id, 0]];
  const seen = new Map<string, number>();
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if ((seen.get(id) ?? -1) >= d) continue;
    if ((seen.get(id) ?? 0) > 50) continue; // cycle guard
    seen.set(id, d);
    for (const t of out.get(id) ?? []) queue.push([t, d + 1]);
  }
  for (const n of def.nodes) depth.set(n.id, seen.get(n.id) ?? 0);
  return depth;
}

export function nextNodeId(def: AgentDefinition, from: AgentNode, when?: "true" | "false" | "approved" | "rejected"): string | null {
  const edges = def.edges.filter((e) => e.from === from.id);
  if (when) {
    const e = edges.find((x) => x.when === when);
    if (e) return e.to;
    if (when === "rejected") return null; // rejection with no explicit branch ends the run
    const plain = edges.find((x) => !x.when);
    return plain?.to ?? null;
  }
  const plain = edges.find((x) => !x.when) ?? edges[0];
  return plain?.to ?? null;
}

/** Resolve a dotted path ("input.invoice.total", "nodes.llm1.text") safely — no eval. */
export function getPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) { cur = cur[Number(part)]; continue; }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replace {{path}} placeholders in a string with values from the scope. Objects are JSON-encoded. */
export function template(s: string, scope: Record<string, unknown>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g, (_, p: string) => {
    const v = getPath(scope, p);
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}
