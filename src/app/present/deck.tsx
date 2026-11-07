"use client";
/**
 * Presentation Mode — 12-slide boardroom deck from live data.
 * One shared DeckState drives every slide; the floating scenario panel re-runs the engines server-side and replaces it whole.
 * Keys: ←/→ (or PageUp/PageDown, Space) navigate · F full screen · T slide drawer · Esc closes drawer / exits.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Download, FileText, LayoutGrid, Maximize2, Minimize2, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import type { SlideSpec } from "@/engine/exports";
import { SCENARIOS, type ScenarioKey } from "@/engine/costing";
import { ACCENT_HEX, SCENARIO_BOUNDS, fmtValue, type Fmt } from "@/components/command/format";
import { cn } from "@/lib/utils";
import { recomputeDeck } from "./actions";
import type { DeckState } from "./summary";

type Org = { name: string; isDemo: boolean; reportName: string | null; primaryColor: string | null };
const show = (v: number | null, f: Fmt) => (f === "text" && v != null ? v.toFixed(1) : fmtValue(v, f));

export function PresentDeck({ initial, startIndex, org }: { initial: DeckState; startIndex: number; org: Org }) {
  const router = useRouter();
  const [state, setState] = React.useState<DeckState>(initial);
  const [i, setI] = React.useState(startIndex);
  const [dir, setDir] = React.useState<1 | -1>(1);
  const [thumbs, setThumbs] = React.useState(false);
  const [panel, setPanel] = React.useState(true);
  React.useEffect(() => { if (window.innerWidth < 1024) setPanel(false); }, []);
  const [full, setFull] = React.useState(false);
  const [ctl, setCtl] = React.useState({ scenario: initial.overrides.scenario as ScenarioKey, automationPct: initial.overrides.automationPct, adoptionRate: initial.overrides.adoptionRate, realizationRate: initial.overrides.realizationRate });
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState<string | null>(null);
  const [updated, setUpdated] = React.useState(0);
  const slides = state.slides; const n = slides.length;
  const brand = org.primaryColor ?? ACCENT_HEX.gold;

  // theme: present on mount, restore on exit
  React.useEffect(() => {
    const el = document.documentElement; const prev = el.getAttribute("data-theme");
    el.setAttribute("data-theme", "present");
    const fs = () => setFull(!!document.fullscreenElement); document.addEventListener("fullscreenchange", fs);
    return () => { if (prev) el.setAttribute("data-theme", prev); else el.removeAttribute("data-theme"); document.removeEventListener("fullscreenchange", fs); };
  }, []);

  const go = React.useCallback((to: number) => { setI((cur) => { const nx = Math.max(0, Math.min(n - 1, to)); setDir(nx >= cur ? 1 : -1); return nx; }); }, [n]);
  const toggleFull = React.useCallback(() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.().catch(() => {}); }, []);
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && t?.tagName !== "BUTTON")) { e.preventDefault(); go(i + 1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(i - 1); }
      else if (e.key === "Home") go(0); else if (e.key === "End") go(n - 1);
      else if (e.key === "f" || e.key === "F") toggleFull();
      else if (e.key === "t" || e.key === "T") setThumbs((v) => !v);
      else if (e.key === "Escape") { if (thumbs) setThumbs(false); else if (!document.fullscreenElement) router.push("/app"); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [i, n, go, toggleFull, thumbs, router]);

  // live scenario recompute (debounced); the whole DeckState is replaced so every slide stays consistent
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    const id = setTimeout(async () => {
      setBusy(true); setErr(null);
      try { const r = await recomputeDeck(ctl); if (r.ok) { setState(r.state); setUpdated((u) => u + 1); } else setErr(r.error); }
      catch { setErr("Could not recompute — check your connection."); }
      finally { setBusy(false); }
    }, 350);
    return () => clearTimeout(id);
  }, [ctl]);
  const preset = (k: ScenarioKey) => setCtl({ scenario: k, automationPct: SCENARIOS[k].automationMult, adoptionRate: SCENARIOS[k].adoptionRate, realizationRate: SCENARIOS[k].realizationRate });
  const exportQs = new URLSearchParams({ format: "pptx", scenario: state.overrides.scenario, automationPct: String(state.overrides.automationPct), adoptionRate: String(state.overrides.adoptionRate), realizationRate: String(state.overrides.realizationRate) }).toString();
  const s = slides[i];
  const touch = React.useRef<number | null>(null);
  const isPreset = (k: ScenarioKey) => ctl.scenario === k && Math.abs(ctl.automationPct - SCENARIOS[k].automationMult) < 1e-6 && Math.abs(ctl.adoptionRate - SCENARIOS[k].adoptionRate) < 1e-6 && Math.abs(ctl.realizationRate - SCENARIOS[k].realizationRate) < 1e-6;
  const custom = !isPreset(ctl.scenario);

  return (
    <>
    <div className="present-root fixed inset-0 flex flex-col overflow-hidden bg-[radial-gradient(1200px_600px_at_10%_-10%,rgba(99,102,241,.22),transparent_60%),radial-gradient(900px_500px_at_110%_10%,rgba(6,182,212,.14),transparent_60%),#050d1a] text-ink print:hidden" data-testid="present-root">
      {/* progress */}
      <div className="h-1 w-full bg-white/5" role="progressbar" aria-label="Deck progress" aria-valuemin={1} aria-valuemax={n} aria-valuenow={i + 1}>
        <div className="h-full transition-all duration-500" style={{ width: `${((i + 1) / n) * 100}%`, background: `linear-gradient(90deg, ${brand}, ${ACCENT_HEX.purple})` }} />
      </div>
      {/* top bar */}
      <header className="flex items-center gap-3 px-4 py-3 sm:px-8">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-bold uppercase tracking-[.18em]" style={{ color: brand }}>{org.reportName ?? "BridgeBox AI Workforce Intelligence"}</div>
          <div className="truncate text-xs text-ink-3">{org.name}{org.isDemo && " · synthetic demo data"} · {SCENARIOS[state.overrides.scenario].label} scenario{custom ? " · custom assumptions" : ""}</div>
        </div>
        <button onClick={() => setThumbs(true)} className="rounded-lg p-2 text-ink-2 hover:bg-white/10" aria-label="All slides (T)" data-testid="present-thumbs"><LayoutGrid size={18} /></button>
        <button onClick={() => setPanel((v) => !v)} className={cn("rounded-lg p-2 hover:bg-white/10", panel ? "text-gold-ink" : "text-ink-2")} aria-label="Scenario controls" aria-pressed={panel} data-testid="present-panel-toggle"><SlidersHorizontal size={18} /></button>
        <button onClick={toggleFull} className="hidden rounded-lg p-2 text-ink-2 hover:bg-white/10 sm:block" aria-label={full ? "Exit full screen (F)" : "Full screen (F)"} data-testid="present-fullscreen">{full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        <Link href="/app" className="rounded-lg p-2 text-ink-2 hover:bg-white/10" aria-label="Exit presentation (Esc)" data-testid="present-exit"><X size={18} /></Link>
      </header>

      {/* stage */}
      <main className={cn("relative min-h-0 flex-1 overflow-y-auto px-4 pb-28 sm:px-10 lg:px-16", panel && "xl:pr-[400px]")} aria-live="polite" aria-roledescription="slide" onTouchStart={(e) => { touch.current = e.touches[0].clientX; }} onTouchEnd={(e) => { if (touch.current == null) return; const dx = e.changedTouches[0].clientX - touch.current; touch.current = null; if (Math.abs(dx) > 60) go(i + (dx < 0 ? 1 : -1)); }} aria-label={`Slide ${i + 1} of ${n}: ${s.title}`}>
        <div key={`${i}-${updated}`} className={cn("mx-auto max-w-[1280px] py-2", dir === 1 ? "present-in-right" : "present-in-left")}>
          <Slide s={s} brand={brand} orgName={org.name} />
        </div>
      </main>

      {/* nav */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex items-center justify-center gap-3 sm:justify-start sm:pl-8">
        <div className="pointer-events-auto flex items-center gap-1 rounded-2xl bg-surface/85 p-1 shadow-[var(--shadow-pop)] ring-1 ring-white/10 backdrop-blur">
          <button onClick={() => go(i - 1)} disabled={i === 0} className="rounded-xl p-2 text-ink hover:bg-white/10 disabled:opacity-30" aria-label="Previous slide" data-testid="present-prev"><ChevronLeft size={20} /></button>
          <span className="min-w-[4.5rem] text-center text-sm font-semibold tabular text-ink-2" data-testid="present-counter">{i + 1} / {n}</span>
          <button onClick={() => go(i + 1)} disabled={i === n - 1} className="rounded-xl p-2 text-ink hover:bg-white/10 disabled:opacity-30" aria-label="Next slide" data-testid="present-next"><ChevronRight size={20} /></button>
        </div>
      </div>

      {/* scenario panel */}
      {panel && (
        <aside className="absolute bottom-20 right-3 z-30 w-[min(340px,calc(100vw-1.5rem))] rounded-2xl bg-surface/95 p-4 shadow-[var(--shadow-pop)] ring-1 ring-white/10 backdrop-blur sm:bottom-4 sm:right-6" aria-label="Live scenario controls" data-testid="present-panel">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink">Live scenario{custom && <span className="ml-1.5 rounded-full bg-gold-soft px-1.5 py-0.5 text-[10px] font-semibold text-gold-ink">custom</span>}</h2>
            <span className={cn("text-[11px] font-semibold", busy ? "text-cyan-ink" : err ? "text-coral-ink" : "text-ink-3")} data-testid="present-status" role="status">{busy ? "Recomputing…" : err ?? (updated ? "All 12 slides updated" : "From live data")}</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-white/5 p-0.5" role="radiogroup" aria-label="Scenario preset">
            {(["conservative", "expected", "aggressive"] as ScenarioKey[]).map((k) => (
              <button key={k} role="radio" aria-checked={isPreset(k)} onClick={() => preset(k)} data-testid={`present-scenario-${k}`} className={cn("rounded-[10px] py-1.5 text-xs font-semibold", isPreset(k) ? "bg-white text-midnight" : ctl.scenario === k ? "bg-white/15 text-ink" : "text-ink-2 hover:bg-white/10")}>{SCENARIOS[k].label}</button>
            ))}
          </div>
          <Range label="Automation multiplier" testid="present-automation" value={ctl.automationPct} bounds={SCENARIO_BOUNDS.automationPct} step={0.05} display={`×${ctl.automationPct.toFixed(2)}`} hint={state.summary.repetitiveShareAutomated != null ? `≈ ${fmtValue(state.summary.repetitiveShareAutomated, "pct")} of repetitive hours recovered` : "Scales each opportunity's modelled automation share"} onChange={(v) => setCtl((c) => ({ ...c, automationPct: v }))} />
          <Range label="Adoption" testid="present-adoption" value={ctl.adoptionRate} bounds={SCENARIO_BOUNDS.adoptionRate} step={0.05} display={fmtValue(ctl.adoptionRate, "pct")} hint="Share of eligible runs that use the automation" onChange={(v) => setCtl((c) => ({ ...c, adoptionRate: v }))} />
          <Range label="Realization" testid="present-realization" value={ctl.realizationRate} bounds={SCENARIO_BOUNDS.realizationRate} step={0.05} display={fmtValue(ctl.realizationRate, "pct")} hint="Share of freed time that becomes value" onChange={(v) => setCtl((c) => ({ ...c, realizationRate: v }))} />
          <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-white/5 p-2.5 text-center" data-testid="present-summary">
            <div><dt className="text-[10px] text-ink-3">Realizable / yr</dt><dd className="tabular text-sm font-bold text-gold-ink">{fmtValue(state.summary.realizable, "usdCompact")}</dd></div>
            <div><dt className="text-[10px] text-ink-3">ROI yr 1</dt><dd className="tabular text-sm font-bold text-indigo-ink">{fmtValue(state.summary.roi1y, "pct")}</dd></div>
            <div><dt className="text-[10px] text-ink-3">Payback</dt><dd className="tabular text-sm font-bold text-indigo-ink">{fmtValue(state.summary.paybackMonths, "months")}</dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <a href={`/api/export/executive?${exportQs}`} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[linear-gradient(135deg,#2563eb,#6366f1_55%,#8b5cf6)] px-2 text-xs font-semibold text-white hover:brightness-110" data-testid="present-export-pptx"><Download size={13} />PPTX</a>
            <button onClick={() => window.print()} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/10 px-2 text-xs font-semibold text-ink hover:bg-white/15" data-testid="present-export-pdf"><FileText size={13} />PDF</button>
            <button onClick={() => preset(initial.overrides.scenario)} className="inline-flex h-8 items-center justify-center rounded-lg px-2 text-ink-2 hover:bg-white/10" aria-label="Reset controls" data-testid="present-reset"><RotateCcw size={13} /></button>
          </div>
        </aside>
      )}

      {/* thumbnails */}
      {thumbs && (
        <div className="absolute inset-0 z-40 flex bg-black/50 backdrop-blur-sm" onClick={() => setThumbs(false)} role="dialog" aria-modal="true" aria-label="All slides" data-testid="present-thumbs-drawer">
          <div className="h-full w-full max-w-sm overflow-y-auto bg-surface p-4 shadow-[var(--shadow-pop)] fade-up" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-bold">All slides</h2><button onClick={() => setThumbs(false)} aria-label="Close" className="rounded-lg p-1.5 text-ink-2 hover:bg-white/10"><X size={16} /></button></div>
            <ol className="space-y-2">
              {slides.map((x, k) => (
                <li key={x.key}>
                  <button onClick={() => { go(k); setThumbs(false); }} data-testid={`present-thumb-${k + 1}`} aria-current={k === i ? "step" : undefined}
                    className={cn("w-full rounded-xl border p-3 text-left transition hover:border-white/30", k === i ? "border-transparent ring-2" : "border-border")} style={k === i ? { boxShadow: `0 0 0 2px ${brand}` } : undefined}>
                    <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: brand }}>{k + 1} · {x.kicker}</div>
                    <div className="mt-0.5 text-sm font-semibold">{x.title}</div>
                    {x.metrics[0] && !x.empty && <div className="mt-1 text-xs text-ink-3">{x.metrics[0].label}: <span className="tabular text-ink-2">{show(x.metrics[0].value, x.metrics[0].format)}</span></div>}
                    {x.empty && <div className="mt-1 text-xs text-coral-ink">{x.empty.title}</div>}
                  </button>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[11px] text-ink-3">Keys: ← → navigate · F full screen · T slides · Esc exit</p>
          </div>
        </div>
      )}

      <style>{`
        @keyframes present-in-r { from { opacity: 0; transform: translateX(28px) scale(.99); } to { opacity: 1; transform: none; } }
        @keyframes present-in-l { from { opacity: 0; transform: translateX(-28px) scale(.99); } to { opacity: 1; transform: none; } }
        .present-in-right { animation: present-in-r .45s cubic-bezier(.2,.8,.2,1) both; }
        .present-in-left { animation: present-in-l .45s cubic-bezier(.2,.8,.2,1) both; }
      `}</style>
    </div>
    <style>{`@media print {
      .present-print { display: block !important; } @page { size: landscape; margin: 12mm; } html, body { background: #fff !important; }
      :root[data-theme="present"] { --color-ink:#0b1324; --color-ink-2:#475569; --color-ink-3:#64748b; --color-royal-ink:#1d4ed8; --color-purple-ink:#6d28d9; --color-cyan-ink:#0e7490; --color-emerald-ink:#047857; --color-gold-ink:#b45309; --color-coral-ink:#be123c; --color-indigo-ink:#4338ca; font-size: 13px; }
    }`}</style>
    <PrintDeck slides={slides} brand={brand} orgName={org.name} />
    </>
  );
}

function Range({ label, value, bounds, step, display, hint, onChange, testid }: { label: string; value: number; bounds: readonly [number, number]; step: number; display: string; hint: string; onChange: (v: number) => void; testid: string }) {
  const id = React.useId();
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between"><label htmlFor={id} className="text-xs font-semibold text-ink-2">{label}</label><span className="tabular text-sm font-bold text-ink">{display}</span></div>
      <input id={id} type="range" min={bounds[0]} max={bounds[1]} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-[#f59e0b]" aria-describedby={`${id}-h`} data-testid={testid} />
      <div id={`${id}-h`} className="text-[10px] text-ink-3">{hint}</div>
    </div>
  );
}

const INK: Record<string, string> = { royal: "text-royal-ink", purple: "text-purple-ink", cyan: "text-cyan-ink", emerald: "text-emerald-ink", gold: "text-gold-ink", coral: "text-coral-ink", indigo: "text-indigo-ink", midnight: "text-ink" };

function Slide({ s, brand, orgName, print }: { s: SlideSpec; brand: string; orgName: string; print?: boolean }) {
  const both = !!s.chart && !!s.table;
  return (
    <article className={cn(print ? "text-black" : "")} data-testid={print ? undefined : `slide-${s.n}`}>
      <div className="text-xs font-bold uppercase tracking-[.2em] sm:text-sm" style={{ color: brand }}>{s.n === 1 ? orgName : s.kicker}</div>
      <h1 className={cn("mt-1 font-display font-bold tracking-tight", s.n === 1 ? "text-3xl sm:text-5xl lg:text-6xl" : "text-2xl sm:text-4xl")}>{s.n === 1 ? "Enterprise Transformation Briefing" : s.title}</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-2 sm:text-lg">{s.lead}</p>
      {s.empty ? (
        <div className="mt-8 rounded-2xl border border-dashed border-white/15 bg-white/[.03] p-6 sm:p-10" data-testid="slide-empty">
          <div className="text-lg font-bold sm:text-2xl">{s.empty.title}</div>
          <p className="mt-1 text-sm text-ink-2 sm:text-base">{s.empty.body} This slide fills in from real data — nothing here is a placeholder.</p>
          {!print && <Link href={s.empty.href} className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-royal-ink hover:underline">Go there<ChevronRight size={14} /></Link>}
        </div>
      ) : (
        <>
          {s.metrics.length > 0 && (
            <div className={cn("mt-6 grid gap-3 sm:gap-4", s.metrics.length >= 4 ? "grid-cols-2 lg:grid-cols-4" : s.metrics.length === 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2")}>
              {s.metrics.map((m) => (
                <div key={m.label} className="relative overflow-hidden rounded-2xl bg-white/[.04] p-4 ring-1 ring-white/10 sm:p-5">
                  <div className="absolute inset-x-0 top-0 h-1" style={{ background: ACCENT_HEX[m.accent] }} />
                  <div className="text-xs font-semibold text-ink-2 sm:text-sm">{m.label}</div>
                  <div className={cn("mt-1 font-display font-bold tabular", m.value == null ? "text-lg text-ink-3 sm:text-2xl" : cn("text-2xl sm:text-4xl", INK[m.accent]))}>{m.value == null ? (m.note ?? "—") : show(m.value, m.format)}</div>
                  <div className="mt-1 text-[11px] text-ink-3 sm:text-xs"><span className="capitalize">{m.basis}</span>{m.note && m.value != null ? ` · ${m.note}` : ""}</div>
                </div>
              ))}
            </div>
          )}
          {(s.chart || s.table) && (
            <div className={cn("mt-6 grid gap-5", both && "lg:grid-cols-2")}>
              {s.chart && s.chart.bars.length > 0 && <Bars chart={s.chart} />}
              {s.table && (
                <div className="min-w-0">
                  {s.table.title && <div className="mb-2 text-sm font-semibold text-ink-2">{s.table.title}</div>}
                  <div className="scrollbar-thin overflow-x-auto rounded-2xl ring-1 ring-white/10">
                    <table className="w-full text-sm">
                      <thead><tr>{s.table.columns.map((c) => <th key={c.label} className={cn("whitespace-nowrap px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide text-white", c.format ? "text-right" : "text-left")} style={{ background: brand }}>{c.label}</th>)}</tr></thead>
                      <tbody>{s.table.rows.map((r, k) => <tr key={k} className="border-t border-white/5 odd:bg-white/[.02]">{r.map((v, j) => { const c = s.table!.columns[j]; return <td key={j} className={cn("px-3 py-2", c.format ? "whitespace-nowrap text-right tabular" : "min-w-[8rem]", j === 0 && "font-semibold")}>{typeof v === "number" ? show(v, c.format ?? "count") : v ?? "—"}</td>; })}</tr>)}</tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          {s.phases && (
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {s.phases.map((p, k) => (
                <div key={p.name} className="relative overflow-hidden rounded-2xl bg-white/[.04] p-5 ring-1 ring-white/10">
                  <div className="absolute inset-x-0 top-0 h-1" style={{ background: [ACCENT_HEX.emerald, ACCENT_HEX.cyan, ACCENT_HEX.purple][k] }} />
                  <div className="text-base font-bold sm:text-lg">{p.name}</div>
                  <div className="text-xs text-ink-3">{p.window}</div>
                  <div className="mt-2 font-display text-2xl font-bold tabular text-gold-ink">{fmtValue(p.value, "usdCompact")}<span className="text-sm font-medium text-ink-3">/yr</span></div>
                  <ul className="mt-3 space-y-1.5 text-sm text-ink-2">{p.items.length ? p.items.map((t) => <li key={t} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />{t}</li>) : <li className="italic text-ink-3">No opportunities in this phase</li>}</ul>
                </div>
              ))}
            </div>
          )}
          {s.bullets && s.bullets.length > 0 && (
            <ul className="mt-6 space-y-3">
              {s.bullets.map((b) => <li key={b} className="flex gap-3 text-base text-ink sm:text-xl"><span className="mt-2.5 h-2 w-2 shrink-0 rounded-sm" style={{ background: brand }} />{b}</li>)}
            </ul>
          )}
        </>
      )}
      {s.footnote && <p className="mt-6 max-w-5xl text-[11px] leading-relaxed text-ink-3 sm:text-xs">{s.footnote}</p>}
    </article>
  );
}

function Bars({ chart }: { chart: NonNullable<SlideSpec["chart"]> }) {
  const max = Math.max(1, ...chart.bars.map((b) => b.value));
  return (
    <figure className="rounded-2xl bg-white/[.03] p-4 ring-1 ring-white/10 sm:p-5" aria-label={`${chart.title}: ${chart.bars.map((b) => `${b.label} ${fmtValue(b.value, chart.format)}`).join(", ")}`}>
      <figcaption className="mb-3 text-sm font-semibold text-ink-2">{chart.title}</figcaption>
      <ul className="space-y-2.5">
        {chart.bars.map((b, k) => (
          <li key={b.label} className="grid grid-cols-[minmax(0,8.5rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate text-ink-2">{b.label}</span>
            <span className="h-3.5 overflow-hidden rounded-full bg-white/5"><span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${(b.value / max) * 100}%`, background: `linear-gradient(90deg, ${ACCENT_HEX[b.accent]}aa, ${ACCENT_HEX[b.accent]})`, transitionDelay: `${k * 40}ms` }} /></span>
            <span className="tabular font-semibold">{fmtValue(b.value, chart.format)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Print-only rendering of every slide (PDF via the browser's print dialog), one per landscape page, with the current scenario. */
function PrintDeck({ slides, brand, orgName }: { slides: SlideSpec[]; brand: string; orgName: string }) {
  return (
    <div className="present-print hidden" aria-hidden>
      {slides.map((s) => <div key={s.key} style={{ breakAfter: "page", padding: "8mm 4mm" }}><Slide s={s} brand={brand} orgName={orgName} print /></div>)}
    </div>
  );
}
