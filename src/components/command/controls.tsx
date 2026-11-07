"use client";
/** Hero controls: segmented pickers on the midnight band, export menu, customize drawer and saved views. */
import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Bookmark, ChevronDown, Download, Eye, EyeOff, FileSpreadsheet, FileText, Presentation, RotateCcw, Settings2, Trash2 } from "lucide-react";
import { Button, Input, Modal } from "@/components/ui";
import { Drawer } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";
import { COMMAND_SECTIONS, SECTION_KEYS, type CommandSectionKey } from "./format";
import { deleteCommandView, saveCommandLayout, saveCommandView } from "./actions";

export function HeroSegmented<T extends string>({ label, options, value, onChange, testid }: { label: string; options: { key: T; label: string }[]; value: T; onChange: (k: T) => void; testid: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-400" id={`${testid}-label`}>{label}</span>
      <div className="inline-flex rounded-xl bg-white/[.07] p-0.5 ring-1 ring-white/15" role="radiogroup" aria-labelledby={`${testid}-label`} data-testid={testid}>
        {options.map((o) => (
          <button key={o.key} type="button" role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)} data-testid={`${testid}-${o.key}`}
            className={cn("rounded-[10px] px-2.5 py-1.5 text-xs font-semibold transition sm:px-3", value === o.key ? "bg-white text-midnight shadow" : "text-slate-200 hover:bg-white/10")}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

function download(url: string) { const a = document.createElement("a"); a.href = url; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }

export function ExportMenu({ query, scenario, canPdf, variant = "glass", testid = "cmd-export" }: { query: string; scenario: string; canPdf: boolean; variant?: "glass" | "secondary"; testid?: string }) {
  const [open, setOpen] = React.useState(false); const [busy, setBusy] = React.useState<string | null>(null); const [err, setErr] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const pdf = async () => {
    setBusy("pdf"); setErr(null);
    try {
      const r = await fetch("/api/reports/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "executive_roi", scenario }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Report failed");
      const b = await r.blob(); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = `executive-roi-${new Date().toISOString().slice(0, 10)}.pdf`; a.click(); URL.revokeObjectURL(u); setOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "Report failed"); } finally { setBusy(null); }
  };
  const file = (format: "xlsx" | "pptx") => { download(`/api/export/executive?format=${format}${query ? `&${query}` : ""}`); setOpen(false); };
  const item = "flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-surface-2 disabled:opacity-50";
  return (
    <div className="relative" ref={ref}>
      <Button variant={variant} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} data-testid={testid}><Download size={15} />Export<ChevronDown size={14} /></Button>
      {open && (
        <div role="menu" className="card absolute right-0 z-40 mt-1.5 w-64 p-1.5 text-ink shadow-[var(--shadow-pop)]">
          {canPdf && <button role="menuitem" className={item} onClick={pdf} disabled={!!busy} data-testid={`${testid}-pdf`}><FileText size={16} className="mt-0.5 text-coral-ink" /><span><span className="block font-semibold">{busy === "pdf" ? "Generating…" : "PDF executive report"}</span><span className="text-xs text-ink-2">Executive ROI summary</span></span></button>}
          <button role="menuitem" className={item} onClick={() => file("xlsx")} data-testid={`${testid}-xlsx`}><FileSpreadsheet size={16} className="mt-0.5 text-emerald-ink" /><span><span className="block font-semibold">Excel workbook</span><span className="text-xs text-ink-2">7 sheets incl. lineage & reconciliation</span></span></button>
          <button role="menuitem" className={item} onClick={() => file("pptx")} data-testid={`${testid}-pptx`}><Presentation size={16} className="mt-0.5 text-gold-ink" /><span><span className="block font-semibold">PowerPoint deck</span><span className="text-xs text-ink-2">12-slide boardroom briefing</span></span></button>
          {err && <p className="px-3 py-1 text-xs text-coral-ink" role="alert">{err}</p>}
        </div>
      )}
    </div>
  );
}

export type SavedView = { id: string; name: string; filters: Record<string, string> };

export function SavedViews({ views, currentFilters, activeId, layout }: { views: SavedView[]; currentFilters: Record<string, string>; activeId: string | null; layout: { hidden: string[]; order: string[] } }) {
  const router = useRouter(); const [open, setOpen] = React.useState(false); const [name, setName] = React.useState(""); const [err, setErr] = React.useState<string | null>(null); const [pending, start] = React.useTransition();
  const go = (id: string) => { if (!id) { router.push("/app"); return; } const v = views.find((x) => x.id === id); if (v) router.push(`/app?${new URLSearchParams({ ...v.filters, view: v.id })}`); };
  const save = () => start(async () => { setErr(null); const r = await saveCommandView({ name, filters: currentFilters, layout }); if (!r.ok) { setErr(r.error); return; } setOpen(false); setName(""); router.push(`/app?${new URLSearchParams({ ...currentFilters, view: r.id! })}`); router.refresh(); });
  return (
    <>
      <div className="flex items-center gap-1.5">
        <label className="sr-only" htmlFor="saved-views">Saved views</label>
        <select id="saved-views" value={activeId ?? ""} onChange={(e) => go(e.target.value)} data-testid="cmd-views"
          className="h-9 max-w-[11rem] rounded-xl bg-white/10 px-2.5 text-xs font-semibold text-white ring-1 ring-white/20 [&>option]:text-ink">
          <option value="">{views.length ? "Saved views" : "No saved views"}</option>
          {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <Button variant="glass" size="sm" className="h-9" onClick={() => setOpen(true)} data-testid="cmd-save-view"><Bookmark size={14} />Save view</Button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Save this view">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Input label="View name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="e.g. Operations — conservative" data-testid="cmd-view-name" autoFocus />
          <p className="text-xs text-ink-2">Saves the current filters ({Object.keys(currentFilters).length ? Object.entries(currentFilters).map(([k, v]) => `${k}=${v.length > 12 ? v.slice(0, 8) + "…" : v}`).join(", ") : "none"}) and section layout. Only you can see it.</p>
          {err && <p className="text-xs text-coral-ink" role="alert">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={pending} disabled={!name.trim()} data-testid="cmd-view-submit">Save view</Button></div>
        </form>
      </Modal>
    </>
  );
}

export function CustomizeDrawer({ open, onClose, layout, views }: { open: boolean; onClose: () => void; layout: { hidden: string[]; order: string[] }; views: SavedView[] }) {
  const router = useRouter(); const [pending, start] = React.useTransition(); const [err, setErr] = React.useState<string | null>(null);
  const normalize = (o: string[]) => [...o.filter((k) => SECTION_KEYS.includes(k as CommandSectionKey)), ...SECTION_KEYS.filter((k) => !o.includes(k))];
  const [order, setOrder] = React.useState<string[]>(() => normalize(layout.order));
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set(layout.hidden));
  React.useEffect(() => { if (open) { setOrder(normalize(layout.order)); setHidden(new Set(layout.hidden)); } }, [open, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = (i: number, d: -1 | 1) => setOrder((o) => { const j = i + d; if (j < 0 || j >= o.length) return o; const n = [...o]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const save = (h: string[], o: string[]) => start(async () => { setErr(null); const r = await saveCommandLayout({ hidden: h, order: o }); if (!r.ok) { setErr(r.error); return; } router.refresh(); onClose(); });
  const label = (k: string) => COMMAND_SECTIONS.find((s) => s.key === k)?.label ?? k;
  return (
    <Drawer open={open} onClose={onClose} title="Customize command center" testid="cmd-customize-drawer" width="max-w-md">
      <p className="mb-3 text-sm text-ink-2">Show, hide and reorder sections. Saved to your account for this organization.</p>
      <ol className="space-y-1.5" data-testid="cmd-sections">
        {order.map((k, i) => { const shown = !hidden.has(k); return (
          <li key={k} className={cn("flex items-center gap-2 rounded-xl border border-border p-2.5", !shown && "opacity-60")} data-testid={`cmd-section-${k}`}>
            <button type="button" onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; })} aria-pressed={shown} aria-label={`${shown ? "Hide" : "Show"} ${label(k)}`} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2" data-testid={`cmd-toggle-${k}`}>{shown ? <Eye size={16} /> : <EyeOff size={16} />}</button>
            <span className="min-w-0 flex-1 text-sm font-medium">{label(k)}</span>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${label(k)} up`} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-30" data-testid={`cmd-up-${k}`}><ArrowUp size={15} /></button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label={`Move ${label(k)} down`} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-30" data-testid={`cmd-down-${k}`}><ArrowDown size={15} /></button>
          </li>
        ); })}
      </ol>
      {err && <p className="mt-2 text-xs text-coral-ink" role="alert">{err}</p>}
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={() => save([], [...SECTION_KEYS])} disabled={pending} data-testid="cmd-layout-reset"><RotateCcw size={14} />Reset</Button>
        <Button onClick={() => save([...hidden], order)} loading={pending} data-testid="cmd-layout-save"><Settings2 size={14} />Save layout</Button>
      </div>
      {views.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-2">Saved views</h3>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {views.map((v) => (
              <li key={v.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{v.name}</span>
                <button type="button" aria-label={`Delete view ${v.name}`} className="rounded-lg p-1.5 text-coral-ink hover:bg-coral-soft" data-testid={`cmd-view-delete-${v.id}`}
                  onClick={() => start(async () => { const r = await deleteCommandView(v.id); if (r.ok) router.refresh(); else setErr(r.error); })}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}
