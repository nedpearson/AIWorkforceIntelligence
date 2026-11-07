"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button, Card, CardHeader, Input, Select, Tooltip, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { updateOrganization } from "./actions";

export type OrgFormValues = { name: string; industry: string; timezone: string; currency: string; retentionDays: number; workHoursPerWeek: number; workWeeksPerYear: number; benefitsLoadPct: number; branding: { reportName: string; primaryColor: string; footer: string; logoUrl: string } };
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Mexico_City", "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "UTC"];
const CURRENCIES = ["USD", "CAD", "MXN", "EUR", "GBP", "AUD", "BRL"];

export function OrgForm({ initial, slug, isDemo }: { initial: OrgFormValues; slug: string; isDemo: boolean }) {
  const router = useRouter();
  const [v, setV] = React.useState<OrgFormValues>(initial);
  const [busy, setBusy] = React.useState(false);
  const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  const upd = <K extends keyof OrgFormValues>(k: K, val: OrgFormValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const updB = (k: keyof OrgFormValues["branding"], val: string) => setV((s) => ({ ...s, branding: { ...s.branding, [k]: val } }));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const r = await updateOrganization(v); setBusy(false);
    setFlash(r.ok ? { ok: true, text: "Organization settings saved." } : { ok: false, text: r.error });
    if (r.ok) router.refresh();
  }
  const color = /^#[0-9a-fA-F]{6}$/.test(v.branding.primaryColor) ? v.branding.primaryColor : null;
  return (
    <form onSubmit={submit} className="space-y-4" data-testid="org-form">
      {flash && <div className={cn("rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="org-flash">{flash.text}</div>}
      <Card>
        <CardHeader title="Organization" subtitle={<>Slug <code>{slug}</code>{isDemo && <Badge tone="warn" className="ml-2">synthetic demo</Badge>}</>} />
        <div className="grid gap-3 md:grid-cols-2">
          <Input label="Name" value={v.name} onChange={(e) => upd("name", e.target.value)} required data-testid="org-name" />
          <Input label="Industry" value={v.industry} onChange={(e) => upd("industry", e.target.value)} placeholder="e.g. Industrial distribution" data-testid="org-industry" />
          <Select label="Timezone" value={v.timezone} onChange={(e) => upd("timezone", e.target.value)} data-testid="org-timezone">{[...new Set([v.timezone, ...TIMEZONES])].map((t) => <option key={t} value={t}>{t}</option>)}</Select>
          <Select label="Currency" value={v.currency} onChange={(e) => upd("currency", e.target.value)} data-testid="org-currency">{[...new Set([v.currency, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          <Input type="number" label="Activity retention (days, 30–730)" min={30} max={730} value={v.retentionDays} onChange={(e) => upd("retentionDays", Number(e.target.value))} hint="Raw activity events older than this are deleted by the nightly sweep. Workflows and savings derived from them are kept." data-testid="org-retention" />
        </div>
      </Card>
      <Card>
        <CardHeader title="Work and cost defaults" subtitle="Used by the financial model to turn observed hours into loaded cost. The Financial Model page can override them per scenario." />
        <div className="grid gap-3 md:grid-cols-3">
          <Input type="number" label="Work hours per week" min={1} max={80} step={0.5} value={v.workHoursPerWeek} onChange={(e) => upd("workHoursPerWeek", Number(e.target.value))} data-testid="org-hours-week" />
          <Input type="number" label="Working weeks per year" min={30} max={52} step={1} value={v.workWeeksPerYear} onChange={(e) => upd("workWeeksPerYear", Number(e.target.value))} hint="After PTO and holidays." data-testid="org-weeks-year" />
          <label className="block text-sm"><span className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-2">Benefits & taxes load (%)<Tooltip text="Employer taxes and benefits added on top of base pay. 30% is a common US default." /></span>
            <input type="number" min={0} max={100} step={1} value={Math.round(v.benefitsLoadPct * 100)} onChange={(e) => upd("benefitsLoadPct", Number(e.target.value) / 100)} className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm" data-testid="org-benefits" /></label>
        </div>
      </Card>
      <Card>
        <CardHeader title="Branding (white-label reports)" subtitle="Leave blank to use BridgeBox branding. The report name replaces “BridgeBox AI Workforce Intelligence” on PDF covers and footers." action={<span className="flex items-center gap-2 text-xs text-ink-2" data-testid="org-brand-preview"><span className="inline-block h-5 w-5 rounded-md border border-border" style={{ background: color ?? "var(--color-brand)" }} />{color ?? "default"}</span>} />
        <div className="grid gap-3 md:grid-cols-2">
          <Input label="Report name" value={v.branding.reportName} onChange={(e) => updB("reportName", e.target.value)} placeholder="e.g. Acme Advisory — Automation Review" data-testid="org-brand-name" />
          <Input label="Primary color (hex)" value={v.branding.primaryColor} onChange={(e) => updB("primaryColor", e.target.value)} placeholder="#0f766e" pattern="^#[0-9a-fA-F]{6}$" data-testid="org-brand-color" />
          <Input label="Footer line" value={v.branding.footer} onChange={(e) => updB("footer", e.target.value)} placeholder="e.g. Prepared by Acme Advisory — Confidential" data-testid="org-brand-footer" />
          <Input label="Logo URL" value={v.branding.logoUrl} onChange={(e) => updB("logoUrl", e.target.value)} placeholder="https://…/logo.png" data-testid="org-brand-logo" hint="Shown in the app header when set. PDF covers use the report name and color." />
        </div>
      </Card>
      <div className="flex justify-end"><Button type="submit" loading={busy} data-testid="org-save"><Save size={15} />Save settings</Button></div>
    </form>
  );
}
