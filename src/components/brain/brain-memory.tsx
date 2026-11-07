"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Plus, Pencil, CheckCircle2, XCircle, Bot, FileText, Database } from "lucide-react";
import { Button, Badge, Input, Select, Textarea, Modal, Empty } from "@/components/ui";
import { StatusPill, SectionHeader } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";
import { proposeFactAction, decideAction, learnFromPlatformAction } from "@/app/app/brain/actions";
import { CATEGORY_LABEL, fmtDate, type BrainData, type BrainFact } from "./brain-center";
import { useTimeZone } from "@/components/time-zone";

const CATS = ["company", "policy", "procedure", "pricing", "product", "customer", "vendor", "terminology", "goal", "decision", "preference", "system", "general"];
const sourceLabel = (ref: string | null) => !ref ? null : ref.startsWith("bridgebox:") ? "Derived from BridgeBox data" : ref.startsWith("hubspot:") ? "Derived from HubSpot" : "Derived";

export function BrainMemory({ data, deptName, highlight }: { data: BrainData; deptName: Map<string, string>; highlight: string | null }) {
  const tz = useTimeZone();
  const router = useRouter();
  const [edit, setEdit] = React.useState<{ fact?: BrainFact; category: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null); const [msg, setMsg] = React.useState<string | null>(null);
  const [cat, setCat] = React.useState("");
  React.useEffect(() => { if (highlight) document.getElementById(`fact-${highlight}`)?.scrollIntoView({ block: "center" }); }, [highlight]);
  const facts = data.facts.filter((f) => !cat || f.category === cat);
  const groups = CATS.map((c) => ({ c, items: facts.filter((f) => f.category === c) })).filter((g) => g.items.length);
  async function learn() { setBusy("learn"); setMsg(null); const r = await learnFromPlatformAction(); setBusy(null); setMsg(r.ok ? (r.created ? `${r.created} new fact${r.created === 1 ? "" : "s"} proposed from your BridgeBox data — they are waiting in the review queue.` : `BridgeBox checked ${r.proposed} facts — nothing new to propose.`) : r.error); router.refresh(); }
  async function decide(f: BrainFact, decision: "approve" | "reject") { setBusy(f.id + decision); const r = await decideAction({ items: [{ kind: "fact", id: f.id }], decision }); setBusy(null); if (!r.ok) setMsg(r.error); router.refresh(); }
  return (
    <div data-testid="brain-memory">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {data.perms.ingest && <Button onClick={learn} loading={busy === "learn"} data-testid="brain-learn"><Sparkles size={15} />Learn from BridgeBox</Button>}
        {data.perms.ingest && <Button variant="secondary" onClick={() => setEdit({ category: "company" })} data-testid="brain-fact-new"><Plus size={15} />Add a fact</Button>}
        <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="ml-auto h-9 rounded-lg border border-border bg-surface px-2 text-xs" data-testid="brain-fact-category"><option value="">All categories</option>{CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
      </div>
      {msg && <p className="mb-3 text-xs font-semibold text-ink-2" role="status" data-testid="brain-memory-msg">{msg}</p>}
      {!groups.length ? <Empty title="No business memory yet" body={'Facts are short, approved statements ("Payment terms are Net 30"). Let BridgeBox propose the ones it already knows from your data, or add your own.'} /> : groups.map((g) => (
        <section key={g.c} className="mb-5">
          <SectionHeader title={CATEGORY_LABEL[g.c]} subtitle={`${g.items.filter((f) => f.status === "approved").length} approved · ${g.items.filter((f) => f.status === "pending_review").length} pending`} accent="indigo" />
          <div className="grid gap-2 md:grid-cols-2">
            {g.items.map((f) => (
              <div key={f.id} id={`fact-${f.id}`} className={cn("card p-3.5", highlight === f.id && "ring-2 ring-purple")} data-testid={`brain-fact-${f.id}`}>
                <div className="flex items-start justify-between gap-2"><div className="text-sm font-semibold">{f.subject}</div><StatusPill status={f.status} map={{ pending_review: "gold" }} /></div>
                <p className="mt-1 text-sm text-ink-2">{f.statement}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                  {sourceLabel(f.sourceRef) && <Badge tone="cyan">{sourceLabel(f.sourceRef)}</Badge>}
                  {f.version > 1 && <Badge tone="purple">v{f.version} correction</Badge>}
                  <span>{f.departmentId ? deptName.get(f.departmentId) : "Org-wide"} · {f.approvedAt ? `approved ${fmtDate(f.approvedAt, tz)}` : `proposed ${fmtDate(f.createdAt, tz)}`}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {f.status === "pending_review" && f.canApprove && <><Button size="sm" loading={busy === f.id + "approve"} onClick={() => decide(f, "approve")} data-testid={`brain-fact-approve-${f.id}`}><CheckCircle2 size={13} />Approve</Button><Button size="sm" variant="ghost" loading={busy === f.id + "reject"} onClick={() => decide(f, "reject")} data-testid={`brain-fact-reject-${f.id}`}><XCircle size={13} />Reject</Button></>}
                  {f.status === "approved" && data.perms.ingest && <Button size="sm" variant="ghost" onClick={() => setEdit({ fact: f, category: f.category })} data-testid={`brain-fact-correct-${f.id}`}><Pencil size={13} />Correct</Button>}
                </div>
              </div>))}
          </div>
        </section>))}
      {edit && <FactModal data={data} init={edit} onClose={() => setEdit(null)} onDone={(m) => { setEdit(null); setMsg(m); router.refresh(); }} />}
    </div>
  );
}

function FactModal({ data, init, onClose, onDone }: { data: BrainData; init: { fact?: BrainFact; category: string }; onClose: () => void; onDone: (m: string) => void }) {
  const f = init.fact;
  const [category, setCategory] = React.useState(init.category); const [subject, setSubject] = React.useState(f?.subject ?? ""); const [statement, setStatement] = React.useState(f?.statement ?? "");
  const [dept, setDept] = React.useState(f?.departmentId ?? ""); const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<string | null>(null);
  async function submit() {
    setBusy(true); setError(null);
    const r = await proposeFactAction({ category, subject, statement, departmentId: dept || null, supersedesId: f?.id ?? null });
    setBusy(false); if (!r.ok) return setError(r.error);
    onDone(r.duplicate ? "That fact is already in business memory." : f ? "Correction submitted as a new version — the current fact stays in use until it is approved." : "Fact proposed — it is waiting in the review queue.");
  }
  return (
    <Modal open onClose={onClose} title={f ? "Correct a fact" : "Add a fact"}>
      <div className="space-y-3" data-testid="brain-fact-form">
        {f && <p className="rounded-lg bg-surface-2 p-2 text-xs text-ink-2">Current (v{f.version}): {f.statement}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)} data-testid="brain-fact-cat">{CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select>
          <Select label="Department" value={dept} onChange={(e) => setDept(e.target.value)} data-testid="brain-fact-dept"><option value="">Org-wide</option>{data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        </div>
        <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Standard payment terms" data-testid="brain-fact-subject" />
        <Textarea label="Statement" rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="e.g. Vendor invoices are paid Net 30 unless the contract says otherwise." data-testid="brain-fact-statement" />
        {error && <p className="text-xs font-semibold text-coral-ink" role="alert">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={subject.trim().length < 2 || statement.trim().length < 5} onClick={submit} data-testid="brain-fact-submit">{f ? "Submit correction" : "Propose fact"}</Button></div>
      </div>
    </Modal>
  );
}

export function BrainReview({ data, deptName }: { data: BrainData; deptName: Map<string, string> }) {
  const tz = useTimeZone();
  const router = useRouter();
  const [kind, setKind] = React.useState<"" | "document" | "fact" | "memory">("");
  const [sel, setSel] = React.useState<Set<string>>(new Set()); const [busy, setBusy] = React.useState<string | null>(null); const [msg, setMsg] = React.useState<string | null>(null);
  const items = data.queue.filter((q) => !kind || q.kind === kind);
  const approvable = items.filter((i) => i.canApprove);
  const allSel = approvable.length > 0 && approvable.every((i) => sel.has(i.id));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  async function run(decision: "approve" | "reject", ids: string[]) {
    const list = data.queue.filter((q) => ids.includes(q.id)).map((q) => ({ kind: q.kind, id: q.id }));
    if (!list.length) return; setBusy(decision + ids.join()); setMsg(null);
    const r = await decideAction({ items: list, decision }); setBusy(null);
    setMsg(r.ok ? `${r.done} item${r.done === 1 ? "" : "s"} ${decision === "approve" ? "approved" : "rejected"}${r.denied ? `; ${r.denied} outside your department were skipped` : ""}.` : r.error);
    setSel(new Set()); router.refresh();
  }
  const Icon = { document: FileText, fact: Database, memory: Bot };
  return (
    <div data-testid="brain-review">
      <div className="card mb-3 flex flex-wrap items-center gap-2 p-2.5">
        <label className="flex items-center gap-2 px-1 text-xs font-semibold"><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(approvable.map((i) => i.id)))} data-testid="brain-review-all" aria-label="Select all" />Select all</label>
        <select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" data-testid="brain-review-kind"><option value="">All types</option><option value="document">Documents</option><option value="fact">Facts</option><option value="memory">AI employee memory</option></select>
        <div className="ml-auto flex gap-2">
          <Button size="sm" disabled={!sel.size} loading={busy?.startsWith("approve")} onClick={() => run("approve", [...sel])} data-testid="brain-review-bulk-approve"><CheckCircle2 size={14} />Approve {sel.size || ""}</Button>
          <Button size="sm" variant="secondary" disabled={!sel.size} loading={busy?.startsWith("reject")} onClick={() => run("reject", [...sel])} data-testid="brain-review-bulk-reject"><XCircle size={14} />Reject</Button>
        </div>
      </div>
      {data.role === "manager" && <p className="mb-3 text-xs text-ink-2">As a manager you can approve items scoped to your own department{data.myDepartmentId ? ` (${deptName.get(data.myDepartmentId)})` : " — your account is not linked to a department, so org-wide items need an owner or admin"}.</p>}
      {msg && <p className="mb-3 text-xs font-semibold text-ink-2" role="status" data-testid="brain-review-msg">{msg}</p>}
      {!items.length ? <Empty title="Nothing waiting for review" body="New uploads, proposed facts and lessons AI employees want to remember will appear here." /> : (
        <ul className="space-y-2 stagger">{items.map((i) => { const I = Icon[i.kind]; return (
          <li key={i.kind + i.id} className="card flex items-start gap-3 p-3.5" data-testid={`brain-review-item-${i.id}`}>
            <input type="checkbox" className="mt-1" disabled={!i.canApprove} checked={sel.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${i.title}`} data-testid={`brain-review-check-${i.id}`} />
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", i.kind === "memory" ? "bg-purple-soft text-purple-ink" : i.kind === "fact" ? "bg-indigo-soft text-indigo-ink" : "bg-royal-soft text-royal-ink")}><I size={15} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5"><span className="text-sm font-semibold">{i.title}</span>{i.kind === "memory" && <Badge tone="purple">AI Agent memory</Badge>}{i.derived && <Badge tone="cyan">Derived</Badge>}{(i.version ?? 1) > 1 && <Badge tone="purple">v{i.version}</Badge>}</div>
              <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{i.detail}</p>
              <div className="mt-1 text-[11px] text-ink-3">{CATEGORY_LABEL[i.category] ?? i.category} · {i.departmentId ? deptName.get(i.departmentId) ?? "Department" : "Org-wide"} · {fmtDate(i.createdAt, tz)}{!i.canApprove && " · outside your approval scope"}</div>
            </div>
            {i.canApprove && <div className="flex shrink-0 flex-col gap-1 sm:flex-row"><Button size="sm" loading={busy === "approve" + i.id} onClick={() => run("approve", [i.id])} data-testid={`brain-review-approve-${i.id}`} aria-label={`Approve ${i.title}`}><CheckCircle2 size={13} /></Button><Button size="sm" variant="ghost" loading={busy === "reject" + i.id} onClick={() => run("reject", [i.id])} data-testid={`brain-review-reject-${i.id}`} aria-label={`Reject ${i.title}`}><XCircle size={13} /></Button></div>}
          </li>); })}</ul>
      )}
    </div>
  );
}
