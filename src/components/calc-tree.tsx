"use client";
import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { BasisChip } from "@/components/ui";
import { fmtUSD, fmtNum } from "@/lib/utils";

function fmt(v: number, unit?: string) {
  if (unit === "usd") return fmtUSD(v);
  if (unit === "pct") return `${(v * 100).toFixed(1)}%`;
  if (unit === "hours") return `${fmtNum(v, 1)} hrs`;
  if (unit === "months") return `${fmtNum(v, 1)} mo`;
  return fmtNum(v, Number.isInteger(v) ? 0 : 2) + (unit ? ` ${unit}` : "");
}
/** Renders a calculation drill-down: every number shows its formula, basis, and source. */
export function CalcTreeView({ node, depth = 0 }: { node: CalcTree; depth?: number }) {
  const [open, setOpen] = React.useState(depth < 1);
  const has = !!node.children?.length;
  return (
    <div className="text-sm">
      <div className={"flex items-start gap-2 rounded-md px-2 py-1.5 " + (depth === 0 ? "bg-surface-2" : "hover:bg-surface-2")} style={{ marginLeft: depth * 14 }}>
        <button onClick={() => has && setOpen(!open)} className={"mt-0.5 shrink-0 " + (has ? "text-ink-2" : "invisible")} aria-label="toggle"><ChevronRight size={14} className={open ? "rotate-90 transition" : "transition"} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={depth === 0 ? "font-semibold" : "font-medium"}>{node.label}</span>
            <span className="tabular font-semibold text-brand">{fmt(node.value, node.unit)}</span>
            <BasisChip basis={node.basis} />
          </div>
          {node.formula && <div className="mt-0.5 font-mono text-[11px] text-ink-2">{node.formula}</div>}
          {node.source && <div className="mt-0.5 text-[11px] text-ink-3">Source: {node.source}</div>}
        </div>
      </div>
      {open && has && node.children!.map((c, i) => <CalcTreeView key={i} node={c} depth={depth + 1} />)}
    </div>
  );
}
