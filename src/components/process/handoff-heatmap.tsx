"use client";
/** Department → department hand-off matrix (sequential single-hue heatmap; diagonal = within-department). */
import * as React from "react";
import { fmtNum } from "@/lib/utils";

export function HandoffHeatmap({ departments, matrix }: { departments: { key: string; name: string; mapped: boolean }[]; matrix: { from: string; to: string; perWeek: number; count: number }[] }) {
  const fromKeys = departments.filter((d) => matrix.some((m) => m.from === d.key));
  const toKeys = departments.filter((d) => matrix.some((m) => m.to === d.key));
  const cell = new Map(matrix.map((m) => [`${m.from}→${m.to}`, m]));
  const max = Math.max(...matrix.map((m) => m.perWeek), 0.0001);
  return (
    <div className="overflow-x-auto scrollbar-thin" data-testid="handoff-heatmap">
      <table className="border-separate border-spacing-1 text-xs">
        <caption className="sr-only">Hand-offs per week from the sending department (rows) to the receiving department (columns)</caption>
        <thead><tr><th scope="col" className="px-2 py-1 text-left text-[11px] font-semibold text-ink-3">From ↓ / To →</th>{toKeys.map((t) => <th key={t.key} scope="col" className="max-w-[8rem] px-2 py-1 text-left text-[11px] font-semibold text-ink-2">{t.name}</th>)}</tr></thead>
        <tbody>
          {fromKeys.map((f) => (
            <tr key={f.key}>
              <th scope="row" className="whitespace-nowrap px-2 py-1 text-left text-[11px] font-semibold text-ink-2">{f.name}</th>
              {toKeys.map((t) => {
                const m = cell.get(`${f.key}→${t.key}`); const share = m ? m.perWeek / max : 0; const pct = m ? Math.round(10 + 45 * Math.sqrt(share)) : 0; // ≤55% indigo: ink text keeps ≥4.5:1 in both themes
                return (
                  <td key={t.key} className="h-12 min-w-[5.5rem] rounded-lg border border-border px-2 text-center tabular" data-testid={`handoff-${f.key}-${t.key}`}
                    style={m ? { background: `color-mix(in oklab, var(--color-indigo) ${pct}%, var(--color-surface))`, color: "var(--color-ink)" } : undefined}
                    title={m ? `${f.name} → ${t.name}: ${fmtNum(m.perWeek, 1)} per week (${m.count} observed)` : `${f.name} → ${t.name}: none observed`}>
                    {m ? <><div className="font-semibold">{fmtNum(m.perWeek, 1)}</div><div className="text-[10px]">{f.key === t.key ? "within dept" : "per week"}</div></> : <span className="text-ink-3">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
