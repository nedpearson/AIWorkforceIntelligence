"use client";
/**
 * Versions tab: immutable history of the agent definition (every save, policy change, deploy and rollback),
 * a side-by-side structural diff of nodes / edges between any two versions, and "Rollback to version".
 */
import * as React from "react";
import { History, RotateCcw, GitCompare } from "lucide-react";
import { Button, Empty, Badge } from "@/components/ui";
import { SectionHeader } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";
import type { AgentDefinition, AgentNode } from "@/db/schema";
import { diffDefinitions } from "@/engine/agents/versions-diff";
import { rollbackAgentVersion } from "../actions";
import type { VersionRow } from "./agent-detail";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime } from "@/lib/datetime";

const fmt = (iso: string, tz: string) => formatDateTime(iso, tz, { dateStyle: "medium", timeStyle: "short" });
const edgeKey = (e: AgentDefinition["edges"][number]) => `${e.from} → ${e.to}${e.when ? ` [${e.when}]` : ""}`;
const nodeJson = (n: AgentNode | undefined) => (n ? JSON.stringify({ type: n.type, label: n.label, ...(n.sensitive != null ? { sensitive: n.sensitive } : {}), config: n.config, ...(n.compensate ? { compensate: n.compensate } : {}) }, null, 2) : "");

export function VersionsTab({ agentId, versions, current, canWrite, onDone }: { agentId: string; versions: VersionRow[]; current: AgentDefinition; canWrite: boolean; onDone: () => void }) {
  const tz = useTimeZone();
  const [right, setRight] = React.useState<number | null>(versions[0]?.version ?? null);
  const [left, setLeft] = React.useState<number | null>(versions[1]?.version ?? versions[0]?.version ?? null);
  const [busy, setBusy] = React.useState<number | null>(null); const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  if (!versions.length) return <Empty title="No versions yet" body="A version is recorded every time the flow is saved, the approval policy changes, the agent is deployed or rolled back. Save the flow once to start the history." />;
  const L = versions.find((v) => v.version === left) ?? versions[versions.length - 1];
  const R = versions.find((v) => v.version === right) ?? versions[0];
  const diff = diffDefinitions(L.definition, R.definition);
  const latest = versions[0].version;
  const currentMatchesLatest = JSON.stringify(current) === JSON.stringify(versions[0].definition);
  async function rollback(v: number) {
    if (!confirm(`Roll back to v${v}? The current definition and approval policy are replaced by v${v}'s, and a new version "rollback to v${v}" is recorded. Nothing is deleted.`)) return;
    setBusy(v); setMsg(null); const r = await rollbackAgentVersion({ agentId, version: v }); setBusy(null);
    setMsg(r.ok ? { ok: true, text: `Rolled back — now v${r.version} (copy of v${v})` } : { ok: false, text: r.error }); if (r.ok) { setRight(r.version); setLeft(v); onDone(); }
  }
  const allIds = Array.from(new Set([...L.definition.nodes.map((n) => n.id), ...R.definition.nodes.map((n) => n.id)]));
  const stateOf = (id: string) => diff.nodes.added.some((n) => n.id === id) ? "added" : diff.nodes.removed.some((n) => n.id === id) ? "removed" : diff.nodes.changed.some((n) => n.id === id) ? "changed" : "same";
  const edges = Array.from(new Set([...L.definition.edges.map(edgeKey), ...R.definition.edges.map(edgeKey)]));
  const leftEdges = new Set(L.definition.edges.map(edgeKey)), rightEdges = new Set(R.definition.edges.map(edgeKey));
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]" data-testid="versions-tab">
      <div>
        <SectionHeader accent="indigo" icon={<History size={16} />} title="History" subtitle={`${versions.length} version${versions.length === 1 ? "" : "s"} · newest first`} />
        {!currentMatchesLatest && <p className="mb-2 rounded-lg bg-gold-soft px-2 py-1.5 text-[11px] text-gold-ink">The live definition differs from v{latest} (it was edited before history existed). Saving the flow records it.</p>}
        {msg && <p className={cn("mb-2 rounded-lg px-2 py-1.5 text-xs", msg.ok ? "bg-emerald-soft text-emerald-ink" : "bg-coral-soft text-coral-ink")} role="status" data-testid="versions-msg">{msg.text}</p>}
        <ol className="space-y-2 stagger" data-testid="versions-list">
          {versions.map((v) => (
            <li key={v.id} className={cn("card p-3", (v.version === left || v.version === right) && "ring-2 ring-indigo/40")} data-testid={`version-${v.version}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-sm font-bold">v{v.version}{v.version === latest && <Badge tone="emerald" className="ml-2">current</Badge>}</span>
                <span className="text-[11px] text-ink-3">{fmt(v.createdAt, tz)}</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-2">{v.note ?? "—"}</div>
              <div className="text-[11px] text-ink-3">by {v.by} · {v.definition.nodes.length} nodes · {v.definition.edges.length} edges{v.approvalPolicy ? ` · approvals: ${v.approvalPolicy.mode.replace("_", " ")}` : ""}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant={v.version === left ? "primary" : "secondary"} onClick={() => setLeft(v.version)} aria-pressed={v.version === left} data-testid={`version-left-${v.version}`}>Compare from</Button>
                <Button size="sm" variant={v.version === right ? "primary" : "secondary"} onClick={() => setRight(v.version)} aria-pressed={v.version === right} data-testid={`version-right-${v.version}`}>to</Button>
                {canWrite && v.version !== latest && <Button size="sm" variant="ghost" onClick={() => rollback(v.version)} loading={busy === v.version} data-testid={`version-rollback-${v.version}`}><RotateCcw size={13} />Rollback</Button>}
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="min-w-0">
        <SectionHeader accent="purple" icon={<GitCompare size={16} />} title={`v${L.version} → v${R.version}`}
          subtitle={diff.identical ? "No structural differences." : `${diff.nodes.added.length} node(s) added · ${diff.nodes.removed.length} removed · ${diff.nodes.changed.length} changed · ${diff.edges.added.length} edge(s) added · ${diff.edges.removed.length} removed${diff.settings.length ? ` · ${diff.settings.map((s) => s.path).join(", ")} changed` : ""}`} />
        <div className="mb-2 flex flex-wrap gap-2 text-[11px]"><Legend cls="bg-emerald-soft text-emerald-ink" label="added" /><Legend cls="bg-coral-soft text-coral-ink" label="removed" /><Legend cls="bg-gold-soft text-gold-ink" label="changed" /><Legend cls="bg-surface-2 text-ink-2" label="unchanged" /></div>
        {diff.settings.length > 0 && <div className="card mb-3 p-3 text-xs" data-testid="diff-settings">{diff.settings.map((c) => <div key={c.path} className="flex flex-wrap gap-2"><span className="font-semibold">{c.path}</span><span className="font-mono text-coral-ink line-through">{JSON.stringify(c.before)}</span>→<span className="font-mono text-emerald-ink">{JSON.stringify(c.after)}</span></div>)}</div>}
        <div className="card overflow-hidden p-0" data-testid="diff-nodes">
          <div className="grid grid-cols-2 border-b border-border bg-surface-2/70 text-[11px] font-semibold uppercase tracking-wide text-ink-2"><div className="px-3 py-2">v{L.version} nodes</div><div className="border-l border-border px-3 py-2">v{R.version} nodes</div></div>
          {allIds.map((id) => {
            const st = stateOf(id); const a = L.definition.nodes.find((n) => n.id === id); const b = R.definition.nodes.find((n) => n.id === id);
            const changes = diff.nodes.changed.find((c) => c.id === id)?.changes ?? [];
            const tone = st === "added" ? "bg-emerald-soft/60" : st === "removed" ? "bg-coral-soft/60" : st === "changed" ? "bg-gold-soft/60" : "";
            return (
              <details key={id} open={st !== "same"} className="border-b border-border/70 last:border-0" data-testid={`diff-node-${id}`}>
                <summary className={cn("flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs", tone)}>
                  <span className="font-mono font-semibold">{id}</span><span className="text-ink-2">{(b ?? a)?.label}</span><span className="text-[10px] font-semibold uppercase text-ink-3">{st}</span>
                  {changes.length > 0 && <span className="text-[10px] text-ink-3">{changes.map((c) => c.path).join(", ")}</span>}
                </summary>
                <div className="grid grid-cols-2">
                  <pre className={cn("max-h-64 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10.5px]", st === "removed" && "bg-coral-soft/30", st === "changed" && "bg-coral-soft/20")}>{nodeJson(a) || <span className="text-ink-3">—</span>}</pre>
                  <pre className={cn("max-h-64 overflow-auto whitespace-pre-wrap break-all border-l border-border p-2 font-mono text-[10.5px]", st === "added" && "bg-emerald-soft/30", st === "changed" && "bg-emerald-soft/20")}>{nodeJson(b) || <span className="text-ink-3">—</span>}</pre>
                </div>
              </details>
            );
          })}
        </div>
        <div className="card mt-3 overflow-hidden p-0" data-testid="diff-edges">
          <div className="grid grid-cols-2 border-b border-border bg-surface-2/70 text-[11px] font-semibold uppercase tracking-wide text-ink-2"><div className="px-3 py-2">v{L.version} edges</div><div className="border-l border-border px-3 py-2">v{R.version} edges</div></div>
          {edges.map((k) => {
            const inL = leftEdges.has(k), inR = rightEdges.has(k);
            return <div key={k} className="grid grid-cols-2 font-mono text-[11px]">
              <div className={cn("px-3 py-1", !inR && inL && "bg-coral-soft/60 text-coral-ink")}>{inL ? k : ""}</div>
              <div className={cn("border-l border-border px-3 py-1", !inL && inR && "bg-emerald-soft/60 text-emerald-ink")}>{inR ? k : ""}</div>
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}
function Legend({ cls, label }: { cls: string; label: string }) { return <span className={cn("rounded-full px-2 py-0.5 font-semibold", cls)}>{label}</span>; }
