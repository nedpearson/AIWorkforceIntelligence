"use client";
import * as React from "react";
import { Button, Empty, PageHeader } from "@/components/ui";
import { fmtUSD, fmtNum } from "@/lib/utils";
import { OpportunityTable, type OppRow } from "./client-workspace";

export type PipelineRow = OppRow & { clientId: string; clientName: string };
const STATUSES = ["identified", "reviewing", "approved", "in_progress", "deployed", "verified", "rejected"];
const TYPES = ["ai_agent", "rpa", "conventional_automation", "process_change", "role_consolidation"];

export function PipelineView({ rows, clients }: { rows: PipelineRow[]; clients: { id: string; name: string }[] }) {
  const [client, setClient] = React.useState(""); const [status, setStatus] = React.useState(""); const [type, setType] = React.useState(""); const [q, setQ] = React.useState("");
  const shown = rows.filter((r) => (!client || r.clientId === client) && (!status || r.status === status) && (!type || r.type === type) && (!q || r.title.toLowerCase().includes(q.toLowerCase())));
  const total = shown.filter((r) => r.status !== "rejected").reduce((s, r) => s + r.realizable, 0);
  const hours = shown.filter((r) => r.status !== "rejected").reduce((s, r) => s + r.hours, 0);
  return (
    <div data-testid="pipeline-page">
      <PageHeader title="Opportunity pipeline" subtitle="Every automation opportunity across all clients, ranked by realizable annual savings." />
      {!rows.length ? <Empty title="No opportunities yet" body="Opportunities appear after a client's analysis has run." action={<Button href="/admin">Go to clients</Button>} /> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="pipeline-filters">
            <select className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" value={client} onChange={(e) => setClient(e.target.value)} data-testid="pipeline-client"><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="pipeline-status"><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
            <select className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" value={type} onChange={(e) => setType(e.target.value)} data-testid="pipeline-type"><option value="">All types</option>{TYPES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select>
            <input className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" placeholder="Search title…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="pipeline-search" />
            <span className="ml-auto text-xs text-ink-2" data-testid="pipeline-summary">{shown.length} shown · <span className="text-projected">{fmtUSD(total)}</span>/yr realizable · {fmtNum(hours, 0)} hrs/wk</span>
          </div>
          {!shown.length ? <Empty title="Nothing matches these filters" /> : <OpportunityTable rows={shown} showClient />}
        </div>
      )}
    </div>
  );
}
