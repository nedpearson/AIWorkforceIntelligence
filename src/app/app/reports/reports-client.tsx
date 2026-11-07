"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, FileText, Plus } from "lucide-react";
import { Badge, Button, Card, CardHeader, Empty, Input, Modal, PageHeader, Select, Table, Th, Td } from "@/components/ui";
import { cn } from "@/lib/utils";
import { generateReport } from "./actions";
import { useTimeZone } from "@/components/time-zone";
import { formatDate } from "@/lib/datetime";

export type ReportRow = { id: string; kind: string; title: string; periodStart: string | null; periodEnd: string | null; generatedBy: string; createdAt: string; scenario: string; hasPdf: boolean };
type Kind = "executive_roi" | "investment_proposal" | "monthly_performance";

export const REPORT_KINDS: Record<Kind, { label: string; who: string; contains: string[] }> = {
  executive_roi: { label: "Executive ROI summary", who: "For the owner or leadership team", contains: ["Headline: spent on automatable work, achievable per year, verified so far", "Executive summary bullets with ROI, payback and completion", "Savings by department", "Top 10 opportunities ranked by realizable savings", "Scenario comparison and three-year projection", "Every assumption with its basis, and the methodology"] },
  investment_proposal: { label: "Investment proposal", who: "For a board, lender or budget approval", contains: ["Everything in the Executive ROI summary", "A recommendation to approve the implementation budget for the top opportunities", "Conservative-scenario floor so the ask survives scrutiny", "One-time vs recurring cost breakdown"] },
  monthly_performance: { label: "Monthly performance", who: "For a monthly check-in after agents are live", contains: ["Verified savings and hours for the period only (measured, never projected)", "Deployed agents and automation completion against the projection", "Department table with verified dollars", "Period dates on the cover"] },
};
const date = (s: string | null, tz: string) => (s ? formatDate(s, tz, { year: "numeric", month: "short", day: "numeric" }) : "—");
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function ReportsClient({ rows, canGenerate, branding }: { rows: ReportRow[]; canGenerate: boolean; branding: { reportName?: string; primaryColor?: string; footer?: string; logoUrl?: string; orgName: string } }) {
  const tz = useTimeZone();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<Kind>("executive_roi");
  const [scenario, setScenario] = React.useState("expected");
  const [periodStart, setPeriodStart] = React.useState(iso(new Date(Date.now() - 30 * 86400_000)));
  const [periodEnd, setPeriodEnd] = React.useState(iso(new Date()));
  const [busy, setBusy] = React.useState(false);
  const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  async function go() {
    setBusy(true);
    const r = await generateReport({ kind, scenario, periodStart: kind === "monthly_performance" ? periodStart : "", periodEnd: kind === "monthly_performance" ? periodEnd : "" });
    setBusy(false);
    if (r.ok) { setOpen(false); setFlash({ ok: true, text: "Report generated. Download it from the list below." }); router.refresh(); }
    else setFlash({ ok: false, text: r.error });
  }
  const whiteLabel = !!branding.reportName;
  return (
    <div data-testid="reports-page">
      <PageHeader title="Reports" subtitle="Executive PDFs built from the financial model. Projected and verified figures are always shown separately."
        actions={canGenerate ? <Button onClick={() => setOpen(true)} data-testid="reports-generate"><Plus size={15} />Generate report</Button> : undefined} />
      {flash && <div className={cn("mb-3 rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="reports-flash">{flash.text}</div>}

      <div className="mb-5 grid gap-3 md:grid-cols-3" data-testid="reports-previews">
        {(Object.keys(REPORT_KINDS) as Kind[]).map((k) => (
          <Card key={k} className="flex flex-col" data-testid={`reports-preview-${k}`}>
            <CardHeader title={<span className="flex items-center gap-2"><FileText size={15} />{REPORT_KINDS[k].label}</span>} subtitle={REPORT_KINDS[k].who} />
            <ul className="flex-1 space-y-1 text-xs text-ink-2">{REPORT_KINDS[k].contains.map((c) => <li key={c} className="flex gap-1.5"><span className="text-brand">•</span>{c}</li>)}</ul>
            {canGenerate && <Button size="sm" variant="secondary" className="mt-3 self-start" onClick={() => { setKind(k); setOpen(true); }} data-testid={`reports-preview-generate-${k}`}>Generate</Button>}
          </Card>
        ))}
      </div>

      <div className="mb-5 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-ink-2" data-testid="reports-branding">
        {whiteLabel ? <>White-label: reports carry <strong>{branding.reportName}</strong>{branding.primaryColor && <> in <span className="inline-block h-3 w-3 translate-y-0.5 rounded-sm border border-border" style={{ background: branding.primaryColor }} /> {branding.primaryColor}</>}{branding.footer && <>, footer “{branding.footer}”</>}. Change this under Settings → Organization → Branding.</>
          : <>Reports are branded “BridgeBox AI Workforce Intelligence”. Set a report name, color and footer under <a href="/app/settings" className="text-brand">Settings → Organization → Branding</a> to white-label them for {branding.orgName}.</>}
      </div>

      {rows.length === 0 ? <Empty title="No reports yet" body="Generate an Executive ROI summary to get a board-ready PDF of what the model found." action={canGenerate ? <Button onClick={() => setOpen(true)} data-testid="reports-empty-generate"><Plus size={15} />Generate report</Button> : undefined} /> : (
        <Table>
          <thead><tr><Th>Report</Th><Th>Kind</Th><Th>Scenario</Th><Th>Period</Th><Th>Generated by</Th><Th>Date</Th><Th></Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} data-testid={`reports-row-${r.id}`}>
              <Td className="text-xs font-medium">{r.title}</Td>
              <Td><Badge tone="neutral">{REPORT_KINDS[r.kind as Kind]?.label ?? r.kind}</Badge></Td>
              <Td className="text-xs capitalize">{r.scenario || "—"}</Td>
              <Td className="text-xs text-ink-2 whitespace-nowrap">{date(r.periodStart, tz)} → {date(r.periodEnd, tz)}</Td>
              <Td className="text-xs">{r.generatedBy}</Td>
              <Td className="text-xs whitespace-nowrap">{date(r.createdAt, tz)}</Td>
              <Td>{r.hasPdf ? <a href={`/api/reports/${r.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline" data-testid={`reports-download-${r.id}`}><Download size={13} />PDF</a> : <span className="text-xs text-ink-3">no file</span>}</Td>
            </tr>))}</tbody>
        </Table>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Generate a report">
        <div className="space-y-3">
          <Select label="Report" value={kind} onChange={(e) => setKind(e.target.value as Kind)} data-testid="reports-kind">{(Object.keys(REPORT_KINDS) as Kind[]).map((k) => <option key={k} value={k}>{REPORT_KINDS[k].label}</option>)}</Select>
          <p className="text-xs text-ink-2">{REPORT_KINDS[kind].who}. Includes: {REPORT_KINDS[kind].contains.join("; ")}.</p>
          <Select label="Scenario" value={scenario} onChange={(e) => setScenario(e.target.value)} data-testid="reports-scenario"><option value="conservative">Conservative</option><option value="expected">Expected</option><option value="aggressive">Aggressive</option></Select>
          {kind === "monthly_performance" && <div className="grid grid-cols-2 gap-2"><Input type="date" label="Period start" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} data-testid="reports-period-start" /><Input type="date" label="Period end" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} data-testid="reports-period-end" /></div>}
          {kind !== "monthly_performance" && <p className="text-[11px] text-ink-3">Period: trailing 12 months from today (projection basis).</p>}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={go} loading={busy} data-testid="reports-generate-confirm">Generate PDF</Button></div>
        </div>
      </Modal>
    </div>
  );
}
