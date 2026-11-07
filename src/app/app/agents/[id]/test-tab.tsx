"use client";
/**
 * Test environment: dry-run the agent with JSON input. Nothing external is called — every HTTP request that a
 * live run would send is shown (secrets redacted), approvals auto-approve, and the run is excluded from savings.
 */
import * as React from "react";
import { FlaskConical, Play, ShieldCheck, Send, CircleCheck, TriangleAlert, Info } from "lucide-react";
import { Button, Empty, Textarea, Badge } from "@/components/ui";
import { SectionHeader, StatusPill } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";
import type { AgentDefinition, RunLog } from "@/db/schema";
import { testRunAgent, getRun } from "../actions";
import type { RunRow } from "./agent-detail";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime, formatTime } from "@/lib/datetime";

type Trace = { id: string; status: string; logs: RunLog[]; error: string | null; createdAt: string };

export function TestTab({ agentId, definition, exampleInput, canWrite, testRuns, onDone }: { agentId: string; definition: AgentDefinition; exampleInput: Record<string, unknown>; canWrite: boolean; testRuns: RunRow[]; onDone: () => void }) {
  const tz = useTimeZone();
  const [input, setInput] = React.useState(JSON.stringify(exampleInput ?? {}, null, 2));
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(testRuns[0]?.id ?? null);
  const [trace, setTrace] = React.useState<Trace | null>(null);
  const load = React.useCallback(async (id: string) => {
    const r = await getRun({ runId: id });
    if (r.ok) setTrace({ id: r.run.id, status: r.run.status, logs: (r.run.logs ?? []) as RunLog[], error: r.run.error, createdAt: new Date(r.run.createdAt).toISOString() });
  }, []);
  React.useEffect(() => { if (selected) void load(selected); }, [selected, load]);
  async function run() {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(input || "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); } catch { setErr("Input must be a JSON object"); return; }
    setBusy(true); setErr(""); const r = await testRunAgent({ agentId, input: parsed }); setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setSelected(r.run.runId); await load(r.run.runId); onDone();
  }
  const label = (id?: string) => definition.nodes.find((n) => n.id === id);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]" data-testid="test-tab">
      <div className="space-y-3">
        <SectionHeader accent="purple" icon={<FlaskConical size={16} />} title="Test environment" subtitle="Dry run — no external system is touched." />
        <ul className="card space-y-1.5 p-3 text-xs text-ink-2">
          <li className="flex gap-2"><Send size={13} className="mt-0.5 shrink-0 text-cyan-ink" />HTTP, action and notify steps log the exact request they would send (credentials redacted) instead of sending it.</li>
          <li className="flex gap-2"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-indigo-ink" />Approval gates auto-approve and say who would have been asked.</li>
          <li className="flex gap-2"><Info size={13} className="mt-0.5 shrink-0 text-gold-ink" />LLM steps still call Claude when ANTHROPIC_API_KEY is set (read-only); otherwise they are skipped. Test runs never count toward hours or dollars saved.</li>
          <li className="flex gap-2"><Info size={13} className="mt-0.5 shrink-0 text-ink-3" />Conditions are evaluated on the synthetic dry-run outputs, so a branch that depends on a real API response may differ from a live run — put the values you expect in the input to steer it.</li>
        </ul>
        <Textarea label="Trigger input (JSON)" rows={12} className="font-mono text-xs" value={input} onChange={(e) => setInput(e.target.value)} disabled={!canWrite} data-testid="test-input" />
        {err && <p className="text-xs text-coral-ink" role="alert" data-testid="test-error">{err}</p>}
        {canWrite ? <Button onClick={run} loading={busy} variant="gradient" data-testid="test-submit"><Play size={15} />Run dry test</Button> : <p className="text-xs text-ink-3">You need agent write access to run tests.</p>}
        {testRuns.length > 0 && <div>
          <div className="mb-1 mt-2 text-xs font-semibold text-ink-2">Recent test runs</div>
          <div className="flex flex-wrap gap-1.5">{testRuns.slice(0, 10).map((r) => <button key={r.id} onClick={() => setSelected(r.id)} aria-pressed={selected === r.id} data-testid={`test-run-${r.id}`} className={cn("rounded-lg border px-2 py-1 text-[11px]", selected === r.id ? "border-purple bg-purple-soft text-purple-ink" : "border-border text-ink-2 hover:bg-surface-2")}>{formatTime(r.createdAt, tz)} · {r.status}</button>)}</div>
        </div>}
      </div>
      <div className="min-w-0">
        <SectionHeader accent="cyan" title="Step-by-step trace" subtitle={trace ? `Run ${trace.id.slice(0, 8)} · ${formatDateTime(trace.createdAt, tz)}` : "Run a test to see what each step would do."} action={trace ? <StatusPill status={trace.status} /> : undefined} />
        {!trace ? <Empty title="No test run selected" body="Edit the sample input and run a dry test. Each step appears here with the request it would have sent." /> : (
          <ol className="space-y-2 stagger" data-testid="test-trace">
            {trace.error && <li className="rounded-xl bg-coral-soft p-3 text-xs text-coral-ink">{trace.error}</li>}
            {trace.logs.map((l, i) => {
              const node = label(l.nodeId); const req = (l.data?.request ?? null) as Record<string, unknown> | null; const would = (l.data?.wouldFail ?? null) as string[] | null;
              return (
                <li key={i} className={cn("card p-3", l.level === "error" && "border-coral/50", l.level === "warn" && "border-gold/50")} data-testid={`trace-step-${i}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[10px] font-bold tabular">{i + 1}</span>
                    {node ? <><Badge tone={node.type === "approval" ? "indigo" : node.type === "llm" ? "purple" : node.type === "action" || node.type === "http" ? "cyan" : "neutral"}>{node.type}</Badge><span className="font-semibold">{node.label}</span></> : <span className="font-semibold text-ink-2">Run</span>}
                    {l.level === "warn" && <TriangleAlert size={13} className="text-gold-ink" />}{l.level === "info" && req && <CircleCheck size={13} className="text-cyan-ink" />}
                  </div>
                  <p className={cn("mt-1 text-xs", l.level === "error" ? "text-coral-ink" : l.level === "warn" ? "text-gold-ink" : "text-ink-2")}>{l.msg}</p>
                  {req && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2 font-mono text-[10.5px]" data-testid={`trace-request-${i}`}>{JSON.stringify(req, null, 2)}</pre>}
                  {would && <p className="mt-1 text-[11px] text-gold-ink">A live run would fail here: {would.join("; ")}</p>}
                  {!req && l.data && !l.data.request && Object.keys(l.data).length > 0 && <details className="mt-1 text-[11px] text-ink-3"><summary className="cursor-pointer">details</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(l.data, null, 1)}</pre></details>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
