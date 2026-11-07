"use client";
/**
 * Visual flow builder: nodes laid out in columns by depth, edges as SVG paths, side panel to edit the selected
 * node's label / config JSON, add / delete / connect nodes. Saves through updateAgentDefinition (zod-validated).
 */
import * as React from "react";
import { Plus, Trash2, Link2, Save, Undo2 } from "lucide-react";
import { Button, Badge, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { AgentDefinition, AgentNode } from "@/db/schema";
import { NODE_TYPES, layoutColumns, validateDefinition } from "@/engine/agents/definition";
import { updateAgentDefinition } from "../actions";
import { isValidCron, describeCron } from "@/engine/agents/cron";

const W = 168, H = 64, GX = 70, GY = 26, PAD = 20;
const TYPE_TONE: Record<AgentNode["type"], string> = { trigger: "border-brand bg-brand-soft/60", action: "border-money bg-money-soft/60", http: "border-info bg-info-soft/60", llm: "border-projected bg-projected-soft/60", approval: "border-warn bg-warn-soft/60", condition: "border-ink-3 bg-surface-2", transform: "border-border bg-surface", notify: "border-border bg-surface", end: "border-ink-2 bg-surface-2" };
const TYPE_HELP: Record<AgentNode["type"], string> = {
  trigger: "Where a run starts. config.source: webhook | schedule | manual; config.example: sample input.",
  transform: "Builds a new object from paths. config.mapping: { field: \"input.x\" | \"nodes.<id>.y\" | \"=literal\" }.",
  condition: "Branches on true/false edges. config: { left: \"nodes.x.y\", op: eq|neq|gt|gte|lt|lte|contains|exists|truthy, right: value }.",
  http: "Reads from an API. config: { method, url (supports {{secret.field}} {{input.x}} {{nodes.id.x}}), auth: bearer|basic|header, credentialId or credentialProvider, headers, body }.",
  action: "Changes an external system (kind: http | log). Add `compensate` ({ kind: http|log, ... }) so a failed run can undo it.",
  llm: "Calls Claude (claude-sonnet-4-5) with config.system and config.prompt (templated). Skipped honestly when ANTHROPIC_API_KEY is missing.",
  approval: "Pauses for a person. config.action is the plain-English request; config.reviewMinutes is counted as human time. Mark sensitive to gate under 'sensitive only' policy.",
  notify: "Logs a message; optional webhookUrl posts it. Email delivery requires the n8n runtime.",
  end: "Ends the run and records minutes saved (agent expectation unless config.minutesSavedPath points at an output).",
};

export function FlowBuilder({ agentId, definition, canWrite, onSaved }: { agentId: string; definition: AgentDefinition; canWrite: boolean; onSaved: (d: AgentDefinition) => void }) {
  const [def, setDef] = React.useState<AgentDefinition>(definition);
  const [sel, setSel] = React.useState<string | null>(null);
  const [connectFrom, setConnectFrom] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false); const [busy, setBusy] = React.useState(false); const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [cfgText, setCfgText] = React.useState(""); const [cfgErr, setCfgErr] = React.useState(""); const [compText, setCompText] = React.useState("");
  const node = def.nodes.find((n) => n.id === sel) ?? null;
  React.useEffect(() => { if (node) { setCfgText(JSON.stringify(node.config ?? {}, null, 2)); setCompText(node.compensate ? JSON.stringify(node.compensate, null, 2) : ""); setCfgErr(""); } }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols = React.useMemo(() => layoutColumns(def), [def]);
  const positions = React.useMemo(() => {
    const byCol = new Map<number, string[]>();
    for (const n of def.nodes) { const c = cols.get(n.id) ?? 0; byCol.set(c, [...(byCol.get(c) ?? []), n.id]); }
    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 1;
    for (const [c, ids] of byCol) { maxRows = Math.max(maxRows, ids.length); ids.forEach((id, i) => pos.set(id, { x: PAD + c * (W + GX), y: PAD + i * (H + GY) })); }
    const width = PAD * 2 + (byCol.size || 1) * (W + GX) - GX; const height = PAD * 2 + maxRows * (H + GY) - GY;
    return { pos, width, height };
  }, [def, cols]);

  const update = (fn: (d: AgentDefinition) => AgentDefinition) => { setDef((d) => fn(d)); setDirty(true); setMsg(null); };
  function patchNode(id: string, patch: Partial<AgentNode>) { update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })); }
  function applyConfig() {
    try { const c = JSON.parse(cfgText || "{}"); if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("config must be a JSON object"); const comp = compText.trim() ? JSON.parse(compText) : undefined; if (node) patchNode(node.id, { config: c, compensate: comp }); setCfgErr(""); }
    catch (e) { setCfgErr(e instanceof Error ? e.message : "invalid JSON"); }
  }
  function addNode(type: AgentNode["type"]) {
    const base = type; let i = 1; while (def.nodes.some((n) => n.id === `${base}_${i}`)) i++;
    const id = `${base}_${i}`;
    const n: AgentNode = { id, type, label: `${type[0].toUpperCase()}${type.slice(1)} ${i}`, config: {}, ...(type === "approval" ? { sensitive: true } : {}) };
    update((d) => ({ ...d, nodes: [...d.nodes, n], edges: sel ? [...d.edges, { from: sel, to: id }] : d.edges })); setSel(id);
  }
  function deleteNode(id: string) { update((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.from !== id && e.to !== id) })); setSel(null); }
  function connect(to: string) {
    if (!connectFrom || connectFrom === to) { setConnectFrom(null); return; }
    const from = def.nodes.find((n) => n.id === connectFrom);
    const when = from?.type === "condition" ? (def.edges.some((e) => e.from === connectFrom && e.when === "true") ? "false" : "true") : from?.type === "approval" ? (def.edges.some((e) => e.from === connectFrom && e.when === "approved") ? "rejected" : "approved") : undefined;
    update((d) => ({ ...d, edges: [...d.edges.filter((e) => !(e.from === connectFrom && e.to === to)), { from: connectFrom, to, when }] })); setConnectFrom(null);
  }
  function removeEdge(i: number) { update((d) => ({ ...d, edges: d.edges.filter((_, j) => j !== i) })); }
  async function save() {
    const v = validateDefinition(def); if (!v.ok) { setMsg({ ok: false, text: v.errors.slice(0, 3).join("; ") }); return; }
    if (def.schedule && !isValidCron(def.schedule)) { setMsg({ ok: false, text: `Schedule "${def.schedule}" is not a valid 5-field cron expression` }); return; }
    setBusy(true); const r = await updateAgentDefinition({ agentId, definition: def }); setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error }); return; }
    setDirty(false); setMsg({ ok: true, text: `Flow saved as v${r.version}` }); onSaved(def);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {canWrite && <>
            <AddMenu onAdd={addNode} />
            <Button size="sm" variant="secondary" disabled={!sel} onClick={() => setConnectFrom(sel)} data-testid="flow-connect"><Link2 size={14} />{connectFrom ? "Pick target…" : "Connect from selected"}</Button>
            <Button size="sm" variant="secondary" disabled={!sel || node?.type === "trigger"} onClick={() => sel && deleteNode(sel)} data-testid="flow-delete"><Trash2 size={14} />Delete</Button>
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => { setDef(definition); setDirty(false); setSel(null); }} data-testid="flow-reset"><Undo2 size={14} />Discard</Button>
            <Button size="sm" disabled={!dirty} loading={busy} onClick={save} data-testid="flow-save"><Save size={14} />Save flow</Button>
          </>}
          {msg && <span className={cn("text-xs", msg.ok ? "text-money" : "text-danger")} role="status" data-testid="flow-msg">{msg.text}</span>}
        </div>
        <div className="mb-2 flex flex-wrap items-end gap-2">
          <div className="w-48"><Input label="Schedule (cron, optional)" value={def.schedule ?? ""} disabled={!canWrite} placeholder="0 7 * * 1" onChange={(e) => update((d) => { const v = e.target.value; const { schedule: _s, ...rest } = d; void _s; return v.trim() ? { ...rest, schedule: v } : rest; })} data-testid="flow-schedule" /></div>
          <span className={cn("pb-2 text-[11px]", def.schedule && !isValidCron(def.schedule) ? "text-danger" : "text-ink-3")}>{def.schedule ? describeCron(def.schedule) : "No schedule — runs on its trigger."}</span>
        </div>
        <div className="card overflow-auto scrollbar-thin p-0" data-testid="flow-canvas">
          <div className="relative" style={{ width: positions.width, height: positions.height, minWidth: "100%" }}>
            <svg className="absolute inset-0" width={positions.width} height={positions.height} aria-hidden>
              <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink-3)" /></marker></defs>
              {def.edges.map((e, i) => {
                const a = positions.pos.get(e.from), b = positions.pos.get(e.to); if (!a || !b) return null;
                const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2; const back = x2 <= x1; const c = back ? 80 : Math.max(30, (x2 - x1) / 2);
                const d = back ? `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2 + H} ${x2},${y2}` : `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
                const color = e.when === "false" || e.when === "rejected" ? "var(--color-danger)" : e.when ? "var(--color-money)" : "var(--color-ink-3)";
                return <g key={i} className="cursor-pointer" onClick={() => canWrite && confirm(`Remove edge ${e.from} → ${e.to}?`) && removeEdge(i)}><path d={d} fill="none" stroke={color} strokeWidth={1.6} markerEnd="url(#arr)" /><path d={d} fill="none" stroke="transparent" strokeWidth={12} />{e.when && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} fontSize={10} fill={color} textAnchor="middle">{e.when}</text>}</g>;
              })}
            </svg>
            {def.nodes.map((n) => { const p = positions.pos.get(n.id)!; return (
              <button key={n.id} onClick={() => (connectFrom ? connect(n.id) : setSel(n.id))} data-testid={`flow-node-${n.id}`} style={{ left: p.x, top: p.y, width: W, height: H }}
                className={cn("absolute rounded-lg border-2 px-2 py-1.5 text-left shadow-card transition", TYPE_TONE[n.type], sel === n.id && "ring-2 ring-brand", connectFrom && connectFrom !== n.id && "ring-2 ring-dashed ring-info")}>
                <div className="flex items-center justify-between gap-1"><span className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">{n.type}</span>{n.sensitive && <Badge tone="warn">gate</Badge>}{n.compensate && <Badge tone="info">undo</Badge>}</div>
                <div className="truncate text-xs font-medium">{n.label}</div><div className="truncate text-[10px] text-ink-3">{n.id}</div>
              </button>); })}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">Green edge = true/approved, red = false/rejected, grey = next. Click an edge to remove it. Columns follow the longest path from the trigger.</p>
      </div>
      <div className="card p-4" data-testid="flow-panel">
        {!node ? <p className="text-xs text-ink-2">Select a node to edit it, or add one from the toolbar.</p> : (
          <div className="space-y-3">
            <div className="flex items-center justify-between"><span className="text-sm font-semibold">{node.label}</span><Badge tone="neutral">{node.type}</Badge></div>
            <p className="text-[11px] text-ink-2">{TYPE_HELP[node.type]}</p>
            <Input label="Label" value={node.label} disabled={!canWrite} onChange={(e) => patchNode(node.id, { label: e.target.value })} data-testid="node-label" />
            <Select label="Type" value={node.type} disabled={!canWrite || node.type === "trigger"} onChange={(e) => patchNode(node.id, { type: e.target.value as AgentNode["type"] })} data-testid="node-type">{NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
            {node.type === "approval" && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={node.sensitive !== false} disabled={!canWrite} onChange={(e) => patchNode(node.id, { sensitive: e.target.checked })} data-testid="node-sensitive" />Sensitive (requires approval under &quot;sensitive only&quot; policy)</label>}
            <Textarea label="Config (JSON)" rows={10} className="font-mono text-xs" value={cfgText} disabled={!canWrite} onChange={(e) => setCfgText(e.target.value)} data-testid="node-config" />
            {node.type === "action" && <Textarea label="Compensate on failure (JSON, optional)" rows={5} className="font-mono text-xs" value={compText} disabled={!canWrite} onChange={(e) => setCompText(e.target.value)} placeholder='{"kind":"http","method":"DELETE","url":"{{secret.baseUrl}}/x/{{nodes.this.body.id}}"}' data-testid="node-compensate" />}
            {cfgErr && <p className="text-xs text-danger" role="alert">{cfgErr}</p>}
            {canWrite && <Button size="sm" variant="secondary" onClick={applyConfig} data-testid="node-apply">Apply config</Button>}
            <div className="text-[11px] text-ink-3">Outgoing: {def.edges.filter((e) => e.from === node.id).map((e) => `${e.to}${e.when ? ` (${e.when})` : ""}`).join(", ") || "none"}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function AddMenu({ onAdd }: { onAdd: (t: AgentNode["type"]) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="relative">
      <Button size="sm" variant="secondary" onClick={() => setOpen(!open)} data-testid="flow-add"><Plus size={14} />Add node</Button>
      {open && <div className="absolute left-0 top-9 z-20 w-44 rounded-lg border border-border bg-surface p-1 shadow-pop">{NODE_TYPES.filter((t) => t !== "trigger").map((t) => <button key={t} onClick={() => { onAdd(t); setOpen(false); }} data-testid={`flow-add-${t}`} className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2">{t}</button>)}</div>}
    </span>
  );
}
