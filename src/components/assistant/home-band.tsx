"use client";
/** Simple-mode home band: five entry points, each with a live number from the tenant's own data. */
import * as React from "react";
import Link from "next/link";
import { Telescope, UsersRound, MonitorPlay, Rocket, PiggyBank, ArrowRight } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/enterprise";
import { cn, fmtNum, fmtUSD } from "@/lib/utils";

export type HomeBandData = {
  workflows: number; opportunities: number;
  aiTeam: number; personasAvailable: number; portraits: { key: string; name: string; src: string }[];
  demoRuns: number; demosAvailable: number;
  working: number; deployedAgents: number;
  verifiedAnnual: number | null; hardSavings: number | null;
  canFinance: boolean; canAgents: boolean;
};

export function HomeBand({ d }: { d: HomeBandData }) {
  const cards: { key: string; testid: string; title: string; href: string; icon: React.ReactNode; accent: string; tile: string; value: number | null; fmt: (n: number) => string; caption: React.ReactNode; extra?: React.ReactNode; locked?: boolean }[] = [
    { key: "business", testid: "entry-business", title: "Understand My Business", href: "/app/business", icon: <Telescope size={18} />, accent: "from-royal to-indigo", tile: "bg-royal-soft text-royal-ink", value: d.workflows, fmt: (n) => fmtNum(n), caption: <>workflows discovered · <b className="text-ink">{fmtNum(d.opportunities)}</b> AI opportunities</> },
    { key: "team", testid: "entry-team", title: "Meet My AI Team", href: "/app/experience", icon: <UsersRound size={18} />, accent: "from-purple to-indigo", tile: "bg-purple-soft text-purple-ink", value: d.aiTeam, fmt: (n) => fmtNum(n), caption: <>AI employees on your team · {d.personasAvailable} AI agents available</>, locked: !d.canAgents,
      extra: <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1"><div className="flex shrink-0 -space-x-2">{d.portraits.map((p) => <img key={p.key} src={p.src} alt={`${p.name}, AI agent (AI-generated portrait)`} title={`${p.name} — AI agent · AI-generated portrait`} width={28} height={28} className="h-7 w-7 rounded-full object-cover ring-2 ring-surface" />)}</div><span className="text-[10px] leading-tight text-ink-3">AI-generated portraits</span></div> },
    { key: "demo", testid: "entry-demo", title: "See AI in Action", href: "/app/experience#demo", icon: <MonitorPlay size={18} />, accent: "from-cyan to-royal", tile: "bg-cyan-soft text-cyan-ink", value: d.demoRuns, fmt: (n) => fmtNum(n), caption: <>demonstrations run · {d.demosAvailable} available on synthetic samples</>, locked: !d.canAgents },
    { key: "work", testid: "entry-work", title: "Put AI to Work", href: d.aiTeam ? "/app/workforce?status=pilot" : "/app/agents", icon: <Rocket size={18} />, accent: "from-gold to-coral", tile: "bg-gold-soft text-gold-ink", value: d.working, fmt: (n) => fmtNum(n), caption: <>AI employees in pilot or active · {fmtNum(d.deployedAgents)} deployed agents</>, locked: !d.canAgents },
    { key: "savings", testid: "entry-savings", title: "See My Savings", href: "/app/savings", icon: <PiggyBank size={18} />, accent: "from-emerald to-cyan", tile: "bg-emerald-soft text-emerald-ink", value: d.verifiedAnnual, fmt: (n) => fmtUSD(n, { compact: true }), caption: d.verifiedAnnual == null ? "Requires finance access" : <>verified per year (measured) · <b className="text-emerald-ink">{fmtUSD(d.hardSavings ?? 0, { compact: true })}</b> approved hard savings</>, locked: !d.canFinance },
  ];
  return (
    <section aria-label="Start here" className="mb-6" data-testid="home-band">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div><div className="text-[11px] font-semibold uppercase tracking-[.16em] text-ink-3">Start here</div><h2 className="text-lg font-bold tracking-tight">What do you want to do today?</h2></div>
        <button onClick={() => window.dispatchEvent(new CustomEvent("bb:assistant"))} className="hidden items-center gap-1.5 rounded-xl bg-purple-soft px-3 py-2 text-xs font-semibold text-purple-ink hover:brightness-95 sm:inline-flex" data-testid="home-band-ask">Or just ask the AI assistant <kbd className="rounded bg-surface px-1 text-[10px]">/</kbd></button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5 stagger">
        {cards.map((c) => {
          const body = (
            <>
              <div className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r", c.accent)} />
              <div className="flex items-center justify-between"><span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", c.tile)}>{c.icon}</span><ArrowRight size={16} className="text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-ink" /></div>
              <div className="mt-3 text-sm font-bold">{c.title}</div>
              <div className="mt-1 font-display text-[1.7rem] font-bold leading-none tracking-tight">{c.value == null ? <span className="text-ink-3">—</span> : <AnimatedNumber value={c.value} format={c.fmt} />}</div>
              <div className="mt-1.5 text-xs text-ink-2">{c.caption}</div>
              {c.extra}
            </>
          );
          const cls = "card card-hover group relative block overflow-hidden p-4";
          return c.locked ? <div key={c.key} className={cn(cls, "opacity-70")} data-testid={c.testid} aria-disabled>{body}<div className="mt-2 text-[11px] font-semibold text-ink-3">Not included in your role</div></div>
            : <Link key={c.key} href={c.href} className={cls} data-testid={c.testid}>{body}</Link>;
        })}
      </div>
    </section>
  );
}
