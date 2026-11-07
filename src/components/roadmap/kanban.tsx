"use client";
/** Project Kanban by status. Drag a card to a column, or use the card's "Move to" menu (keyboard alternative). */
import * as React from "react";
import { GripVertical, Flag, AlertTriangle, BadgeCheck } from "lucide-react";
import { cn, fmtUSD } from "@/lib/utils";
import { ACCENT_HEX, type Accent } from "@/components/ui/enterprise";

export const COLUMN: { key: string; label: string; accent: Accent; help: string }[] = [
  { key: "proposed", label: "Proposed", accent: "gold", help: "Candidate projects awaiting approval" },
  { key: "approved", label: "Approved", accent: "indigo", help: "Approved to start (needs opportunities:write)" },
  { key: "in_progress", label: "In progress", accent: "cyan", help: "Being built" },
  { key: "live", label: "Live", accent: "emerald", help: "Deployed in production" },
  { key: "measuring", label: "Measuring", accent: "purple", help: "Collecting verified savings" },
  { key: "closed", label: "Closed", accent: "midnight", help: "Finished or stopped" },
];

export type KanbanCard = { id: string; name: string; status: string; targetAnnualSavings: number; verified: number; milestonesDone: number; milestones: number; attention: number; verifiedAt: string | null; priorityScore: number | null };

export function Kanban({ cards, canWrite, onMove, onOpen, busyId }: { cards: KanbanCard[]; canWrite: boolean; onMove: (id: string, status: string) => void; onOpen: (id: string) => void; busyId: string | null }) {
  const [over, setOver] = React.useState<string | null>(null);
  return (
    <div className="w-0 min-w-full overflow-hidden [contain:paint]"><div className="scrollbar-thin flex gap-3 overflow-x-auto pb-2" data-testid="kanban">
      {COLUMN.map((c) => {
        const list = cards.filter((k) => k.status === c.key);
        return (
          <section key={c.key} aria-label={`${c.label} column, ${list.length} projects`} data-testid={`kanban-col-${c.key}`}
            onDragOver={(e) => { if (!canWrite) return; e.preventDefault(); setOver(c.key); }} onDragLeave={() => setOver((o) => (o === c.key ? null : o))}
            onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); const card = cards.find((k) => k.id === id); if (id && card && card.status !== c.key) onMove(id, c.key); }}
            className={cn("flex w-[236px] shrink-0 flex-col 2xl:w-auto 2xl:min-w-[175px] 2xl:flex-1 rounded-2xl border bg-surface-2/60 p-2 transition", over === c.key ? "border-royal ring-2 ring-royal/30" : "border-border")}>
            <header className="mb-2 flex items-center gap-2 px-1.5 pt-1">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.accent === "midnight" ? "var(--color-ink-3)" : ACCENT_HEX[c.accent] }} />
              <h3 className="text-xs font-bold uppercase tracking-wide" title={c.help}>{c.label}</h3>
              <span className="ml-auto rounded-full bg-surface px-1.5 text-[10px] font-semibold text-ink-2">{list.length}</span>
            </header>
            <div className="flex min-h-[90px] flex-col gap-2">
              {list.map((k) => (
                <article key={k.id} draggable={canWrite} onDragStart={(e) => { e.dataTransfer.setData("text/plain", k.id); e.dataTransfer.effectAllowed = "move"; }} data-testid={`kanban-card-${k.id}`}
                  className={cn("card card-hover p-3", busyId === k.id && "opacity-50")}>
                  <div className="flex items-start gap-1.5">
                    {canWrite && <GripVertical size={14} className="mt-0.5 shrink-0 cursor-grab text-ink-3" aria-hidden />}
                    <button type="button" onClick={() => onOpen(k.id)} className="min-w-0 flex-1 text-left text-sm font-semibold leading-snug hover:text-royal-ink hover:underline" data-testid={`kanban-open-${k.id}`}>{k.name}</button>
                    {k.priorityScore != null && <span className="shrink-0 rounded-md bg-surface-2 px-1.5 text-[10px] font-bold tabular text-ink-2" title="Priority score">{Math.round(k.priorityScore)}</span>}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px]"><span className="text-ink-2">Target</span><span className="font-semibold tabular text-gold-ink">{fmtUSD(k.targetAnnualSavings, { compact: true })}/yr</span></div>
                  <div className="flex items-center justify-between text-[11px]"><span className="text-ink-2">Verified</span><span className="font-semibold tabular text-emerald-ink">{k.verified > 0 ? fmtUSD(k.verified, { compact: true }) + "/yr" : "—"}</span></div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label="Milestones done" aria-valuenow={k.milestonesDone} aria-valuemin={0} aria-valuemax={k.milestones || 1}><div className="h-full rounded-full bg-gradient-to-r from-cyan to-emerald" style={{ width: `${k.milestones ? (k.milestonesDone / k.milestones) * 100 : 0}%` }} /></div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-ink-3">
                    <span className="inline-flex items-center gap-1"><Flag size={11} />{k.milestonesDone}/{k.milestones} milestones</span>
                    {k.attention > 0 && <span className="inline-flex items-center gap-1 font-semibold text-coral-ink"><AlertTriangle size={11} />{k.attention}</span>}
                    {k.verifiedAt && <span className="inline-flex items-center gap-1 font-semibold text-emerald-ink"><BadgeCheck size={11} />verified</span>}
                  </div>
                  {canWrite && (
                    <label className="mt-2 block text-[10px] text-ink-3">
                      <span className="sr-only">Move {k.name} to</span>
                      <select value={k.status} onChange={(e) => onMove(k.id, e.target.value)} data-testid={`kanban-move-${k.id}`} className="h-7 w-full rounded-md border border-border bg-surface px-1.5 text-[11px] text-ink-2" aria-label={`Move ${k.name} to status`}>
                        {COLUMN.map((o) => <option key={o.key} value={o.key}>Move to: {o.label}</option>)}
                      </select>
                    </label>
                  )}
                </article>
              ))}
              {list.length === 0 && <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-[11px] text-ink-3">{canWrite ? "Drop a project here" : "None"}</div>}
            </div>
          </section>
        );
      })}
    </div></div>
  );
}
