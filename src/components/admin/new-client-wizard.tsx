"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Input, Select, Textarea, PageHeader, Tooltip, Badge } from "@/components/ui";
import { LinkButton } from "@/components/admin/link-button";
import { createClientAction, previewCsvAction, type NewClientResult } from "@/app/admin/clients/new/actions";
import { fmtUSD } from "@/lib/utils";

type Plan = { key: string; label: string; priceMonthly: number; seats: number; agents: number; blurb: string };
const TIMEZONES = ["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "UTC"];
const CSV_EXAMPLE = "name,email,title,department,baseAnnualCost\nAlex Rivera,alex@example.com,AP Specialist,Finance,52000\nJordan Lee,jordan@example.com,Order Entry Clerk,Operations,44000";

export function NewClientWizard({ plans, extraSeat, extraAgent }: { plans: Plan[]; extraSeat: number; extraAgent: number }) {
  const r = useRouter();
  const [step, setStep] = React.useState(0);
  const [f, setF] = React.useState({ name: "", industry: "", timezone: "America/Chicago", adminEmail: "", adminName: "", plan: "starter", seats: "", employeesCsv: "", demo: false });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string>(""); const [csvErrors, setCsvErrors] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<{ rows: number; departments: number } | null>(null);
  const [done, setDone] = React.useState<Extract<NewClientResult, { ok: true }> | null>(null);
  const plan = plans.find((p) => p.key === f.plan)!;
  const seats = f.seats ? Number(f.seats) : plan.seats;
  const extra = Math.max(0, seats - plan.seats);
  const set = (k: keyof typeof f, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));
  const steps = ["Company", "Plan", "People", "Review"];

  async function checkCsv(text: string = f.employeesCsv) {
    if (!text.trim()) { setPreview(null); setCsvErrors([]); return; }
    const p = await previewCsvAction(text); setPreview({ rows: p.rows, departments: p.departments }); setCsvErrors(p.errors);
  }
  async function submit() {
    setBusy(true); setErr(""); setCsvErrors([]);
    const res = await createClientAction({ name: f.name, industry: f.industry || undefined, timezone: f.timezone, adminEmail: f.adminEmail, adminName: f.adminName || undefined, plan: f.plan, seats: f.seats ? Number(f.seats) : undefined, employeesCsv: f.employeesCsv || undefined, demo: f.demo });
    setBusy(false);
    if (!res.ok) { setErr(res.error); setCsvErrors(res.csvErrors ?? []); return; }
    setDone(res);
  }
  const valid0 = f.name.trim().length >= 2 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.adminEmail);

  if (done) return (
    <div className="mx-auto max-w-2xl" data-testid="new-client-done">
      <PageHeader title="Client created" subtitle={`${f.name} now has a workspace, a 14-day trial on the ${plan.label} plan and a default financial model.`} />
      <Card className="space-y-4">
        <div>
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-2">Invitation link for {f.adminEmail}<Tooltip text="Send this link to the client admin. It expires in 14 days and can be used once. We do not send email from this environment." /></div>
          <div className="flex gap-2"><input readOnly value={done.inviteUrl} className="h-9 w-full rounded-lg border border-border bg-surface-2 px-3 font-mono text-xs" data-testid="invite-url" onFocus={(e) => e.currentTarget.select()} /><Button variant="secondary" size="md" onClick={() => navigator.clipboard?.writeText(done.inviteUrl)} data-testid="copy-invite">Copy</Button></div>
        </div>
        <ul className="space-y-1 text-sm text-ink-2">
          <li>Employees imported: <strong className="text-ink">{done.employeesCreated}</strong> in {done.departmentsCreated} new department(s)</li>
          {done.demo && <li>Synthetic demo data: <strong className="text-ink">{done.demo.events.toLocaleString()} events</strong> from {done.demo.collectors} simulated collectors. Analysis is queued — run the worker (<code>npm run worker</code>) or <code>/api/jobs/run</code> to process it.</li>}
          <li>Integrations created as <em>not configured</em> (n8n, Stripe, Anthropic) and <em>license required</em> (Power Automate, UiPath, Mimica).</li>
        </ul>
        <div className="flex flex-wrap gap-2"><LinkButton href={`/admin/clients/${done.orgId}`} data-testid="open-client">Open client workspace</LinkButton><Button variant="secondary" href="/admin">Back to portfolio</Button></div>
      </Card>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl" data-testid="new-client-wizard">
      <PageHeader title="Add a client" subtitle="Creates the client's workspace, a 14-day trial, the default financial model and an invitation for their admin." />
      <ol className="mb-5 flex flex-wrap gap-2 text-xs" data-testid="wizard-steps">
        {steps.map((s, i) => <li key={s} className={"rounded-full px-3 py-1 " + (i === step ? "bg-brand text-white" : i < step ? "bg-brand-soft text-brand" : "bg-surface-2 text-ink-2")}>{i + 1}. {s}</li>)}
      </ol>
      {step === 0 && (
        <Card className="space-y-3" data-testid="step-company">
          <CardHeader title="Company and admin" subtitle="Who the workspace is for and who gets the first login." />
          <Input label="Company name" required value={f.name} onChange={(e) => set("name", e.target.value)} data-testid="client-name" placeholder="Acme Industrial Supply" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Industry" value={f.industry} onChange={(e) => set("industry", e.target.value)} data-testid="client-industry" placeholder="Distribution, dental, legal…" />
            <Select label="Time zone" value={f.timezone} onChange={(e) => set("timezone", e.target.value)} data-testid="client-timezone">{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Client admin email" type="email" required value={f.adminEmail} onChange={(e) => set("adminEmail", e.target.value)} data-testid="client-admin-email" hint="They receive the owner invitation." />
            <Input label="Client admin name" value={f.adminName} onChange={(e) => set("adminName", e.target.value)} data-testid="client-admin-name" />
          </div>
          <div className="flex justify-end"><Button onClick={() => setStep(1)} disabled={!valid0} data-testid="wizard-next-0">Next: plan</Button></div>
        </Card>
      )}
      {step === 1 && (
        <Card className="space-y-4" data-testid="step-plan">
          <CardHeader title="Plan" subtitle={`Trials last 14 days. Extra seats are ${fmtUSD(extraSeat)}/mo each, extra agent slots ${fmtUSD(extraAgent)}/mo each.`} />
          <div className="grid gap-3 sm:grid-cols-3">
            {plans.map((p) => (
              <button key={p.key} type="button" onClick={() => set("plan", p.key)} className={"rounded-xl border p-4 text-left transition " + (f.plan === p.key ? "border-brand bg-brand-soft" : "border-border hover:bg-surface-2")} data-testid={`plan-${p.key}`}>
                <div className="flex items-center justify-between"><span className="text-sm font-semibold">{p.label}</span>{f.plan === p.key && <Badge tone="brand">selected</Badge>}</div>
                <div className="mt-1 text-lg font-semibold">{fmtUSD(p.priceMonthly)}<span className="text-xs font-normal text-ink-2">/mo</span></div>
                <div className="mt-1 text-xs text-ink-2">{p.seats} monitored employees · {p.agents} agents</div>
                <p className="mt-2 text-xs text-ink-3">{p.blurb}</p>
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Monitored employee seats" type="number" min={1} max={10000} value={f.seats} placeholder={String(plan.seats)} onChange={(e) => set("seats", e.target.value)} data-testid="client-seats" hint={extra > 0 ? `${extra} seat(s) above the plan allowance → +${fmtUSD(extra * extraSeat)}/mo` : `Plan includes ${plan.seats} seats`} />
            <div className="rounded-lg bg-surface-2 p-3 text-sm"><div className="text-xs text-ink-2">Monthly list price</div><div className="text-lg font-semibold" data-testid="plan-total">{fmtUSD(plan.priceMonthly + extra * extraSeat)}</div><div className="text-xs text-ink-3">Billed through Stripe once configured; trial until then.</div></div>
          </div>
          <div className="flex justify-between"><Button variant="secondary" onClick={() => setStep(0)}>Back</Button><Button onClick={() => setStep(2)} data-testid="wizard-next-1">Next: people</Button></div>
        </Card>
      )}
      {step === 2 && (
        <Card className="space-y-4" data-testid="step-people">
          <CardHeader title="People (optional)" subtitle="Paste a CSV of employees now, or add them later from the client workspace." />
          <Textarea label="Employees CSV — name, email, title, department, base annual cost" rows={7} value={f.employeesCsv} onChange={(e) => set("employeesCsv", e.target.value)} onBlur={() => checkCsv()} placeholder={CSV_EXAMPLE} data-testid="client-csv" className="font-mono text-xs" />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Button size="sm" variant="secondary" onClick={() => { set("employeesCsv", CSV_EXAMPLE); void checkCsv(CSV_EXAMPLE); }} data-testid="csv-example">Use example</Button>
            <Button size="sm" variant="ghost" onClick={() => checkCsv()} data-testid="csv-check">Check CSV</Button>
            {preview && !csvErrors.length && <span className="text-money" data-testid="csv-preview">{preview.rows} employees, {preview.departments} departments</span>}
          </div>
          {csvErrors.length > 0 && <ul className="rounded-lg bg-danger-soft p-3 text-xs text-danger" data-testid="csv-errors">{csvErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-dashed border-warn/40 bg-warn-soft/40 p-3 text-sm">
            <input type="checkbox" className="mt-0.5" checked={f.demo} onChange={(e) => set("demo", e.target.checked)} data-testid="client-demo" />
            <span><span className="font-medium">Generate synthetic demo data</span> <Badge tone="warn">demo</Badge><br /><span className="text-xs text-ink-2">Adds 6 fictional employees, 10 workdays of generated activity, simulated collectors and consent records, and queues an analysis. The organization is labelled as synthetic everywhere. Use for sales demos and training only.</span></span>
          </label>
          <div className="flex justify-between"><Button variant="secondary" onClick={() => setStep(1)}>Back</Button><Button onClick={() => setStep(3)} data-testid="wizard-next-2" disabled={csvErrors.length > 0}>Next: review</Button></div>
        </Card>
      )}
      {step === 3 && (
        <Card className="space-y-4" data-testid="step-review">
          <CardHeader title="Review" subtitle="What will be created." />
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <R k="Company" v={`${f.name}${f.demo ? " (Synthetic Demo)" : ""}`} /><R k="Industry" v={f.industry || "—"} /><R k="Time zone" v={f.timezone} />
            <R k="Client admin" v={`${f.adminName ? f.adminName + " · " : ""}${f.adminEmail}`} /><R k="Plan" v={`${plan.label} · ${seats} seats · ${plan.agents} agents · ${fmtUSD(plan.priceMonthly + extra * extraSeat)}/mo (14-day trial)`} />
            <R k="Employees" v={f.employeesCsv.trim() ? `${preview?.rows ?? "?"} from CSV` : "none yet"} /><R k="Demo data" v={f.demo ? "yes — labelled synthetic" : "no"} />
          </dl>
          {err && <p className="rounded-lg bg-danger-soft p-3 text-xs text-danger" role="alert" data-testid="new-client-error">{err}</p>}
          {csvErrors.length > 0 && <ul className="rounded-lg bg-danger-soft p-3 text-xs text-danger">{csvErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <div className="flex justify-between"><Button variant="secondary" onClick={() => setStep(2)}>Back</Button><Button onClick={submit} loading={busy} data-testid="wizard-submit">Create client</Button></div>
        </Card>
      )}
      <p className="mt-4 text-center text-xs text-ink-3"><button className="underline" onClick={() => r.push("/admin")}>Cancel</button></p>
    </div>
  );
}
function R({ k, v }: { k: string; v: string }) { return <div><dt className="text-xs text-ink-3">{k}</dt><dd className="font-medium">{v}</dd></div>; }
