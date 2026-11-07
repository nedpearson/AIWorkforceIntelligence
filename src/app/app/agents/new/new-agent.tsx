"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, Sparkles } from "lucide-react";
import { Badge, Button, Card, CardHeader, Input, Select, PageHeader, Tooltip, Modal } from "@/components/ui";
import { fmtUSD, cn } from "@/lib/utils";
import { CATEGORY_LABELS, type AgentCategory, type RequiredCredential } from "@/engine/agents/templates";
import { createAgent, checkN8n } from "../actions";
import { createCredential } from "../credentials/actions";
import { CREDENTIAL_PRESETS } from "../credentials/presets";

export type TemplateCard = { key: string; category: string; name: string; description: string; runtime: "internal" | "n8n"; monthlyCost: number; baselineMinutesPerRun: number; expectedMinutesSavedPerRun: number; requiredCredentials: RequiredCredential[]; hasN8n: boolean; nodeCount: number; schedule: string | null };
type Cred = { id: string; name: string; provider: string };

export function NewAgent({ templates, recommendedKey, credentials, opportunities, workflows, initialOpportunityId, n8n, canCreds }: { templates: TemplateCard[]; recommendedKey: string | null; credentials: Cred[]; opportunities: { id: string; title: string; workflowId: string | null; realizable: number }[]; workflows: { id: string; name: string }[]; initialOpportunityId: string | null; n8n: { configured: boolean; status: string; lastError: string | null }; canCreds: boolean }) {
  const router = useRouter();
  const [key, setKey] = React.useState<string | null>(recommendedKey && templates.some((t) => t.key === recommendedKey) ? recommendedKey : null);
  const t = templates.find((x) => x.key === key) ?? null;
  const [name, setName] = React.useState(""); const [oppId, setOppId] = React.useState(initialOpportunityId ?? ""); const [wfId, setWfId] = React.useState("");
  const [credIds, setCredIds] = React.useState<string[]>([]); const [mode, setMode] = React.useState<"none" | "sensitive_only" | "all">("sensitive_only"); const [approver, setApprover] = React.useState<"manager" | "admin" | "owner">("manager"); const [timeout, setTimeoutH] = React.useState(72);
  const [schedule, setSchedule] = React.useState(""); const [runtime, setRuntime] = React.useState<"internal" | "n8n">("internal");
  const [creds, setCreds] = React.useState<Cred[]>(credentials); const [newCredProvider, setNewCredProvider] = React.useState<string | null>(null);
  const [n8nLive, setN8nLive] = React.useState<{ checking: boolean; ok: boolean | null; msg: string }>({ checking: false, ok: null, msg: n8n.configured ? `Configured (last status: ${n8n.status})` : "n8n not configured — set N8N_BASE_URL and N8N_API_KEY or add it in Settings → Integrations" });
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState("");
  React.useEffect(() => { if (t) { setName((n) => n || t.name); setRuntime(t.runtime === "n8n" && n8n.configured ? "n8n" : "internal"); setSchedule(t.schedule ?? ""); } }, [t, n8n.configured]);
  React.useEffect(() => { const o = opportunities.find((x) => x.id === oppId); if (o?.workflowId) setWfId(o.workflowId); }, [oppId, opportunities]);
  async function liveCheck() { setN8nLive({ checking: true, ok: null, msg: "Checking…" }); const r = await checkN8n(); setN8nLive({ checking: false, ok: r.ok, msg: r.ok ? `Connected to ${r.baseUrl} (${r.source})` : r.error }); }
  async function submit() {
    if (!t) return; setBusy(true); setErr("");
    const r = await createAgent({ templateKey: t.key, name, opportunityId: oppId || null, workflowId: wfId || null, credentialIds: credIds, approvalPolicy: { mode, approverRole: approver, timeoutHours: timeout }, schedule: schedule || null, runtime });
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    router.push(`/app/agents/${r.id}`);
  }
  const missing = t ? t.requiredCredentials.filter((rc) => !creds.some((c) => credIds.includes(c.id) && c.provider === rc.provider)) : [];

  if (!t) return (
    <div>
      <PageHeader title="New agent" subtitle="Pick a template. Each one says in plain English what it does and what it needs. You can edit the flow afterwards." actions={<Button variant="secondary" href="/app/agents"><ChevronLeft size={15} />Back</Button>} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map((tp) => (
          <button key={tp.key} onClick={() => setKey(tp.key)} data-testid={`template-${tp.key}`} className={cn("card flex flex-col gap-2 p-4 text-left transition hover:border-brand hover:shadow-pop", recommendedKey === tp.key && "border-brand ring-2 ring-brand/20")}>
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{tp.name}</span>{recommendedKey === tp.key && <Badge tone="brand"><Sparkles size={11} className="mr-1" />Recommended</Badge>}</div>
            <div className="text-[11px] uppercase tracking-wide text-ink-3">{CATEGORY_LABELS[tp.category as AgentCategory]}</div>
            <p className="text-xs leading-relaxed text-ink-2">{tp.description}</p>
            <div className="mt-auto flex flex-wrap gap-1.5 pt-1 text-[11px] text-ink-2">
              <Badge tone="neutral">{tp.nodeCount} steps</Badge><Badge tone="neutral">{fmtUSD(tp.monthlyCost)}/mo</Badge><Badge tone="projected">~{tp.expectedMinutesSavedPerRun} min saved / run</Badge>{tp.hasN8n && <Badge tone="info">n8n export</Badge>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader title={`Configure: ${t.name}`} subtitle={t.description} actions={<Button variant="secondary" onClick={() => setKey(null)} data-testid="template-back"><ChevronLeft size={15} />Choose another template</Button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Basics" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Agent name" value={name} onChange={(e) => setName(e.target.value)} data-testid="agent-name" />
              <Select label="Linked opportunity" value={oppId} onChange={(e) => setOppId(e.target.value)} data-testid="agent-opportunity"><option value="">None</option>{opportunities.map((o) => <option key={o.id} value={o.id}>{o.title} — {fmtUSD(o.realizable)}/yr realizable</option>)}</Select>
              <Select label="Linked workflow (for before/after measurement)" value={wfId} onChange={(e) => setWfId(e.target.value)} data-testid="agent-workflow"><option value="">None</option>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
              <Input label="Schedule (cron, optional)" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 7 * * 1" hint="Leave blank for webhook / manual runs. Format: minute hour day month weekday." data-testid="agent-schedule" />
            </div>
          </Card>
          <Card>
            <CardHeader title="Credentials" subtitle="What this template needs to reach your systems. Values are encrypted and never shown again." />
            <div className="space-y-2">
              {t.requiredCredentials.map((rc) => {
                const options = creds.filter((c) => c.provider === rc.provider);
                const chosen = credIds.find((id) => options.some((o) => o.id === id)) ?? "";
                return (
                  <div key={rc.provider} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-end">
                    <Select label={`${rc.label} (${rc.provider})`} value={chosen} onChange={(e) => setCredIds((ids) => [...ids.filter((id) => !options.some((o) => o.id === id)), ...(e.target.value ? [e.target.value] : [])])} data-testid={`cred-select-${rc.provider}`}>
                      <option value="">— choose —</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </Select>
                    {canCreds && <Button variant="secondary" size="sm" onClick={() => setNewCredProvider(rc.provider)} data-testid={`cred-create-${rc.provider}`}>Create</Button>}
                    <span className="text-[11px] text-ink-3">fields: {rc.fields.join(", ")}</span>
                  </div>
                );
              })}
              {missing.length > 0 && <p className="text-xs text-warn">Missing: {missing.map((m) => m.label).join(", ")}. You can save now and attach later; runs that need them will fail with a clear message.</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Human approval" subtitle="Where a person must say yes before the agent changes anything outside BridgeBox." />
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="Policy" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} data-testid="agent-approval-mode"><option value="sensitive_only">Sensitive steps only (recommended)</option><option value="all">Every approval step</option><option value="none">No approvals (fully automatic)</option></Select>
              <Select label="Who can approve" value={approver} onChange={(e) => setApprover(e.target.value as typeof approver)} data-testid="agent-approver"><option value="manager">Manager or above</option><option value="admin">Admin or owner</option><option value="owner">Owner only</option></Select>
              <Input label="Expires after (hours)" type="number" min={1} max={720} value={timeout} onChange={(e) => setTimeoutH(Number(e.target.value) || 72)} data-testid="agent-approval-timeout" />
            </div>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Runtime" subtitle="Where the steps execute." />
            <div className="space-y-2">
              <label className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-3", runtime === "internal" ? "border-brand bg-brand-soft/40" : "border-border")}><input type="radio" name="rt" checked={runtime === "internal"} onChange={() => setRuntime("internal")} data-testid="runtime-internal" /><span className="text-sm"><span className="font-medium">BridgeBox (built-in)</span><br /><span className="text-xs text-ink-2">Runs here with approvals, retries and rollback. Email sending needs n8n or a webhook.</span></span></label>
              <label className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-3", runtime === "n8n" ? "border-brand bg-brand-soft/40" : "border-border", !n8n.configured && "opacity-70")}><input type="radio" name="rt" checked={runtime === "n8n"} onChange={() => setRuntime("n8n")} disabled={!n8n.configured} data-testid="runtime-n8n" /><span className="text-sm"><span className="font-medium">n8n</span> {t.hasN8n ? <Badge tone="info">ready-made workflow</Badge> : <Badge tone="neutral">converted</Badge>}<br /><span className="text-xs text-ink-2">Pushes a workflow to your n8n instance and imports its executions into the run ledger.</span></span></label>
              <div className="rounded-lg bg-surface-2 p-2 text-xs" data-testid="n8n-status">
                <div className="flex items-center justify-between gap-2"><span className={n8nLive.ok ? "text-money" : n8nLive.ok === false ? "text-danger" : "text-ink-2"}>{n8nLive.msg}</span><Button size="sm" variant="ghost" onClick={liveCheck} loading={n8nLive.checking} data-testid="n8n-check">Check</Button></div>
                {n8n.lastError && n8nLive.ok == null && <div className="mt-1 text-danger">{n8n.lastError}</div>}
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title="Economics" subtitle="Assumed until runs are measured." />
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-ink-2">Monthly run cost <Tooltip text="From the implementation profile in the costing engine (platform + model + runtime). Shown on the opportunity's operating cost line." /></dt><dd className="tabular">{fmtUSD(t.monthlyCost)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-2">Baseline minutes per run</dt><dd className="tabular">{t.baselineMinutesPerRun} <Badge tone="warn">assumed</Badge></dd></div>
              <div className="flex justify-between"><dt className="text-ink-2">Expected minutes saved per run</dt><dd className="tabular">{t.expectedMinutesSavedPerRun} <Badge tone="projected">estimated</Badge></dd></div>
            </dl>
          </Card>
          {err && <p className="text-xs text-danger" role="alert" data-testid="agent-create-error">{err}</p>}
          <Button className="w-full" onClick={submit} loading={busy} disabled={name.trim().length < 2} data-testid="agent-create"><Check size={15} />Create agent</Button>
        </div>
      </div>
      <InlineCredentialModal provider={newCredProvider} onClose={() => setNewCredProvider(null)} onCreated={(c) => { setCreds((cs) => [...cs, c]); setCredIds((ids) => [...ids, c.id]); setNewCredProvider(null); }} />
    </div>
  );
}

export function InlineCredentialModal({ provider, onClose, onCreated }: { provider: string | null; onClose: () => void; onCreated: (c: Cred) => void }) {
  const preset = provider ? CREDENTIAL_PRESETS[provider] : null;
  const [name, setName] = React.useState(""); const [values, setValues] = React.useState<Record<string, string>>({}); const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState("");
  React.useEffect(() => { setName(preset ? preset.label : ""); setValues({}); setErr(""); }, [preset]);
  if (!provider || !preset) return null;
  async function save() {
    setBusy(true); setErr("");
    const r = await createCredential({ name, provider, values });
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onCreated({ id: r.id, name, provider: provider! });
  }
  return (
    <Modal open onClose={onClose} title={`New credential: ${preset.label}`}>
      <p className="mb-3 text-xs text-ink-2">{preset.help}</p>
      <div className="space-y-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="cred-name" />
        {preset.fields.map((f) => <Input key={f.name} label={f.label} hint={f.hint} type={f.secret ? "password" : "text"} autoComplete="off" value={values[f.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} data-testid={`cred-field-${f.name}`} />)}
        {err && <p className="text-xs text-danger" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} data-testid="cred-save">Save encrypted</Button></div>
        <p className="text-[11px] text-ink-3">Stored with AES-256-GCM. After saving, only the field names are visible.</p>
      </div>
    </Modal>
  );
}
