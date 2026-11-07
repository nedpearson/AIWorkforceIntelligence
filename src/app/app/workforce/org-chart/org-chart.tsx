"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Network, ZoomIn, ZoomOut, Maximize2, Info, Users, Bot, Clock, BadgeDollarSign, Workflow } from "lucide-react";
import { PageHeader, Button, Empty, Badge } from "@/components/ui";
import { FilterBar, Segmented, Drawer, StatusPill, KpiCard, Meter } from "@/components/ui/enterprise";
import { AiAvatar, AiBadge, HumanAvatar } from "@/components/workforce/avatar";
import { cn, fmtNum, fmtUSD, fmtPct } from "@/lib/utils";
import type { OrgChart, HumanNode, AiNode, DeptSummary } from "@/engine/workforce/orgchart";

type Sel = { kind: "human"; n: HumanNode } | { kind: "ai"; n: AiNode } | null;

export function OrgChartView({ chart, deptOptions, locOptions }: { chart: OrgChart; deptOptions: { value: string; label: string }[]; locOptions: { value: string; label: string }[] }) {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const [sel, setSel] = React.useState<Sel>(null);
  const setMode = (m: string) => { const q = new URLSearchParams(sp.toString()); if (m === "proposed") q.set("mode", m); else q.delete("mode"); router.push(`${pathname}?${q}`, { scroll: false }); };
  const totalHours = chart.departments.reduce((s, d) => s + d.workflowHoursPerWeek, 0); const covered = chart.departments.reduce((s, d) => s + d.coveredHoursPerWeek, 0);
  const value = chart.ai.reduce((s, a) => s + a.projectedValue, 0);
  return (
    <div>
      <PageHeader hero eyebrow="AI Workforce" icon={<Network size={22} />} title="Org chart: people + AI agents" subtitle="See where AI employees support each department and which person approves their work. People are circles; AI agents are rounded squares with an AI badge."
        actions={<Segmented testid="oc-mode" value={chart.mode} onChange={setMode} options={[{ key: "current", label: "Current" }, { key: "proposed", label: "Proposed operating model" }]} />} />
      <FilterBar testid="oc-filters" filters={[{ key: "dept", label: "Department", options: deptOptions }, { key: "loc", label: "Location", options: locOptions }]} />
      {chart.mode === "proposed" && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-gold/40 bg-gold-soft/50 p-4 text-sm" role="note" data-testid="oc-advisory">
          <Info size={18} className="mt-0.5 shrink-0 text-gold-ink" />
          <div><b>Advisory model.</b> The proposed view adds AI employees BridgeBox recommends for observed workflows. It shows capacity that could be released — not headcount changes. Any change to roles or staffing requires management and HR/legal review; BridgeBox makes no recommendations about individual jobs.</div>
        </div>
      )}
      <div className="stagger mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="People" value={chart.counts.humans} format={(n) => fmtNum(n)} accent="royal" icon={<Users size={16} />} testid="oc-kpi-humans" />
        <KpiCard label="AI employees" value={chart.counts.ai} format={(n) => fmtNum(n)} accent="purple" icon={<Bot size={16} />} caption={chart.counts.proposedAi ? `+${chart.counts.proposedAi} proposed` : undefined} testid="oc-kpi-ai" />
        <KpiCard label="Automation coverage" value={totalHours ? covered / totalHours : 0} format={(n) => fmtPct(n)} accent="cyan" icon={<Workflow size={16} />} caption={`${fmtNum(covered, 1)} of ${fmtNum(totalHours, 1)} workflow hrs/wk`} hint="Share of observed workflow hours that an AI employee is assigned to" testid="oc-kpi-coverage" />
        <KpiCard label="Projected value" value={value} format={(n) => fmtUSD(n)} accent="gold" icon={<BadgeDollarSign size={16} />} caption="recovered capacity / yr · estimated" testid="oc-kpi-value" />
      </div>
      {chart.departments.length === 0 ? <Empty title="No departments match" body="Clear the filters, or add departments and employees under Departments." /> : (
        <>
          <div className="hidden md:block"><Canvas chart={chart} onSelect={setSel} /></div>
          <div className="md:hidden"><MobileList chart={chart} onSelect={setSel} /></div>
        </>
      )}
      <Drawer open={!!sel} onClose={() => setSel(null)} title={sel ? (sel.kind === "ai" ? `${sel.n.name} — AI agent` : sel.n.name) : ""} testid="oc-drawer">{sel && <NodeDetail sel={sel} chart={chart} />}</Drawer>
    </div>
  );
}

// ---------------------------------------------------------------- canvas with pan/zoom + connectors
function Canvas({ chart, onSelect }: { chart: OrgChart; onSelect: (s: Sel) => void }) {
  const wrap = React.useRef<HTMLDivElement>(null); const inner = React.useRef<HTMLDivElement>(null);
  const [z, setZ] = React.useState(1); const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const drag = React.useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [lines, setLines] = React.useState<{ x1: number; y1: number; x2: number; y2: number; dashed: boolean; key: string }[]>([]);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const zoom = (d: number) => setZ((v) => Math.min(1.8, Math.max(0.4, +(v + d).toFixed(2))));
  React.useLayoutEffect(() => {
    const root = inner.current; if (!root) return;
    const calc = () => {
      const base = root.getBoundingClientRect(); const s = base.width / root.offsetWidth || 1;
      const pos = (id: string) => { const el = root.querySelector<HTMLElement>(`[data-node="${id}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { cx: (r.left - base.left + r.width / 2) / s, top: (r.top - base.top) / s, bottom: (r.bottom - base.top) / s, left: (r.left - base.left) / s, right: (r.right - base.left) / s }; };
      const out: typeof lines = [];
      for (const h of chart.humans) { if (!h.managerId) continue; const a = pos(h.managerId), b = pos(h.id); if (a && b) out.push({ x1: a.cx, y1: a.bottom, x2: b.cx, y2: b.top, dashed: false, key: `m-${h.id}` }); }
      for (const n of chart.ai) { if (!n.approvalOwnerEmployeeId) continue; const a = pos(n.approvalOwnerEmployeeId), b = pos(n.id); if (a && b) out.push({ x1: a.cx, y1: a.bottom, x2: b.cx, y2: b.top, dashed: true, key: `a-${n.id}` }); }
      setLines(out); setSize({ w: root.offsetWidth, h: root.offsetHeight });
    };
    calc(); const ro = new ResizeObserver(calc); ro.observe(root); return () => ro.disconnect();
  }, [chart]);
  const onKey = (e: React.KeyboardEvent) => {
    const step = 40;
    if (e.key === "+" || e.key === "=") zoom(0.1); else if (e.key === "-") zoom(-0.1); else if (e.key === "0") { setZ(1); setPan({ x: 0, y: 0 }); }
    else if (e.key === "ArrowLeft") setPan((p) => ({ ...p, x: p.x + step })); else if (e.key === "ArrowRight") setPan((p) => ({ ...p, x: p.x - step }));
    else if (e.key === "ArrowUp") setPan((p) => ({ ...p, y: p.y + step })); else if (e.key === "ArrowDown") setPan((p) => ({ ...p, y: p.y - step })); else return;
    e.preventDefault();
  };
  return (
    <div className="card relative overflow-hidden p-0">
      <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-xl border border-border bg-surface/90 p-1 backdrop-blur">
        <button className="rounded-lg p-1.5 hover:bg-surface-2" onClick={() => zoom(0.1)} aria-label="Zoom in" data-testid="oc-zoom-in"><ZoomIn size={16} /></button>
        <button className="rounded-lg p-1.5 hover:bg-surface-2" onClick={() => zoom(-0.1)} aria-label="Zoom out" data-testid="oc-zoom-out"><ZoomOut size={16} /></button>
        <button className="rounded-lg p-1.5 hover:bg-surface-2" onClick={() => { setZ(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset view" data-testid="oc-zoom-reset"><Maximize2 size={16} /></button>
      </div>
      <div className="absolute bottom-3 left-3 z-10 flex flex-wrap gap-3 rounded-xl border border-border bg-surface/90 px-3 py-1.5 text-[11px] text-ink-2 backdrop-blur">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full ring-2 ring-border" />Person</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px] bg-purple" />AI agent</span>
        <span className="flex items-center gap-1.5"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="1.5" /></svg>Reports to</span>
        <span className="flex items-center gap-1.5"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="#8B5CF6" strokeWidth="1.5" strokeDasharray="4 3" /></svg>Approval owner</span>
      </div>
      <div ref={wrap} tabIndex={0} role="application" aria-label="Org chart canvas. Arrow keys pan, plus and minus zoom, 0 resets." onKeyDown={onKey} data-testid="oc-canvas"
        className="h-[640px] cursor-grab overflow-hidden bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:20px_20px] focus-visible:outline-2 focus-visible:outline-royal active:cursor-grabbing"
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 0.1 : -0.1); } else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY })); }}
        onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }); }}
        onPointerUp={() => { drag.current = null; }}>
        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${z})`, transformOrigin: "0 0" }} className="p-8">
          <div ref={inner} className="relative inline-flex items-start gap-6">
            <svg className="pointer-events-none absolute left-0 top-0" width={size.w} height={size.h} aria-hidden>
              {lines.map((l) => { const my = (l.y1 + l.y2) / 2; return <path key={l.key} d={`M${l.x1},${l.y1} C${l.x1},${my} ${l.x2},${my} ${l.x2},${l.y2}`} fill="none" stroke={l.dashed ? "#8B5CF6" : "var(--color-ink-3)"} strokeOpacity={l.dashed ? 0.9 : 0.5} strokeWidth={1.5} strokeDasharray={l.dashed ? "5 4" : undefined} />; })}
            </svg>
            {chart.departments.map((d) => <DeptColumn key={d.id ?? "org"} d={d} chart={chart} onSelect={onSelect} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function levels(humans: HumanNode[]): HumanNode[][] {
  const ids = new Set(humans.map((h) => h.id)); const out: HumanNode[][] = []; let cur = humans.filter((h) => !h.managerId || !ids.has(h.managerId)); const seen = new Set<string>();
  while (cur.length && out.length < 8) { out.push(cur); cur.forEach((c) => seen.add(c.id)); cur = humans.filter((h) => h.managerId && cur.some((c) => c.id === h.managerId) && !seen.has(h.id)); }
  const rest = humans.filter((h) => !seen.has(h.id)); if (rest.length) out.push(rest);
  return out;
}
function DeptColumn({ d, chart, onSelect }: { d: DeptSummary; chart: OrgChart; onSelect: (s: Sel) => void }) {
  const humans = chart.humans.filter((h) => (h.departmentId ?? null) === d.id); const ai = chart.ai.filter((a) => (a.departmentId ?? null) === d.id);
  if (!humans.length && !ai.length) return null;
  return (
    <section className="w-max min-w-[240px] rounded-2xl border border-border bg-surface/95 p-4 shadow-[var(--shadow-card)]" aria-label={`${d.name} department`}>
      <div className="mb-3 border-b border-border pb-2"><div className="text-sm font-bold">{d.name}</div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-2"><span>{d.humans} people · {d.ai} AI</span><span className="ml-auto font-semibold text-cyan-ink">{fmtPct(d.coveragePct)} covered</span></div>
        <div className="mt-1.5"><Meter value={d.coveragePct * 100} accent="cyan" label={`${d.name} automation coverage`} /></div>
      </div>
      <div className="space-y-10">{levels(humans).map((row, i) => <div key={i} className="flex justify-center gap-3">{row.map((h) => <HumanChip key={h.id} h={h} onClick={() => onSelect({ kind: "human", n: h })} />)}</div>)}</div>
      {ai.length > 0 && <div className="mt-10 flex flex-wrap justify-center gap-3 border-t border-dashed border-purple/30 pt-8">{ai.map((a) => <AiChip key={a.id} a={a} onClick={() => onSelect({ kind: "ai", n: a })} />)}</div>}
    </section>
  );
}
function HumanChip({ h, onClick }: { h: HumanNode; onClick: () => void }) {
  return <button data-node={h.id} onClick={onClick} className="flex w-[104px] flex-col items-center rounded-xl p-1.5 text-center hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-royal" data-testid={`oc-human-${h.id}`}>
    <HumanAvatar name={h.name} photoUrl={h.photoUrl} size="sm" /><span className="mt-1 line-clamp-1 text-[11px] font-semibold">{h.name}</span><span className="line-clamp-1 text-[10px] text-ink-3">{h.title ?? "—"}</span></button>;
}
function AiChip({ a, onClick }: { a: AiNode; onClick: () => void }) {
  return <button data-node={a.id} onClick={onClick} className={cn("flex w-[112px] flex-col items-center rounded-xl p-1.5 text-center hover:bg-purple-soft/40 focus-visible:outline-2 focus-visible:outline-purple", a.proposed && "border border-dashed border-gold/60 bg-gold-soft/20")} data-testid={`oc-ai-${a.id}`}>
    <AiAvatar name={a.name} portraitUrl={a.portraitUrl} provenance={a.portraitProvenance} team={a.team} size="sm" /><span className="mt-1 flex items-center gap-1 text-[11px] font-semibold">{a.name}<AiBadge compact className="px-1 py-0 text-[8px]" /></span>
    <span className="line-clamp-1 text-[10px] text-ink-3">{a.title.replace(/^AI /, "")}</span>{a.proposed && <span className="mt-0.5 text-[9px] font-bold uppercase text-gold-ink">Proposed</span>}</button>;
}

function MobileList({ chart, onSelect }: { chart: OrgChart; onSelect: (s: Sel) => void }) {
  return (
    <div className="space-y-3" data-testid="oc-list">{chart.departments.map((d) => {
      const humans = chart.humans.filter((h) => (h.departmentId ?? null) === d.id); const ai = chart.ai.filter((a) => (a.departmentId ?? null) === d.id);
      if (!humans.length && !ai.length) return null;
      return (
        <details key={d.id ?? "org"} className="card p-0" open>
          <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-bold">{d.name}<span className="ml-auto text-[11px] font-medium text-ink-2">{d.humans} people · {d.ai} AI · {fmtPct(d.coveragePct)}</span></summary>
          <ul className="divide-y divide-border border-t border-border">
            {humans.map((h) => <li key={h.id}><button onClick={() => onSelect({ kind: "human", n: h })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left"><HumanAvatar name={h.name} photoUrl={h.photoUrl} size="xs" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{h.name}</span><span className="block truncate text-xs text-ink-3">{h.title}</span></span></button></li>)}
            {ai.map((a) => <li key={a.id}><button onClick={() => onSelect({ kind: "ai", n: a })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left"><AiAvatar name={a.name} portraitUrl={a.portraitUrl} provenance={a.portraitProvenance} team={a.team} size="xs" /><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 text-sm font-semibold">{a.name}<AiBadge compact /></span><span className="block truncate text-xs text-ink-3">{a.title}{a.approvalOwnerName ? ` · approved by ${a.approvalOwnerName}` : ""}</span></span>{a.proposed && <Badge tone="gold">Proposed</Badge>}</button></li>)}
          </ul>
        </details>
      );
    })}</div>
  );
}

function NodeDetail({ sel, chart }: { sel: NonNullable<Sel>; chart: OrgChart }) {
  const dept = chart.departments.find((d) => d.id === sel.n.departmentId)?.name ?? "Organization-wide";
  if (sel.kind === "human") {
    const h = sel.n; const mgr = chart.humans.find((x) => x.id === h.managerId); const approves = chart.ai.filter((a) => a.approvalOwnerEmployeeId === h.id);
    return (
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-3"><HumanAvatar name={h.name} photoUrl={h.photoUrl} size="md" /><div><div className="font-bold">{h.name}</div><div className="text-ink-2">{h.title ?? "—"} · {dept}</div>{mgr && <div className="text-xs text-ink-3">Reports to {mgr.name}</div>}</div></div>
        <div><div className="mb-1 text-xs font-semibold uppercase text-ink-3">Observed workflows</div>{h.workflows.length ? <ul className="space-y-1">{h.workflows.slice(0, 8).map((w) => <li key={w.id} className="flex justify-between gap-2"><Link className="text-royal-ink hover:underline" href={`/app/workflows/${w.id}`}>{w.name}</Link><span className="tabular text-ink-2">{fmtNum(w.hoursPerWeek, 1)} h/wk</span></li>)}</ul> : <p className="text-xs text-ink-3">None observed.</p>}</div>
        {approves.length > 0 && <div><div className="mb-1 text-xs font-semibold uppercase text-ink-3">Approves work of</div><div className="flex flex-wrap gap-2">{approves.map((a) => <span key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs">{a.name}<AiBadge compact /></span>)}</div></div>}
        <p className="rounded-lg bg-surface-2 p-3 text-[11px] text-ink-2">Time-saving figures describe workflows, never an individual&apos;s performance. Role or staffing decisions require management and HR/legal review.</p>
        <Button size="sm" variant="secondary" href={`/app/employees/${h.id}`}>Open employee</Button>
      </div>
    );
  }
  const a = sel.n;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-3"><AiAvatar name={a.name} portraitUrl={a.portraitUrl} provenance={a.portraitProvenance} team={a.team} size="md" caption /><div><div className="flex items-center gap-2 font-bold">{a.name}<AiBadge /></div><div className="text-ink-2">{a.title} · {dept}</div><div className="mt-1">{a.proposed ? <Badge tone="gold">Proposed — not provisioned</Badge> : <StatusPill status={a.status} />}</div></div></div>
      <div className="text-xs">Approval owner: <b>{a.approvalOwnerName ?? "not set"}</b> · Permission: {a.permissionLevel.replace(/_/g, " ")}</div>
      <div><div className="mb-1 text-xs font-semibold uppercase text-ink-3">Responsibilities</div><ul className="list-disc space-y-0.5 pl-5">{a.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul></div>
      <div><div className="mb-1 text-xs font-semibold uppercase text-ink-3">Workflows covered</div>{a.workflows.length ? <ul className="space-y-1">{a.workflows.map((w) => <li key={w.id} className="flex justify-between gap-2"><Link className="text-royal-ink hover:underline" href={`/app/workflows/${w.id}`}>{w.name}</Link><span className="tabular text-ink-2">{fmtNum(w.hoursPerWeek, 1)} h/wk observed</span></li>)}</ul> : <p className="text-xs text-ink-3">Not linked to a workflow yet.</p>}</div>
      {a.opportunities.length > 0 && <div><div className="mb-1 text-xs font-semibold uppercase text-ink-3">Opportunities</div><ul className="space-y-1">{a.opportunities.map((o) => <li key={o.id} className="flex justify-between gap-2"><Link className="text-royal-ink hover:underline" href={`/app/opportunities/${o.id}`}>{o.title}</Link><span className="tabular text-gold-ink">{fmtUSD(o.realizable)}/yr</span></li>)}</ul></div>}
      <div className="grid grid-cols-3 gap-2">
        <Mini icon={<Clock size={12} />} label="Recoverable" value={`${fmtNum(a.hoursRecoverablePerWeek, 1)} h/wk`} tone="text-gold-ink" />
        <Mini icon={<BadgeDollarSign size={12} />} label="Projected" value={fmtUSD(a.projectedValue)} tone="text-gold-ink" />
        <Mini icon={<Clock size={12} />} label="Verified" value={`${fmtNum(a.verifiedHours, 1)} h`} tone="text-emerald-ink" />
      </div>
      <div className="flex flex-wrap gap-2">{a.proposed ? <><Button size="sm" variant="gradient" href={`/app/experience#meet-${a.personaKey}`}>Meet {a.name}</Button><Button size="sm" variant="secondary" href="/app/workforce/new">Build in builder</Button></> : <><Button size="sm" variant="gradient" href={`/app/workforce/${a.id}`}>Meet {a.name}</Button><Button size="sm" variant="secondary" href={`/app/workforce/${a.id}?tab=savings`}>Review savings</Button></>}</div>
    </div>
  );
}
function Mini({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) {
  return <div className="rounded-xl bg-surface-2 p-2"><div className="flex items-center gap-1 text-[10px] font-semibold uppercase text-ink-3">{icon}{label}</div><div className={cn("mt-0.5 text-sm font-bold", tone)}>{value}</div></div>;
}
