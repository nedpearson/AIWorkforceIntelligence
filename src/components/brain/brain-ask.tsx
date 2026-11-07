"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Send, ShieldCheck, FileText, Database, RefreshCw, Plug, ExternalLink } from "lucide-react";
import { Button, Badge, Select } from "@/components/ui";
import { StatusPill } from "@/components/ui/enterprise";
import { askBrainAction, syncSourceAction } from "@/app/app/brain/actions";
import type { Passage } from "@/engine/brain";
import { CitedText, ModeBadge } from "./cited-text";
import { CATEGORY_LABEL, fmtDate, type BrainData } from "./brain-center";

type Answer = { answer: string; citations: { n: number; label: string; href?: string; approvedAt?: string | null }[]; passages: Passage[]; mode: "retrieval" | "llm"; fallback: boolean; note: string; simulated: boolean; asRole: string };
const ROLES = ["owner", "admin", "manager", "employee", "consultant", "viewer"];

export function BrainAsk({ data }: { data: BrainData }) {
  const [q, setQ] = React.useState(""); const [busy, setBusy] = React.useState(false); const [a, setA] = React.useState<Answer | null>(null); const [error, setError] = React.useState<string | null>(null);
  const [simRole, setSimRole] = React.useState(""); const [simDept, setSimDept] = React.useState("");
  const [focus, setFocus] = React.useState<number | null>(null);
  async function ask(question = q) {
    if (question.trim().length < 2) return; setBusy(true); setError(null); setFocus(null);
    const r = await askBrainAction({ question, simulateRole: simRole || undefined, simulateDepartmentId: simDept || null });
    setBusy(false); if (!r.ok) return setError(r.error); setA(r as Answer);
  }
  const examples = ["Who approves invoices over $5,000?", "What are our payment terms?", "How fast do we answer customer emails?", "What is the hotel limit when traveling?"];
  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]" data-testid="brain-ask">
      <div className="space-y-3">
        <form className="card p-4" onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <label htmlFor="brain-q" className="text-sm font-bold">Ask your company&apos;s memory</label>
          <p className="mt-0.5 text-xs text-ink-2">Answers use only approved knowledge the {a?.simulated ? "simulated" : "current"} role may read, with numbered citations.</p>
          <div className="mt-3 flex gap-2">
            <input id="brain-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Who approves invoices over $5,000?" className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm focus:border-purple focus:outline-none focus:ring-2 focus:ring-purple/20" data-testid="brain-ask-input" maxLength={500} />
            <Button type="submit" variant="gradient" loading={busy} disabled={q.trim().length < 2} data-testid="brain-ask-submit" aria-label="Ask"><Send size={15} /><span className="hidden sm:inline">Ask</span></Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">{examples.map((x) => <button key={x} type="button" onClick={() => { setQ(x); ask(x); }} className="rounded-lg bg-surface-2 px-2 py-1 text-[11px] font-medium text-ink-2 hover:text-ink" data-testid="brain-ask-example">{x}</button>)}</div>
          {data.perms.owner && (
            <div className="mt-3 grid gap-2 rounded-xl border border-dashed border-border p-3 sm:grid-cols-2" data-testid="brain-ask-simulate">
              <div className="flex items-center gap-1.5 text-xs font-semibold sm:col-span-2"><ShieldCheck size={14} className="text-cyan-ink" />Verify permissions — answer as another role</div>
              <Select label="Role" value={simRole} onChange={(e) => setSimRole(e.target.value)} data-testid="brain-sim-role"><option value="">Me (owner)</option>{ROLES.filter((r) => r !== "owner").map((r) => <option key={r} value={r}>{r}</option>)}</Select>
              <Select label="Department" value={simDept} onChange={(e) => setSimDept(e.target.value)} disabled={!simRole || ["admin", "consultant"].includes(simRole)} data-testid="brain-sim-dept"><option value="">No department (org-wide only)</option>{data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
            </div>
          )}
        </form>
        {error && <p className="text-xs font-semibold text-coral-ink" role="alert">{error}</p>}
        {a && (
          <div className="card p-5" data-testid="brain-answer" aria-live="polite">
            <div className="mb-2 flex flex-wrap items-center gap-2"><ModeBadge mode={a.mode} />{a.simulated && <Badge tone="cyan">As {a.asRole}</Badge>}{a.fallback && <Badge tone="gold">No approved source</Badge>}</div>
            <CitedText className="text-sm leading-relaxed" text={a.answer} citations={a.citations} onCite={(n) => setFocus(n)} />
            <p className="mt-3 text-[11px] text-ink-3">{a.note}</p>
          </div>
        )}
      </div>
      <div className="card p-4" data-testid="brain-passages">
        <div className="text-sm font-bold">Passages used</div>
        <p className="text-xs text-ink-2">Exactly what the answer was built from, with approval dates.</p>
        {!a ? <p className="mt-4 text-xs text-ink-3">Ask a question to see its sources.</p> : !a.passages.length ? <p className="mt-4 text-xs text-ink-3">No approved passage was available to this role for that question.</p> : (
          <ol className="mt-3 space-y-2">{a.passages.map((p, i) => { const n = a.fallback ? null : i + 1; return (
            <li key={p.id} className={`rounded-xl border p-3 text-xs transition ${focus === n ? "border-purple ring-2 ring-purple/30" : "border-border"}`} data-testid={`brain-passage-${i + 1}`}>
              <div className="flex items-start gap-2">
                {n && <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-purple-soft px-1 text-[10px] font-bold text-purple-ink">{n}</span>}
                {p.kind === "fact" ? <Database size={13} className="mt-0.5 text-indigo-ink" /> : <FileText size={13} className="mt-0.5 text-purple-ink" />}
                <div className="min-w-0 flex-1"><a href={p.citation.href} className="font-semibold text-royal-ink hover:underline">{p.citation.label}</a><div className="text-[11px] text-ink-3">{CATEGORY_LABEL[p.category] ?? p.category} · approved {fmtDate(p.approvedAt ?? null)}</div></div>
              </div>
              <p className="mt-1.5 line-clamp-5 text-ink-2">{p.text}</p>
            </li>); })}</ol>
        )}
      </div>
    </div>
  );
}

export function BrainSources({ data }: { data: BrainData }) {
  const router = useRouter(); const [busy, setBusy] = React.useState<string | null>(null); const [msg, setMsg] = React.useState<Record<string, string>>({});
  async function sync(key: string) { setBusy(key); const r = await syncSourceAction(key); setBusy(null); setMsg({ ...msg, [key]: r.ok ? r.message : r.error }); router.refresh(); }
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 stagger" data-testid="brain-sources">
      {data.sources.map((s) => (
        <div key={s.key} className="card flex flex-col p-4" data-testid={`brain-source-${s.key}`}>
          <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-soft text-cyan-ink"><Plug size={15} /></span><span className="text-sm font-bold">{s.name}</span></div>
            <StatusPill status={s.status === "not_built" ? "not_connected" : s.status} map={{ not_connected: "midnight", available: "royal" }} /></div>
          <p className="mt-2 flex-1 text-xs text-ink-2">{s.description}</p>
          <div className="mt-2 text-[11px] text-ink-3">{s.statusDetail}{s.items ? ` · ${s.items} item${s.items === 1 ? "" : "s"}` : ""}{s.lastSyncedAt ? ` · last synced ${fmtDate(s.lastSyncedAt)}` : ""}</div>
          {msg[s.key] && <p className="mt-2 text-xs font-semibold text-ink-2" role="status">{msg[s.key]}</p>}
          <div className="mt-3 flex gap-2">
            {s.syncable && data.perms.ingest && <Button size="sm" loading={busy === s.key} onClick={() => sync(s.key)} data-testid={`brain-source-sync-${s.key}`}><RefreshCw size={13} />Sync now</Button>}
            {s.href && s.status !== "connected" && <Button size="sm" variant="secondary" href={s.href} data-testid={`brain-source-link-${s.key}`}><ExternalLink size={13} />Integrations</Button>}
          </div>
        </div>))}
    </div>
  );
}
