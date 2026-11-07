"use client";
import * as React from "react";
import { Button, Empty, PageHeader, Select } from "@/components/ui";
import { OpportunityCard, OPP_TYPE_LABEL, OPP_STATUS_TONE, type OppCardData } from "@/components/dashboard/opportunity-card";
import { OpportunityActions } from "@/components/dashboard/opportunity-actions";
import { fmtUSD, fmtNum } from "@/lib/utils";

export type OppRow = OppCardData & { departmentId: string | null };

export function OpportunitiesList({ rows, departments, canWrite, canAutomate, initial, totals }: { rows: OppRow[]; departments: { id: string; name: string }[]; canWrite: boolean; canAutomate: boolean; initial: { type: string; status: string; dept: string }; totals: { realizable: number; hours: number } }) {
  const [type, setType] = React.useState(initial.type); const [status, setStatus] = React.useState(initial.status); const [dept, setDept] = React.useState(initial.dept);
  const filtered = rows.filter((r) => (!type || r.type === type) && (!status || r.status === status) && (!dept || r.departmentId === dept));
  if (!rows.length) return <div><PageHeader title="Opportunities" /><Empty title="No opportunities yet" body="Opportunities are created by the analysis for every workflow with an automation score of 35 or more. Run a campaign and the analysis first." action={<Button href="/app/onboarding">Open the rollout checklist</Button>} /></div>;
  return (
    <div className="space-y-4">
      <PageHeader title="Opportunities" subtitle={<span>Ranked by realizable savings × feasibility ÷ risk. Together: <span className="tabular font-medium text-projected">{fmtUSD(totals.realizable)}/yr</span> realizable and <span className="tabular font-medium text-projected">{fmtNum(totals.hours, 0)} hrs/wk</span> recoverable (non-rejected).</span>} />
      <div className="flex flex-wrap items-end gap-2">
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-44" data-testid="opp-filter-type" aria-label="Type"><option value="">All types</option>{Object.entries(OPP_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" data-testid="opp-filter-status" aria-label="Status"><option value="">All statuses</option>{Object.keys(OPP_STATUS_TONE).map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</Select>
        <Select value={dept} onChange={(e) => setDept(e.target.value)} className="w-44" data-testid="opp-filter-dept" aria-label="Department"><option value="">All departments</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <span className="self-center text-xs text-ink-3">{filtered.length} of {rows.length}</span>
      </div>
      <div className="space-y-3" data-testid="opp-list">
        {filtered.map((o) => <OpportunityCard key={o.id} o={o} canAutomate={canAutomate} actions={canWrite ? <OpportunityActions id={o.id} status={o.status} /> : undefined} />)}
        {filtered.length === 0 && <Empty title="Nothing matches these filters" />}
      </div>
    </div>
  );
}
