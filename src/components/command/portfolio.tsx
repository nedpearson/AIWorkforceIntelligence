"use client";
/** Consultancy portfolio command center — every managed client org, rolled up from the finance engine. */
import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, Briefcase, CheckCircle2, Gauge, Lightbulb, Radar } from "lucide-react";
import type { Portfolio } from "@/engine/exports";
import { Badge, Button, Table, Td, Th, Tooltip } from "@/components/ui";
import { KpiCard, SectionHeader, StatusPill } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";
import { fmtValue } from "./format";

const HEALTH: Record<string, { label: string; status: string }> = { healthy: { label: "Healthy", status: "active" }, attention: { label: "Stale collectors", status: "stale" }, offline: { label: "Offline", status: "offline" }, none: { label: "No collectors", status: "not_configured" } };

export function PortfolioCommandCenter({ portfolio: p, orgName }: { portfolio: Portfolio; orgName: string }) {
  const router = useRouter(); const [busy, setBusy] = React.useState<string | null>(null); const [err, setErr] = React.useState<string | null>(null);
  const open = async (orgId: string) => {
    setBusy(orgId); setErr(null);
    const r = await fetch("/api/org/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId }) });
    if (!r.ok) { setErr("Could not open this client."); setBusy(null); return; }
    router.push("/app"); router.refresh();
  };
  const t = p.totals;
  return (
    <div className="space-y-6" data-testid="portfolio-command-center">
      <section className="bg-hero relative overflow-hidden rounded-[22px] px-5 py-6 text-white shadow-[var(--shadow-lift)] sm:px-8 sm:py-8">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(245,158,11,.28),transparent_70%)]" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.16em] text-cyan-300"><Gauge size={14} />Portfolio command center</div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-[2.1rem]">Enterprise Transformation Command Center</h1>
            <p className="mt-1 text-sm text-slate-300"><span className="font-semibold text-white">{orgName}</span> · {p.totalClients} client organization{p.totalClients === 1 ? "" : "s"}{p.capped ? ` (showing the first ${p.rows.length})` : ""}</p>
            {t.realizable > 0 && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-slate-200">Across your clients, AI can return <b className="text-gold">{fmtValue(t.realizable, "usdCompact")}/yr</b> in realizable value; <b className="text-emerald">{t.verified > 0 ? `${fmtValue(t.verified, "usdCompact")}/yr` : "nothing yet"}</b> is verified.</p>}
          </div>
          <Button variant="glass" href="/admin" data-testid="portfolio-admin"><Briefcase size={15} />Manage clients</Button>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 stagger">
        <KpiCard size="lg" testid="pf-realizable" label="Portfolio realizable / yr" accent="gold" icon={<Lightbulb size={16} />} value={t.realizable} format={(v) => fmtValue(v, "usdCompact")} basis="estimated" caption={`${t.opportunities} opportunities`} />
        <KpiCard size="lg" testid="pf-verified" label="Portfolio verified / yr" accent="emerald" icon={<CheckCircle2 size={16} />} value={t.verified > 0 ? t.verified : null} emptyText={<span className="text-xl">Not yet measured</span>} format={(v) => fmtValue(v, "usdCompact")} basis="observed" caption="Annualized measurements" />
        <KpiCard size="lg" testid="pf-agents" label="Deployed AI agents" accent="purple" icon={<Bot size={16} />} value={t.deployedAgents} format={(v) => fmtValue(v, "count")} basis="observed" caption={`across ${t.clients} clients`} />
        <KpiCard size="lg" testid="pf-collectors" label="Collectors active" accent="cyan" icon={<Radar size={16} />} value={t.collectorsActive} format={(v) => fmtValue(v, "count")} basis="observed" caption={`of ${t.collectorsTotal} enrolled`} />
      </div>

      <section>
        <SectionHeader title="Client organizations" subtitle="Ranked by realizable savings · open a client to see its full command center" accent="royal" icon={<Briefcase size={16} />} />
        {err && <p className="mb-2 text-sm text-coral-ink" role="alert">{err}</p>}
        {p.rows.length === 0 ? (
          <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center"><p className="text-sm font-semibold">No client organizations yet</p><p className="max-w-md text-xs text-ink-2">Create a client organization to start an engagement.</p><Button size="sm" href="/admin">Client organizations<ArrowRight size={13} /></Button></div>
        ) : (
          <Table>
            <thead><tr><Th>Client</Th><Th className="text-right">Realizable / yr</Th><Th className="text-right">Net / yr</Th><Th className="text-right">Verified / yr</Th><Th className="text-right">Agents</Th><Th><span className="inline-flex items-center gap-1">Collectors<Tooltip text="Healthy: every active collector reported in the last 24 hours. Stale: at least one active collector has been silent for 24h+." /></span></Th><Th className="text-right">Open</Th></tr></thead>
            <tbody data-testid="portfolio-rows">
              {p.rows.map((r) => (
                <tr key={r.orgId} className="hover:bg-surface-2/50" data-testid={`pf-row-${r.orgId}`}>
                  <Td className="min-w-[200px]"><div className="font-semibold">{r.name}</div><div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-ink-3">{r.industry ?? "—"} · {r.employeesAnalyzed} analyzed{r.isDemo && <Badge tone="neutral">demo</Badge>}</div></Td>
                  <Td className="text-right tabular font-semibold text-gold-ink">{fmtValue(r.realizable, "usdCompact")}</Td>
                  <Td className={cn("text-right tabular", r.net < 0 && "text-coral-ink")}>{fmtValue(r.net, "usdCompact")}</Td>
                  <Td className="text-right tabular font-semibold text-emerald-ink">{r.verifiedMeasurements ? fmtValue(r.verified, "usdCompact") : <span className="font-normal text-ink-3">—</span>}</Td>
                  <Td className="text-right tabular">{r.deployedAgents}</Td>
                  <Td><div className="flex items-center gap-2"><StatusPill status={HEALTH[r.health].status} map={{ stale: "gold" }} /><span className="text-xs text-ink-2 tabular">{r.collectorsActive}/{r.collectorsTotal}</span></div></Td>
                  <Td className="text-right"><Button size="sm" variant="secondary" onClick={() => open(r.orgId)} loading={busy === r.orgId} data-testid={`pf-open-${r.orgId}`}>Open client<ArrowRight size={13} /></Button></Td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="bg-surface-2/60 font-bold"><Td>Total · {t.clients} clients</Td><Td className="text-right tabular text-gold-ink">{fmtValue(t.realizable, "usdCompact")}</Td><Td className="text-right tabular">{fmtValue(t.net, "usdCompact")}</Td><Td className="text-right tabular text-emerald-ink">{t.verified ? fmtValue(t.verified, "usdCompact") : "—"}</Td><Td className="text-right tabular">{t.deployedAgents}</Td><Td className="tabular text-xs">{t.collectorsActive}/{t.collectorsTotal}</Td><Td /></tr></tfoot>
          </Table>
        )}
      </section>
      <p className="text-center text-[11px] text-ink-3">Each client is computed by the same finance engine as its own command center. Projected figures are estimates; verified figures are measured.</p>
    </div>
  );
}
