"use client";
import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardHeader, Empty, Table, Th, Td, Tooltip, Input, Select, Textarea, Modal } from "@/components/ui";
import { fmtUSD, cn } from "@/lib/utils";
import type { SeatUsage } from "@/engine/billing";
import { upsertProject, deleteProject, setPlanLocal, startCheckout, openPortal, syncStripe, generateReportAction } from "@/app/admin/clients/[id]/actions";
import { useAction, ErrorNote } from "./client-workspace";
import { statusTone } from "./portfolio";

// ---------- Projects ----------
export type ProjectRow = { id: string; name: string; status: string; opportunityIds: string[]; agentIds: string[]; budget: number | null; spent: number; startDate: string | null; targetDate: string | null; ownerUserId: string | null; notes: string | null; clientName?: string; clientId?: string };
export type ProjectsData = { projects: ProjectRow[]; opportunities: { id: string; title: string; status: string }[]; agents: { id: string; name: string; status: string }[]; owners: { id: string; label: string }[] };
const PROJECT_STATUSES = ["proposed", "approved", "in_progress", "live", "measuring", "closed"] as const;
export const projectTone = (s: string) => (s === "live" || s === "measuring" ? "money" : s === "in_progress" ? "info" : s === "closed" ? "neutral" : "brand") as "money" | "info" | "neutral" | "brand";

export function ProjectsTab({ d, clientId }: { d: ProjectsData; clientId: string }) {
  const a = useAction();
  const [edit, setEdit] = React.useState<ProjectRow | null | "new">(null);
  const oppName = new Map(d.opportunities.map((o) => [o.id, o.title])); const agName = new Map(d.agents.map((x) => [x.id, x.name])); const ownerName = new Map(d.owners.map((o) => [o.id, o.label]));
  return (
    <div className="space-y-3" data-testid="projects-tab">
      <div className="flex items-center justify-between"><p className="text-sm text-ink-2">{d.projects.length} project(s). Budget {fmtUSD(d.projects.reduce((s, p) => s + (p.budget ?? 0), 0))} · spent {fmtUSD(d.projects.reduce((s, p) => s + p.spent, 0))}</p><Button onClick={() => setEdit("new")} data-testid="project-new">New project</Button></div>
      <ErrorNote error={a.error} />
      {!d.projects.length ? <Empty title="No projects yet" body="A project groups approved opportunities and the agents that deliver them, with a budget and dates." action={<Button onClick={() => setEdit("new")} data-testid="project-new-empty">Create the first project</Button>} /> : (
        <Table><thead><tr><Th>Project</Th><Th>Status</Th><Th>Links</Th><Th className="text-right">Budget</Th><Th className="text-right">Spent</Th><Th>Dates</Th><Th>Owner</Th><Th></Th></tr></thead><tbody>{d.projects.map((p) => (
          <tr key={p.id} data-testid={`project-row-${p.id}`}><Td className="font-medium">{p.name}</Td><Td><Badge tone={projectTone(p.status)}>{p.status.replace("_", " ")}</Badge></Td><Td className="text-xs text-ink-2">{p.opportunityIds.length} opp · {p.agentIds.length} agents</Td><Td className="text-right">{p.budget != null ? fmtUSD(p.budget) : "—"}</Td><Td className={cn("text-right", p.budget != null && p.spent > p.budget && "text-danger")}>{fmtUSD(p.spent)}</Td><Td className="text-xs">{p.startDate ?? "—"} → {p.targetDate ?? "—"}</Td><Td className="text-xs">{p.ownerUserId ? ownerName.get(p.ownerUserId) ?? "—" : "—"}</Td>
            <Td><div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setEdit(p)} data-testid={`project-edit-${p.id}`}>Edit</Button><Button size="sm" variant="ghost" onClick={() => confirm(`Delete project "${p.name}"?`) && a.run(() => deleteProject({ clientId, id: p.id }))} data-testid={`project-delete-${p.id}`}>Delete</Button></div></Td></tr>))}</tbody></Table>
      )}
      <ProjectModal open={edit !== null} onClose={() => setEdit(null)} clientId={clientId} project={edit === "new" ? null : edit} d={d} oppName={oppName} agName={agName} />
    </div>
  );
}
function ProjectModal({ open, onClose, clientId, project, d, oppName, agName }: { open: boolean; onClose: () => void; clientId: string; project: ProjectRow | null; d: ProjectsData; oppName: Map<string, string>; agName: Map<string, string> }) {
  const a = useAction();
  const init = React.useMemo(() => ({ name: project?.name ?? "", status: project?.status ?? "proposed", opportunityIds: project?.opportunityIds ?? [], agentIds: project?.agentIds ?? [], budget: project?.budget != null ? String(project.budget) : "", spent: project ? String(project.spent) : "0", startDate: project?.startDate ?? "", targetDate: project?.targetDate ?? "", ownerUserId: project?.ownerUserId ?? "", notes: project?.notes ?? "" }), [project]);
  const [f, setF] = React.useState(init); React.useEffect(() => setF(init), [init, open]);
  const toggle = (k: "opportunityIds" | "agentIds", id: string) => setF((s) => ({ ...s, [k]: s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] }));
  return (
    <Modal open={open} onClose={onClose} title={project ? "Edit project" : "New project"} wide>
      <form className="space-y-3" data-testid="project-form" onSubmit={async (e) => { e.preventDefault(); const r = await a.run(() => upsertProject({ clientId, id: project?.id, name: f.name, status: f.status, opportunityIds: f.opportunityIds, agentIds: f.agentIds, budget: f.budget ? Number(f.budget) : null, spent: f.spent ? Number(f.spent) : 0, startDate: f.startDate || null, targetDate: f.targetDate || null, ownerUserId: f.ownerUserId || null, notes: f.notes || null })); if (r) onClose(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="project-name" />
          <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} data-testid="project-status">{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</Select>
          <Input label="Budget (USD)" type="number" min={0} value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} data-testid="project-budget" />
          <Input label="Spent (USD)" type="number" min={0} value={f.spent} onChange={(e) => setF({ ...f, spent: e.target.value })} data-testid="project-spent" />
          <Input label="Start date" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} data-testid="project-start" />
          <Input label="Target date" type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} data-testid="project-target" />
          <Select label="Owner" value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} data-testid="project-owner"><option value="">— none —</option>{d.owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="rounded-lg border border-border p-3"><legend className="px-1 text-xs font-medium text-ink-2">Linked opportunities</legend>{!d.opportunities.length ? <p className="text-xs text-ink-3">None yet.</p> : <div className="max-h-40 space-y-1 overflow-y-auto text-xs">{d.opportunities.map((o) => <label key={o.id} className="flex items-center gap-2"><input type="checkbox" checked={f.opportunityIds.includes(o.id)} onChange={() => toggle("opportunityIds", o.id)} data-testid={`project-opp-${o.id}`} /><span className="truncate">{oppName.get(o.id)}</span><span className="text-ink-3">{o.status}</span></label>)}</div>}</fieldset>
          <fieldset className="rounded-lg border border-border p-3"><legend className="px-1 text-xs font-medium text-ink-2">Linked agents</legend>{!d.agents.length ? <p className="text-xs text-ink-3">None yet.</p> : <div className="max-h-40 space-y-1 overflow-y-auto text-xs">{d.agents.map((x) => <label key={x.id} className="flex items-center gap-2"><input type="checkbox" checked={f.agentIds.includes(x.id)} onChange={() => toggle("agentIds", x.id)} data-testid={`project-agent-${x.id}`} /><span className="truncate">{agName.get(x.id)}</span><span className="text-ink-3">{x.status}</span></label>)}</div>}</fieldset>
        </div>
        <Textarea label="Notes" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} data-testid="project-notes" />
        <ErrorNote error={a.error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={a.busy} data-testid="project-save">Save project</Button></div>
      </form>
    </Modal>
  );
}

// ---------- Billing ----------
export type InvoiceRow = { id: string; stripeInvoiceId: string | null; amountCents: number; currency: string; status: string; periodStart: string | null; periodEnd: string | null; pdfUrl: string | null; createdAt: string; lines: { description: string; amountCents: number; qty: number }[] };
export type BillingData = {
  checkout: string | null; stripe: { configured: boolean; missing: string[] }; canChange: boolean; usage: SeatUsage | null;
  sub: { plan: string; status: string; seats: number; agentSlots: number; stripeCustomerId: string | null; stripeSubscriptionId: string | null; currentPeriodEnd: string | null; trialEndsAt: string | null; monthly: { total: number; base: number; extraSeats: number; extraAgents: number; extraSeatCount: number; extraAgentCount: number } } | null;
  plans: { key: string; label: string; priceMonthly: number; seats: number; agents: number; blurb: string }[]; extraSeat: number; extraAgent: number; invoices: InvoiceRow[];
};
export function StripeNotice({ stripe }: { stripe: { configured: boolean; missing: string[] } }) {
  if (stripe.configured) return null;
  return <div className="rounded-lg bg-warn-soft p-3 text-xs text-warn" data-testid="stripe-not-configured"><span className="font-medium">Stripe is not configured.</span> Checkout, portal and sync are disabled until these environment variables are set: <code className="font-mono">{stripe.missing.join(", ")}</code>. Plans can still be set locally (trial / manual invoicing). See docs/BILLING.md.</div>;
}
export function BillingTab({ d, clientId }: { d: BillingData; clientId: string }) {
  const a = useAction();
  const [plan, setPlan] = React.useState(d.sub?.plan ?? "starter"); const [seats, setSeats] = React.useState(String(d.sub?.seats ?? 10)); const [agents, setAgents] = React.useState(String(d.sub?.agentSlots ?? 3)); const [status, setStatus] = React.useState(d.sub?.status ?? "trialing");
  const p = d.plans.find((x) => x.key === plan)!;
  const preview = p.priceMonthly + Math.max(0, Number(seats) - p.seats) * d.extraSeat + Math.max(0, Number(agents) - p.agents) * d.extraAgent;
  const go = async (fn: () => Promise<{ ok: boolean; url?: string }>) => { const r = await a.run(fn as () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, { refresh: false }); if (r && "url" in r) window.location.href = r.url; };
  const u = d.usage;
  return (
    <div className="space-y-4" data-testid="billing-tab">
      {d.checkout === "success" && <div className="rounded-lg bg-money-soft p-3 text-xs text-money" data-testid="checkout-success">Checkout finished. Stripe will confirm by webhook; click “Sync with Stripe” if the status has not updated.</div>}
      {d.checkout === "canceled" && <div className="rounded-lg bg-surface-2 p-3 text-xs">Checkout was cancelled. Nothing changed.</div>}
      <StripeNotice stripe={d.stripe} />
      <ErrorNote error={a.error} missing={a.missing} testid="billing-error" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Current subscription" subtitle={d.sub?.stripeSubscriptionId ? "Managed in Stripe." : "Not linked to Stripe — trial or manual invoicing."} />
          {!d.sub ? <p className="text-sm text-ink-2">No subscription row yet. Set a plan below.</p> : (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-ink-3">Plan</dt><dd className="font-medium capitalize" data-testid="billing-plan">{d.sub.plan}</dd></div>
              <div><dt className="text-xs text-ink-3">Status</dt><dd><Badge tone={statusTone(d.sub.status)}>{d.sub.status.replace("_", " ")}</Badge></dd></div>
              <div><dt className="text-xs text-ink-3">Seats (monitored employees)</dt><dd className={cn("font-medium", u && u.used >= u.seats && "text-warn")} data-testid="billing-seats">{u ? `${u.used} used of ` : ""}{d.sub.seats}</dd></div>
              <div><dt className="text-xs text-ink-3">Agent slots</dt><dd className={cn("font-medium", u?.overAgents && "text-warn")}>{u ? `${u.agentsUsed} used of ` : ""}{d.sub.agentSlots}</dd></div>
              <div><dt className="text-xs text-ink-3">Monthly list price</dt><dd className="font-medium" data-testid="billing-monthly">{fmtUSD(d.sub.monthly.total)}<span className="text-xs font-normal text-ink-3"> = {fmtUSD(d.sub.monthly.base)}{d.sub.monthly.extraSeatCount ? ` + ${d.sub.monthly.extraSeatCount} seats` : ""}{d.sub.monthly.extraAgentCount ? ` + ${d.sub.monthly.extraAgentCount} agent slots` : ""}</span></dd></div>
              <div><dt className="text-xs text-ink-3">{d.sub.status === "trialing" ? "Trial ends" : "Current period ends"}</dt><dd className="font-medium">{(d.sub.status === "trialing" ? d.sub.trialEndsAt : d.sub.currentPeriodEnd) ? new Date((d.sub.status === "trialing" ? d.sub.trialEndsAt : d.sub.currentPeriodEnd)!).toLocaleDateString() : "—"}</dd></div>
              <div className="col-span-2"><dt className="text-xs text-ink-3">Stripe</dt><dd className="font-mono text-xs">{d.sub.stripeCustomerId ?? "no customer"} · {d.sub.stripeSubscriptionId ?? "no subscription"}</dd></div>
            </dl>
          )}
          {u && (u.used >= u.seats || u.overAgents) && <div className="mt-3 rounded-lg bg-warn-soft p-3 text-xs text-warn" data-testid="billing-seat-warning">{u.used >= u.seats ? `All ${u.seats} seats are used. ` : ""}{u.overAgents ? `${u.agentsUsed} agents exceed ${u.agentSlots} slots. ` : ""}Add seats/slots or upgrade the plan.</div>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => go(() => openPortal({ clientId }))} loading={a.busy} disabled={!d.stripe.configured || !d.sub?.stripeCustomerId} data-testid="billing-portal">Manage in Stripe</Button>
            <Button variant="secondary" onClick={() => a.run(() => syncStripe({ clientId }))} loading={a.busy} disabled={!d.stripe.configured || !d.sub?.stripeSubscriptionId} data-testid="billing-sync">Sync with Stripe</Button>
          </div>
        </Card>
        <Card>
          <CardHeader title="Change plan" subtitle={d.canChange ? "Choose a plan and seat count, then either start a Stripe checkout or set it locally." : "Only consultancy owners/admins can change plans."} />
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">{d.plans.map((x) => <button key={x.key} type="button" onClick={() => { setPlan(x.key); setSeats(String(Math.max(x.seats, Number(seats) || 0))); setAgents(String(Math.max(x.agents, Number(agents) || 0))); }} className={cn("rounded-lg border p-3 text-left text-xs", plan === x.key ? "border-brand bg-brand-soft" : "border-border hover:bg-surface-2")} data-testid={`billing-plan-${x.key}`}><div className="font-semibold">{x.label}</div><div>{fmtUSD(x.priceMonthly)}/mo</div><div className="text-ink-3">{x.seats} seats · {x.agents} agents</div></button>)}</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Seats" type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} data-testid="billing-seats-input" hint={`+${fmtUSD(d.extraSeat)}/seat above ${p.seats}`} />
              <Input label="Agent slots" type="number" min={0} value={agents} onChange={(e) => setAgents(e.target.value)} data-testid="billing-agents-input" hint={`+${fmtUSD(d.extraAgent)}/slot above ${p.agents}`} />
              <Select label="Status (local only)" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="billing-status-input">{["trialing", "active", "past_due", "canceled", "unpaid"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</Select>
            </div>
            <div className="rounded-lg bg-surface-2 p-3 text-sm">Monthly list price: <strong data-testid="billing-preview">{fmtUSD(preview)}</strong></div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => go(() => startCheckout({ clientId, plan, seats: Number(seats) }))} loading={a.busy} disabled={!d.canChange} data-testid="billing-checkout">Start Stripe checkout</Button>
              <Button variant="secondary" onClick={() => a.run(() => setPlanLocal({ clientId, plan, seats: Number(seats), agentSlots: Number(agents), status }))} loading={a.busy} disabled={!d.canChange || !!d.sub?.stripeSubscriptionId} data-testid="billing-set-local">Set locally (no Stripe)</Button>
              <Tooltip text="Local changes are for trials and manually invoiced clients. They are audited and never pretend a payment happened." />
            </div>
            {!d.stripe.configured && <p className="text-xs text-ink-3">Checkout will report exactly which Stripe variables are missing.</p>}
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Invoices" subtitle="From Stripe webhooks and sync. Nothing here is generated locally." />
        {!d.invoices.length ? <p className="text-xs text-ink-2" data-testid="invoices-empty">No invoices yet.</p> : (
          <Table><thead><tr><Th>Date</Th><Th>Period</Th><Th>Status</Th><Th className="text-right">Amount</Th><Th>Lines</Th><Th></Th></tr></thead><tbody>{d.invoices.map((i) => (
            <tr key={i.id} data-testid={`invoice-row-${i.id}`}><Td className="text-xs">{new Date(i.createdAt).toLocaleDateString()}</Td><Td className="text-xs">{i.periodStart ? new Date(i.periodStart).toLocaleDateString() : "—"} → {i.periodEnd ? new Date(i.periodEnd).toLocaleDateString() : "—"}</Td><Td><Badge tone={i.status === "paid" ? "money" : i.status === "open" ? "warn" : i.status === "uncollectible" ? "danger" : "neutral"}>{i.status}</Badge></Td><Td className="text-right">{fmtUSD(i.amountCents / 100)} <span className="text-xs uppercase text-ink-3">{i.currency}</span></Td><Td className="text-xs text-ink-2">{i.lines.map((l) => `${l.qty}× ${l.description}`).join("; ") || "—"}</Td><Td>{i.pdfUrl && <a className="text-xs text-brand hover:underline" href={i.pdfUrl} target="_blank" rel="noreferrer">PDF</a>}</Td></tr>))}</tbody></Table>
        )}
      </Card>
    </div>
  );
}

// ---------- Reports ----------
export type ReportRow = { id: string; kind: string; title: string; periodStart: string | null; periodEnd: string | null; createdAt: string; hasPdf: boolean; clientName?: string; clientId?: string };
export type ReportsData = { whiteLabel: boolean; reports: ReportRow[] };
export const REPORT_LABELS: Record<string, string> = { executive_roi: "Executive ROI report", monthly_performance: "Monthly performance report", investment_proposal: "Investment proposal", department: "Department report" };
export function ReportsTab({ d, clientId, clientName }: { d: ReportsData; clientId: string; clientName: string }) {
  const a = useAction(); const [last, setLast] = React.useState("");
  const gen = async (kind: string) => { const r = await a.run(() => generateReportAction({ clientId, kind })); if (r) setLast(r.reportId); };
  return (
    <div className="space-y-4" data-testid="reports-tab">
      <Card>
        <CardHeader title="Generate a report" subtitle={d.whiteLabel ? "White-label branding is on: the client's report name, color and footer are used." : "No white-label name set — reports carry BridgeBox branding. Change this on the Branding tab."} />
        <ErrorNote error={a.error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => gen("executive_roi")} loading={a.busy} data-testid="gen-executive-roi">Executive ROI report</Button>
          <Button variant="secondary" onClick={() => gen("monthly_performance")} loading={a.busy} data-testid="gen-monthly">Monthly performance</Button>
          <Button variant="secondary" onClick={() => gen("investment_proposal")} loading={a.busy} data-testid="gen-proposal">Investment proposal</Button>
        </div>
        {last && <p className="mt-3 text-xs text-money" data-testid="report-generated">Report generated. <a className="underline" href={`/api/admin/reports/${last}?org=${clientId}`} target="_blank" rel="noreferrer">Download PDF</a></p>}
      </Card>
      <ReportList reports={d.reports.map((r) => ({ ...r, clientId, clientName }))} />
    </div>
  );
}
export function ReportList({ reports, showClient }: { reports: ReportRow[]; showClient?: boolean }) {
  if (!reports.length) return <Empty title="No reports yet" body="Generate an executive ROI or monthly performance report above." />;
  return (
    <Table><thead><tr>{showClient && <Th>Client</Th>}<Th>Report</Th><Th>Period</Th><Th>Generated</Th><Th></Th></tr></thead><tbody>{reports.map((r) => (
      <tr key={r.id} data-testid={`report-row-${r.id}`}>{showClient && <Td className="text-xs"><Link className="text-brand hover:underline" href={`/admin/clients/${r.clientId}?tab=reports`}>{r.clientName}</Link></Td>}<Td><div className="font-medium">{r.title}</div><div className="text-xs text-ink-2">{REPORT_LABELS[r.kind] ?? r.kind}</div></Td><Td className="text-xs">{r.periodStart ? new Date(r.periodStart).toLocaleDateString() : "—"} → {r.periodEnd ? new Date(r.periodEnd).toLocaleDateString() : "—"}</Td><Td className="text-xs">{new Date(r.createdAt).toLocaleString()}</Td><Td>{r.hasPdf ? <a className="text-xs text-brand hover:underline" href={`/api/admin/reports/${r.id}?org=${r.clientId}`} target="_blank" rel="noreferrer" data-testid={`report-download-${r.id}`}>Download PDF</a> : <span className="text-xs text-ink-3">no PDF</span>}</Td></tr>))}</tbody></Table>
  );
}
