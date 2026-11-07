import Link from "next/link";
import { CheckCircle2, Circle, ArrowRight, Lock } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { can, type Permission } from "@/lib/rbac";
import { Button, PageHeader } from "@/components/ui";
import { loadProgress, checklist } from "./progress";

export const metadata = { title: "Rollout checklist" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const ctx = await requireCtx();
  const progress = await loadProgress(ctx.orgId);
  const steps = checklist(progress);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <div className="space-y-6" data-testid="onboarding">
      <PageHeader title="Rollout checklist" subtitle="From first authorization to verified savings, in order. Each step updates itself from real data." actions={next && <Button href={next.href} data-testid="onboarding-next">{next.cta}<ArrowRight size={15} /></Button>} />
      <div className="card p-4">
        <div className="flex items-center justify-between text-sm"><span className="font-medium">{done} of {steps.length} steps complete</span><span className="tabular text-ink-2">{Math.round((done / steps.length) * 100)}%</span></div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={done} aria-valuemax={steps.length}><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      </div>
      <ol className="space-y-2" data-testid="onboarding-steps">
        {steps.map((s, i) => {
          const allowed = !s.perm || can(ctx.role, s.perm as Permission);
          const isNext = s.key === next?.key;
          return (
            <li key={s.key} className={"card flex gap-3 p-4 " + (isNext ? "border-brand/60 bg-brand-soft/20" : "")} data-testid={`onboarding-step-${s.key}`} data-done={s.done ? "1" : "0"}>
              <div className="mt-0.5 shrink-0">{s.done ? <CheckCircle2 size={20} className="text-money" /> : <Circle size={20} className={isNext ? "text-brand" : "text-ink-3"} />}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="text-xs tabular text-ink-3">{i + 1}.</span><span className={"text-sm font-medium " + (s.done ? "text-ink-2 line-through decoration-ink-3" : "text-ink")}>{s.title}</span>{isNext && <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold uppercase text-white">next</span>}</div>
                <p className="mt-1 text-xs text-ink-2">{s.body}</p>
                <div className="mt-2">
                  {allowed ? <Link href={s.href} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline" data-testid={`onboarding-link-${s.key}`}>{s.done ? "Open" : s.cta}<ArrowRight size={12} /></Link>
                    : <span className="inline-flex items-center gap-1 text-xs text-ink-3"><Lock size={12} />Needs an owner or admin ({s.perm})</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-ink-3">Done with the checklist? The <Link href="/app" className="text-brand hover:underline">Executive Summary</Link> is where the numbers live, and <Link href="/app/trust" className="text-brand hover:underline">Trust &amp; Privacy</Link> explains what is and is not collected.</p>
    </div>
  );
}
