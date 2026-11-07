"use client";
/**
 * Pure-SVG Gantt: one band per project, one row per milestone (bars by start → due), dependency elbows, today marker.
 * Horizontally scrollable inside its card; the timeline/list view is the text alternative.
 */
import * as React from "react";
import { ACCENT_HEX } from "@/components/ui/enterprise";
import { useTimeZone } from "@/components/time-zone";
import { formatDate } from "@/lib/datetime";

export type GanttMilestone = { id: string; name: string; status: string; startDate: string | null; dueDate: string | null; dependsOnMilestoneId: string | null };
export type GanttProject = { id: string; name: string; status: string; startDate: string | null; targetDate: string | null; milestones: GanttMilestone[] };

const DAY = 86_400_000;
const LABEL_W = 210; const ROW = 30; const HEAD = 34; const BAND = 30;
const STATUS_FILL: Record<string, string> = { done: ACCENT_HEX.emerald, in_progress: ACCENT_HEX.cyan, blocked: ACCENT_HEX.coral, not_started: ACCENT_HEX.royal };

export function Gantt({ projects, today, onSelect }: { projects: GanttProject[]; today: string; onSelect?: (projectId: string) => void }) {
  const tz = useTimeZone();
  const now = new Date(today).getTime();
  type Row = { kind: "project"; p: GanttProject; y: number; s: number | null; e: number | null } | { kind: "ms"; p: GanttProject; m: GanttMilestone; y: number; s: number; e: number; overdue: boolean };
  const rows: Row[] = []; let y = HEAD; const unscheduled: string[] = [];
  const ts = (d: string | null) => (d ? new Date(d).getTime() : null);
  for (const p of projects) {
    rows.push({ kind: "project", p, y, s: ts(p.startDate), e: ts(p.targetDate) }); y += BAND;
    for (const m of p.milestones) {
      const due = ts(m.dueDate); const start = ts(m.startDate) ?? (due != null ? due - 7 * DAY : null);
      if (start == null || due == null) { if (start == null && due == null) { unscheduled.push(`${p.name}: ${m.name}`); continue; } }
      const s = start ?? (due! - 7 * DAY); const e = Math.max(due ?? s + 7 * DAY, s + DAY);
      rows.push({ kind: "ms", p, m, y, s, e, overdue: m.status !== "done" && (due ?? e) < now }); y += ROW;
    }
  }
  const all = rows.flatMap((r) => [r.s, r.e]).filter((x): x is number => x != null);
  if (!all.length) return <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-2" data-testid="gantt-empty">No dated milestones yet. Add milestones with start and due dates to see the Gantt chart.</p>;
  const min = Math.min(...all, now) - 7 * DAY; const max = Math.max(...all, now) + 14 * DAY;
  const days = Math.ceil((max - min) / DAY);
  const pxDay = Math.max(5, Math.min(22, 900 / days));
  const W = LABEL_W + days * pxDay + 16; const H = y + 8;
  const x = (t: number) => LABEL_W + ((t - min) / DAY) * pxDay;
  const months: { t: number; label: string }[] = [];
  // Month ticks in UTC so the server render and the browser agree on positions and labels.
  for (let d = new Date(Date.UTC(new Date(min).getUTCFullYear(), new Date(min).getUTCMonth() + 1, 1)); d.getTime() < max; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push({ t: d.getTime(), label: formatDate(d, "UTC", { month: "short", year: "2-digit" }) });
  const msRow = new Map(rows.filter((r): r is Extract<Row, { kind: "ms" }> => r.kind === "ms").map((r) => [r.m.id, r]));
  const deps = [...msRow.values()].filter((r) => r.m.dependsOnMilestoneId && msRow.has(r.m.dependsOnMilestoneId)).map((r) => ({ from: msRow.get(r.m.dependsOnMilestoneId!)!, to: r }));
  const overdue = [...msRow.values()].filter((r) => r.overdue).length;
  const label = `Gantt chart: ${projects.length} projects, ${msRow.size} scheduled milestones, ${deps.length} dependencies, ${overdue} overdue. Today is ${formatDate(now, tz)}.`;
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  return (
    <div data-testid="gantt">
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2" aria-label="Legend">
        {Object.entries({ "Not started": STATUS_FILL.not_started, "In progress": STATUS_FILL.in_progress, Blocked: STATUS_FILL.blocked, Done: STATUS_FILL.done }).map(([k, c]) => <li key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm" style={{ background: c }} />{k}</li>)}
        <li className="flex items-center gap-1.5"><span className="h-3 w-0.5" style={{ background: ACCENT_HEX.coral }} />Today</li>
        <li className="flex items-center gap-1.5"><svg width="18" height="8" aria-hidden><path d="M1 4 H15" stroke="var(--color-ink-3)" strokeWidth="1.5" markerEnd="url(#gantt-arrow-legend)" /><defs><marker id="gantt-arrow-legend" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--color-ink-3)" /></marker></defs></svg>Dependency</li>
      </ul>
      <div className="scrollbar-thin overflow-x-auto rounded-xl border border-border">
        <svg width={W} height={H} role="img" aria-label={label} className="block text-ink" style={{ minWidth: W }}>
          <defs><marker id="gantt-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--color-ink-3)" /></marker></defs>
          <rect x={0} y={0} width={W} height={HEAD} fill="var(--color-surface-2)" />
          {months.map((mo) => <g key={mo.t}><line x1={x(mo.t)} x2={x(mo.t)} y1={0} y2={H} stroke="var(--color-border)" /><text x={x(mo.t) + 4} y={14} fontSize={11} fill="var(--color-ink-2)">{mo.label}</text></g>)}
          <text x={12} y={22} fontSize={11} fontWeight={600} fill="var(--color-ink-2)">Project / milestone</text>
          {rows.map((r) => r.kind === "project" ? (
            <g key={`p-${r.p.id}`} onClick={() => onSelect?.(r.p.id)} style={{ cursor: onSelect ? "pointer" : undefined }}>
              <rect x={0} y={r.y} width={W} height={BAND} fill="var(--color-surface-2)" opacity={0.55} />
              <text x={12} y={r.y + 19} fontSize={12} fontWeight={700} fill="var(--color-ink)">{trunc(r.p.name, 28)}</text>
              {r.s != null && r.e != null && <rect x={x(r.s)} y={r.y + 11} width={Math.max(4, x(r.e) - x(r.s))} height={8} rx={4} fill={ACCENT_HEX.indigo} opacity={0.35} />}
            </g>
          ) : (
            <g key={`m-${r.m.id}`} data-testid={`gantt-bar-${r.m.id}`}>
              <line x1={0} x2={W} y1={r.y + ROW} y2={r.y + ROW} stroke="var(--color-border)" strokeOpacity={0.5} />
              <text x={24} y={r.y + 19} fontSize={11} fill="var(--color-ink-2)">{trunc(r.m.name, 30)}</text>
              <rect x={x(r.s)} y={r.y + 8} width={Math.max(6, x(r.e) - x(r.s))} height={14} rx={4} fill={STATUS_FILL[r.m.status] ?? STATUS_FILL.not_started} stroke={r.overdue ? ACCENT_HEX.coral : "var(--color-surface)"} strokeWidth={r.overdue ? 2 : 1.5} strokeDasharray={r.overdue ? "3 2" : undefined}>
                <title>{`${r.m.name} — ${r.m.status.replace(/_/g, " ")} · ${formatDate(r.s, tz)} → ${formatDate(r.e, tz)}${r.overdue ? " · OVERDUE" : ""}`}</title>
              </rect>
            </g>
          ))}
          {deps.map(({ from, to }) => { const x1 = x(from.e), y1 = from.y + 15, x2 = x(to.s), y2 = to.y + 15; const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 8)); return <path key={`d-${to.m.id}`} d={`M${x1} ${y1} H${mid} V${y2} H${x2 - 2}`} fill="none" stroke="var(--color-ink-3)" strokeWidth={1.5} markerEnd="url(#gantt-arrow)" />; })}
          <line x1={x(now)} x2={x(now)} y1={HEAD - 6} y2={H} stroke={ACCENT_HEX.coral} strokeWidth={2} />
          <rect x={x(now) - 20} y={HEAD - 15} width={40} height={13} rx={6.5} fill={ACCENT_HEX.coral} /><text x={x(now)} y={HEAD - 5.5} fontSize={9} fontWeight={700} textAnchor="middle" fill="#fff">TODAY</text>
        </svg>
      </div>
      {unscheduled.length > 0 && <p className="mt-2 text-[11px] text-ink-3">Not shown (no dates): {unscheduled.join(" · ")}</p>}
    </div>
  );
}
