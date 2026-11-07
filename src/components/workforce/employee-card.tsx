"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Workflow, CheckCircle2, Clock, BadgeDollarSign, Activity } from "lucide-react";
import { StatusPill } from "@/components/ui/enterprise";
import { cn, fmtNum, fmtUSD } from "@/lib/utils";
import { AiAvatar, AiBadge, TEAM_ACCENT, TILE, GRADIENT } from "./avatar";

export type CardEmployee = {
  id: string; firstName: string; title: string; team: string; status: string; permissionLevel: string; portraitUrl: string | null; portraitProvenance: string | null; expertise: string[];
  departmentName: string | null;
  stats: { assignedWorkflows: number; tasksCompleted: number; successRate: number | null; verifiedHours: number; capacityValue: number; hardSavingsAnnual: number; lastActivity: { at: string; text: string } | null; liveRuns: number; sandboxRuns: number };
};
const STATUS_MAP = { sandbox: "cyan", pilot: "purple", active: "emerald", draft: "gold", paused: "gold", retired: "midnight" } as const;
export const availability = (s: string) => s === "active" ? "Available for live work" : s === "pilot" ? "Piloting with approval" : s === "sandbox" ? "Demonstrations only" : s === "paused" ? "Paused" : s === "retired" ? "Retired" : "Not yet started";

export function EmployeeCard({ e, testid }: { e: CardEmployee; testid?: string }) {
  const accent = TEAM_ACCENT[e.team] ?? "purple";
  const s = e.stats;
  return (
    <article className="card card-hover group relative flex flex-col overflow-hidden p-0" data-testid={testid ?? `employee-card-${e.id}`}>
      <div className={cn("relative h-24 bg-gradient-to-br opacity-90", GRADIENT[accent])}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_0%,rgba(255,255,255,.25),transparent_60%)]" />
        <div className="absolute right-3 top-3 flex items-center gap-1.5"><AiBadge className="bg-white/90 dark:bg-midnight/80" /></div>
      </div>
      <div className="-mt-12 flex flex-col items-center px-5 text-center">
        <AiAvatar name={e.firstName} portraitUrl={e.portraitUrl} provenance={e.portraitProvenance} team={e.team} size="lg" caption />
        <h3 className="mt-2 font-display text-lg font-bold tracking-tight">{e.firstName}</h3>
        <p className="text-sm font-medium text-ink-2">{e.title}</p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          <StatusPill status={e.status} map={STATUS_MAP} />
          <span className="text-[11px] text-ink-3">{availability(e.status)}</span>
        </div>
        {e.expertise.length > 0 && <div className="mt-3 flex flex-wrap justify-center gap-1">{e.expertise.slice(0, 3).map((x) => <span key={x} className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", TILE[accent])}>{x}</span>)}</div>}
      </div>
      <dl className="mx-4 mt-4 grid grid-cols-2 gap-2 text-left">
        <Stat icon={<Workflow size={12} />} label="Workflows" value={fmtNum(s.assignedWorkflows)} />
        <Stat icon={<CheckCircle2 size={12} />} label="Tasks done" value={fmtNum(s.tasksCompleted)} sub={s.successRate == null ? "no live runs" : `${Math.round(s.successRate * 100)}% success`} />
        <Stat icon={<Clock size={12} />} label="Time saved" value={`${fmtNum(s.verifiedHours, 1)} h`} sub="verified, live only" tone="text-cyan-ink" />
        <Stat icon={<BadgeDollarSign size={12} />} label="Verified savings" value={fmtUSD(s.hardSavingsAnnual)} sub={s.capacityValue ? `${fmtUSD(s.capacityValue)} capacity` : "hard savings / yr"} tone="text-emerald-ink" />
      </dl>
      <p className="mx-4 mt-3 flex items-center gap-1.5 truncate text-[11px] text-ink-3"><Activity size={12} className="shrink-0" />{s.lastActivity ? `${s.lastActivity.text} · ${new Date(s.lastActivity.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "No activity yet"}</p>
      <div className="mt-auto p-4">
        <Link href={`/app/workforce/${e.id}`} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#2563eb,#6366f1_55%,#8b5cf6)] text-sm font-semibold text-white shadow-[0_8px_20px_-8px_rgba(99,102,241,.7)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo" data-testid={`meet-${e.id}`}>
          Meet {e.firstName}<ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
        </Link>
      </div>
    </article>
  );
}
function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return <div className="rounded-xl bg-surface-2/70 px-2.5 py-2"><dt className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{icon}{label}</dt><dd className={cn("mt-0.5 font-display text-base font-bold", tone)}>{value}</dd>{sub && <dd className="text-[10px] text-ink-3">{sub}</dd>}</div>;
}
