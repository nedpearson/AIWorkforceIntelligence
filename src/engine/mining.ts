/**
 * Workflow mining — PURE functions (no DB) so they are unit-testable.
 *
 * Pipeline:  events (one employee, ordered by ts)
 *            → stripNoise()            drop ambient focus events + chatter titles, keep idle markers
 *            → sessionize()            split into task sessions (idle, >10 min gaps, task boundaries)
 *            → toInstance()            session → ordered step tokens `app:titleCategory:type` (consecutive dupes collapsed)
 *            → clusterInstances()      group instances with ≥70% step overlap into workflows
 *            → workflowMetrics()       durations, runs/week, process map, rework, handoffs, per-employee stats
 *
 * Everything here is "observed": it only counts what the collector actually recorded.
 * See docs/ANALYSIS_METHOD.md for the plain-English explanation.
 */
import type { ProcessMap, WorkflowStep } from "@/db/schema";

export type MiningEvent = {
  id: number;
  employeeId: string;
  ts: number; // epoch ms
  type: string;
  app: string;
  appCategory: string;
  titleCategory: string;
  titleHash?: string | null;
  durationMs: number;
  meta?: Record<string, number | string | boolean> | null;
};

export type Session = { employeeId: string; events: MiningEvent[] };

export type TaskInstance = {
  employeeId: string;
  startTs: number;
  endTs: number;
  durationMs: number; // wall-clock from first event start to last event end
  tokens: string[]; // step tokens in order, consecutive duplicates collapsed
  steps: InstanceStep[];
  signature: string;
  eventIds: number[];
  hasRework: boolean;
  handoffs: number;
};
export type InstanceStep = { token: string; app: string; appCategory: string; titleCategory: string; type: string; durationMs: number; pasteCount: number; fieldCount: number };

export type Cluster = {
  canonical: string[]; // most common token sequence
  signature: string;
  instances: TaskInstance[];
  variantCount: number; // distinct signatures merged into this cluster
};

// ---------- constants ----------
export const GAP_SPLIT_MS = 10 * 60 * 1000;
export const CLUSTER_THRESHOLD = 0.7;
export const DUPLICATE_THRESHOLD = 0.8;
export const MIN_INSTANCES_PER_WORKFLOW = 3;

/** Events that *produce* something (a task may end after one of these). */
const PRODUCING = new Set(["data_entry", "copy_paste", "form_submit", "document_save", "email_compose", "handoff", "print"]);
/** Events that typically *start* a task. */
const START_LIKE = new Set(["document_open", "navigation"]);
/** Ambient events that carry no task information. */
const AMBIENT_TYPES = new Set(["app_focus", "app_switch"]);
const NOISE_TITLES = new Set(["general", "inbox", "meeting", "team channel", ""]);
const NOISE_CATEGORIES = new Set(["meeting"]);

export const isIdle = (e: MiningEvent) => e.type === "idle_start" || e.type === "idle_end";
export function isNoise(e: MiningEvent): boolean {
  if (isIdle(e)) return false;
  if (AMBIENT_TYPES.has(e.type)) return true;
  if (NOISE_CATEGORIES.has(e.appCategory)) return true;
  if (NOISE_TITLES.has((e.titleCategory ?? "").toLowerCase()) && e.type !== "data_entry" && e.type !== "form_submit") return true;
  return false;
}

export const stepToken = (e: Pick<MiningEvent, "app" | "titleCategory" | "type">) => `${e.app}:${(e.titleCategory ?? "").toLowerCase()}:${e.type}`;

// ---------- sessionization ----------
/**
 * Split one employee's events (sorted by ts) into task sessions.
 * Cuts at: idle markers; gaps > 10 min between the end of one event and the start of the next;
 * and task boundaries:
 *   (a) a producing event (entry / paste / submit / save / send / handoff / print) followed by a start-like event
 *       (document_open / navigation) — unless the start-like event is a *continuation*: re-navigating to a screen
 *       already visited in this session that is not the screen the session started on (rework loops back to a middle step;
 *       going back to the first screen means a new run);
 *   (b) a document_open in a different app with a different title right after another document_open — opening an
 *       unrelated document elsewhere starts a new task (an ad-hoc memo before an invoice is not part of the invoice).
 * `meta.rework` is deliberately NOT used for boundaries (collectors may flag whole runs); it only marks rework.
 */
export function sessionize(events: MiningEvent[]): Session[] {
  const out: Session[] = [];
  let cur: MiningEvent[] = [];
  let seenTitles = new Set<string>();
  let firstKey = "";
  let prev: MiningEvent | null = null;
  const keyOf = (e: MiningEvent) => e.titleHash || `${e.app}|${e.titleCategory}`;
  const flush = () => { if (cur.length) out.push({ employeeId: cur[0].employeeId, events: cur }); cur = []; seenTitles = new Set(); firstKey = ""; prev = null; };
  for (const e of events) {
    if (isIdle(e)) { flush(); continue; }
    if (isNoise(e)) continue;
    if (prev) {
      const gap = e.ts - (prev.ts + prev.durationMs);
      if (gap > GAP_SPLIT_MS) flush();
      else if (PRODUCING.has(prev.type) && START_LIKE.has(e.type)) {
        const key = keyOf(e);
        const continuation = e.type === "navigation" && seenTitles.has(key) && key !== firstKey;
        if (!continuation) flush();
      } else if (prev.type === "document_open" && e.type === "document_open" && prev.app !== e.app && (prev.titleCategory ?? "").toLowerCase() !== (e.titleCategory ?? "").toLowerCase()) {
        flush();
      }
    }
    if (!cur.length) firstKey = keyOf(e);
    cur.push(e);
    seenTitles.add(keyOf(e));
    prev = e;
  }
  flush();
  return out;
}

// ---------- instances ----------
export function toInstance(s: Session): TaskInstance | null {
  const steps: InstanceStep[] = [];
  let hasRework = false; let handoffs = 0;
  for (const e of s.events) {
    const token = stepToken(e);
    if (e.meta?.rework === true) hasRework = true;
    if (e.type === "handoff") handoffs++;
    const last = steps[steps.length - 1];
    const paste = Number(e.meta?.pasteCount ?? 0) || (e.type === "copy_paste" ? 1 : 0);
    const fields = Number(e.meta?.fieldCount ?? 0);
    if (last && last.token === token) { last.durationMs += e.durationMs; last.pasteCount += paste; last.fieldCount += fields; continue; }
    steps.push({ token, app: e.app, appCategory: e.appCategory, titleCategory: (e.titleCategory ?? "").toLowerCase(), type: e.type, durationMs: e.durationMs, pasteCount: paste, fieldCount: fields });
  }
  if (steps.length < 2) return null; // a workflow needs at least two distinct steps; single-step sessions are ad-hoc work
  const tokens = steps.map((x) => x.token);
  // rework = a step token re-appears after a different step intervened
  if (!hasRework) { const seen = new Set<string>(); let lastTok = ""; for (const t of tokens) { if (seen.has(t) && t !== lastTok) { hasRework = true; break; } seen.add(t); lastTok = t; } }
  const first = s.events[0]; const last = s.events[s.events.length - 1];
  const endTs = last.ts + last.durationMs;
  return { employeeId: s.employeeId, startTs: first.ts, endTs, durationMs: endTs - first.ts, tokens, steps, signature: tokens.join(">"), eventIds: s.events.map((e) => e.id), hasRework, handoffs };
}

/** Convenience: one employee's sorted events → task instances. */
export function mineEmployee(events: MiningEvent[]): TaskInstance[] {
  const out: TaskInstance[] = [];
  for (const s of sessionize(events)) { const inst = toInstance(s); if (inst) out.push(inst); }
  return out;
}

// ---------- similarity ----------
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a); const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
export function lcsLength(a: string[], b: string[]): number {
  const m = a.length, n = b.length; if (!m || !n) return 0;
  let prev = new Array<number>(n + 1).fill(0), cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) { for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); [prev, cur] = [cur, prev]; }
  return prev[n];
}
/** Step-overlap similarity: Jaccard on token sets (85%) + order-aware LCS bonus (15%). */
export function sequenceSimilarity(a: string[], b: string[]): number {
  const dedupA = Array.from(new Set(a)), dedupB = Array.from(new Set(b));
  const j = jaccard(dedupA, dedupB);
  const order = lcsLength(dedupA, dedupB) / Math.max(dedupA.length, dedupB.length, 1);
  return 0.85 * j + 0.15 * order;
}

// ---------- clustering ----------
/** Group instances by exact signature, then merge signature groups whose similarity to a cluster leader ≥ threshold. Leader = most common sequence. */
export function clusterInstances(instances: TaskInstance[], threshold = CLUSTER_THRESHOLD): Cluster[] {
  const groups = new Map<string, TaskInstance[]>();
  for (const inst of instances) { const g = groups.get(inst.signature); if (g) g.push(inst); else groups.set(inst.signature, [inst]); }
  const ordered = Array.from(groups.values()).sort((a, b) => b.length - a.length || a[0].signature.localeCompare(b[0].signature));
  const clusters: Cluster[] = [];
  for (const g of ordered) {
    const toks = g[0].tokens;
    let best: Cluster | null = null; let bestSim = 0;
    for (const c of clusters) { const sim = sequenceSimilarity(c.canonical, toks); if (sim >= threshold && sim > bestSim) { best = c; bestSim = sim; } }
    if (best) { best.instances.push(...g); best.variantCount++; }
    else clusters.push({ canonical: toks, signature: g[0].signature, instances: [...g], variantCount: 1 });
  }
  return clusters.sort((a, b) => b.instances.length - a.instances.length);
}

// ---------- metrics ----------
export type EmployeeStat = { employeeId: string; runs: number; runsPerWeek: number; avgDurationMin: number; hoursPerWeek: number };
export type WorkflowMetrics = {
  instanceCount: number;
  avgDurationMin: number;
  durationCv: number; // coefficient of variation of instance duration
  runsPerWeek: number;
  hoursPerWeek: number;
  employeeIds: string[];
  employees: EmployeeStat[];
  reworkRate: number; // share of instances with rework
  handoffCount: number; // total handoff events
  handoffRate: number; // share of instances with ≥1 handoff
  canonicalShare: number; // share of instances whose signature equals the canonical one
  steps: WorkflowStep[];
  processMap: ProcessMap;
  observedFrom: number; observedTo: number;
  apps: string[]; // distinct apps in canonical order
  typeShare: Record<string, number>; // time share by event type (across all instances)
  categoryShare: Record<string, number>; // time share by app category
  titleTime: Record<string, number>; // total ms by titleCategory
  pasteSteps: number; // canonical steps that paste
  distinctApps: number;
  structuredFieldCount: number; // avg fieldCount per instance
};

export function workflowMetrics(c: Cluster, observedWeeks: number): WorkflowMetrics {
  const n = c.instances.length;
  const weeks = Math.max(observedWeeks, 1 / 5);
  const durs = c.instances.map((i) => i.durationMs);
  const mean = durs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(durs.reduce((s, d) => s + (d - mean) ** 2, 0) / n);
  const perEmp = new Map<string, { runs: number; ms: number }>();
  let rework = 0, handoffs = 0, handoffInst = 0, canonicalMatches = 0, from = Infinity, to = -Infinity, fields = 0;
  const typeMs: Record<string, number> = {}, catMs: Record<string, number> = {}, titleMs: Record<string, number> = {};
  const nodeAgg = new Map<string, { label: string; count: number; ms: number; app: string; cat: string; title: string; type: string; paste: number }>();
  const edgeAgg = new Map<string, number>();
  let totalStepMs = 0;
  for (const inst of c.instances) {
    const pe = perEmp.get(inst.employeeId) ?? { runs: 0, ms: 0 }; pe.runs++; pe.ms += inst.durationMs; perEmp.set(inst.employeeId, pe);
    if (inst.hasRework) rework++;
    handoffs += inst.handoffs; if (inst.handoffs > 0) handoffInst++;
    if (inst.signature === c.signature) canonicalMatches++;
    if (inst.startTs < from) from = inst.startTs; if (inst.endTs > to) to = inst.endTs;
    let prevTok: string | null = null;
    for (const s of inst.steps) {
      totalStepMs += s.durationMs; fields += s.fieldCount;
      typeMs[s.type] = (typeMs[s.type] ?? 0) + s.durationMs;
      catMs[s.appCategory] = (catMs[s.appCategory] ?? 0) + s.durationMs;
      titleMs[s.titleCategory] = (titleMs[s.titleCategory] ?? 0) + s.durationMs;
      const na = nodeAgg.get(s.token) ?? { label: `${s.app}: ${s.titleCategory} (${s.type.replace("_", " ")})`, count: 0, ms: 0, app: s.app, cat: s.appCategory, title: s.titleCategory, type: s.type, paste: 0 };
      na.count++; na.ms += s.durationMs; na.paste += s.pasteCount; nodeAgg.set(s.token, na);
      if (prevTok) { const k = `${prevTok}\u0000${s.token}`; edgeAgg.set(k, (edgeAgg.get(k) ?? 0) + 1); }
      prevTok = s.token;
    }
  }
  const share = (m: Record<string, number>) => { const o: Record<string, number> = {}; for (const k in m) o[k] = totalStepMs ? m[k] / totalStepMs : 0; return o; };
  const steps: WorkflowStep[] = c.canonical.map((tok, idx) => { const na = nodeAgg.get(tok)!; return { idx, app: na.app, action: `${na.title} (${na.type.replace("_", " ")})`, avgMs: Math.round(na.ms / na.count), share: totalStepMs ? na.ms / totalStepMs : 0, category: na.cat }; });
  const processMap: ProcessMap = {
    nodes: Array.from(nodeAgg.entries()).map(([id, a]) => ({ id, label: a.label, count: a.count, avgMs: Math.round(a.ms / a.count) })),
    edges: Array.from(edgeAgg.entries()).map(([k, count]) => { const [f, t] = k.split("\u0000"); return { from: f, to: t, count }; }).sort((a, b) => b.count - a.count),
  };
  const employees: EmployeeStat[] = Array.from(perEmp.entries()).map(([employeeId, s]) => { const avgMin = s.ms / s.runs / 60000; const rpw = s.runs / weeks; return { employeeId, runs: s.runs, runsPerWeek: rpw, avgDurationMin: avgMin, hoursPerWeek: (rpw * avgMin) / 60 }; }).sort((a, b) => b.runs - a.runs);
  const apps: string[] = []; for (const tok of c.canonical) { const app = nodeAgg.get(tok)!.app; if (!apps.includes(app)) apps.push(app); }
  const avgDurationMin = mean / 60000; const runsPerWeek = n / weeks;
  return {
    instanceCount: n, avgDurationMin, durationCv: mean ? sd / mean : 0, runsPerWeek, hoursPerWeek: (runsPerWeek * avgDurationMin) / 60,
    employeeIds: employees.map((e) => e.employeeId), employees, reworkRate: rework / n, handoffCount: handoffs, handoffRate: handoffInst / n,
    canonicalShare: canonicalMatches / n, steps, processMap, observedFrom: from, observedTo: to, apps,
    typeShare: share(typeMs), categoryShare: share(catMs), titleTime: titleMs,
    pasteSteps: c.canonical.filter((t) => (nodeAgg.get(t)?.paste ?? 0) > 0).length, distinctApps: apps.length, structuredFieldCount: fields / n,
  };
}

/** Observed weeks = distinct active workdays ÷ 5 (so a 20-workday campaign = 4 weeks regardless of calendar gaps). */
export function observedWeeksFromDays(activeDayKeys: Set<string>): number { return Math.max(activeDayKeys.size / 5, 1 / 5); }
export const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

// ---------- naming ----------
const ACTION_SUFFIX: Record<string, string> = { data_entry: "entry", copy_paste: "transfer", navigation: "lookup", document_open: "review", email_compose: "correspondence", form_submit: "submission", document_save: "update", print: "printing", handoff: "handoff" };
const SELF_DESCRIBING = /(entry|review|request|reply|report|export|form|sheet|log|tracker|record|deck|confirmation|comments|adjustment|portal|dashboard|analytics|reconcile|workpaper|system|contact|availability|channel|order|ticket|invoice|contract)$/;
const ACRONYMS = new Set(["hr", "it", "crm", "erp", "ap", "ar", "po", "sox", "pii", "kb", "sku"]);
export function capitalize(s: string): string {
  const words = s.split(" ").map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  return words.join(" ");
}
export function nameWorkflow(m: WorkflowMetrics): string {
  let bestTitle = ""; let bestMs = -1;
  for (const [t, ms] of Object.entries(m.titleTime)) if (t && ms > bestMs) { bestMs = ms; bestTitle = t; }
  const dominantStep = m.steps.slice().sort((a, b) => b.share - a.share).find((s) => s.action.startsWith(bestTitle + " ")) ?? m.steps[0];
  const type = dominantStep?.action.match(/\((.+)\)$/)?.[1].replace(" ", "_") ?? "data_entry";
  const suffix = SELF_DESCRIBING.test(bestTitle) ? "" : ` ${ACTION_SUFFIX[type] ?? "work"}`;
  const title = bestTitle ? capitalize(bestTitle) : "Unnamed task";
  return `${title}${suffix} (${m.apps.join(" → ")})`;
}
