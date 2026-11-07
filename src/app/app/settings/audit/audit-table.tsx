"use client";
import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Table, Th, Td } from "@/components/ui";

type Row = { id: number; ts: string; actor: string; actorType: string; action: string; entityType: string | null; entityId: string | null; details: Record<string, unknown> };
export function AuditTable({ rows }: { rows: Row[] }) {
  const [open, setOpen] = React.useState<Set<number>>(new Set());
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Table>
      <thead><tr><Th></Th><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Details</Th></tr></thead>
      <tbody>{rows.map((r) => { const has = Object.keys(r.details).length > 0; const isOpen = open.has(r.id); return (
        <React.Fragment key={r.id}>
          <tr data-testid={`audit-row-${r.id}`}>
            <Td className="w-6 pr-0">{has && <button onClick={() => toggle(r.id)} aria-label="Toggle details" className="text-ink-3 hover:text-ink" data-testid={`audit-toggle-${r.id}`}><ChevronRight size={14} className={isOpen ? "rotate-90 transition" : "transition"} /></button>}</Td>
            <Td className="text-xs whitespace-nowrap">{new Date(r.ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</Td>
            <Td className="text-xs">{r.actor}{r.actorType !== "user" && <span className="ml-1 text-ink-3">({r.actorType})</span>}</Td>
            <Td className="text-xs font-mono">{r.action}</Td>
            <Td className="text-xs text-ink-2">{r.entityType ? `${r.entityType}${r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ""}` : "—"}</Td>
            <Td className="text-xs text-ink-3">{has ? (isOpen ? "" : `${Object.keys(r.details).length} field(s)`) : "—"}</Td>
          </tr>
          {isOpen && <tr><Td colSpan={6} className="bg-surface-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-2" data-testid={`audit-details-${r.id}`}>{JSON.stringify(r.details, null, 2)}</pre></Td></tr>}
        </React.Fragment>); })}</tbody>
    </Table>
  );
}
