"use client";
/** KPI drill-down drawer + date-range filter control shared by Business Intelligence and Process Mining. */
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CalcTree } from "@/db/schema";
import { Drawer } from "@/components/ui/enterprise";
import { CalcTreeView } from "@/components/calc-tree";

export function useDrill<K extends string>() {
  const [open, setOpen] = React.useState<K | null>(null);
  return { open, show: (k: K) => setOpen(k), close: () => setOpen(null) };
}

export function DrillDrawer({ tree, onClose, note, testid = "drill-drawer" }: { tree: CalcTree | null; onClose: () => void; note?: React.ReactNode; testid?: string }) {
  return (
    <Drawer open={!!tree} onClose={onClose} title={tree ? `How is this calculated? — ${tree.label}` : ""} testid={testid}>
      {tree && (
        <div className="space-y-3">
          <p className="text-xs text-ink-2">Every number below comes from your organization&apos;s data. Expand a row to see its inputs, formula, basis and source.</p>
          <CalcTreeView node={tree} />
          {note && <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-ink-2">{note}</div>}
        </div>
      )}
    </Drawer>
  );
}

/** `from` / `to` date inputs bound to the URL (FilterBar companion). */
export function DateRangeFilter({ testid = "filter-bar" }: { testid?: string }) {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const set = (key: "from" | "to", value: string) => { const q = new URLSearchParams(sp.toString()); if (value) q.set(key, value); else q.delete(key); router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }); };
  const cls = "h-8 rounded-lg border bg-surface px-2 text-xs font-medium";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <label className="inline-flex items-center gap-1 text-xs text-ink-2">From
        <input type="date" value={sp.get("from") ?? ""} onChange={(e) => set("from", e.target.value)} data-testid={`${testid}-from`} aria-label="From date" className={`${cls} ${sp.get("from") ? "border-royal text-royal-ink" : "border-border text-ink-2"}`} />
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-ink-2">To
        <input type="date" value={sp.get("to") ?? ""} onChange={(e) => set("to", e.target.value)} data-testid={`${testid}-to`} aria-label="To date" className={`${cls} ${sp.get("to") ? "border-royal text-royal-ink" : "border-border text-ink-2"}`} />
      </label>
      {(sp.get("from") || sp.get("to")) && <button type="button" onClick={() => { const q = new URLSearchParams(sp.toString()); q.delete("from"); q.delete("to"); router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }); }} className="rounded-lg px-2 py-1 text-xs font-semibold text-coral-ink hover:bg-coral-soft" data-testid={`${testid}-dates-clear`}>Clear dates</button>}
    </span>
  );
}
