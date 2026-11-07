"use client";
/**
 * Tour host — spotlights real elements (by data-testid) with an accessible popover.
 *  - start: window event `bb:tour` { detail: { key, replay? } }, URL `?tour=<key>`, or first-run auto-start once per user on /app
 *    (skipped for automated browsers so it never blocks scripted test runs; reduced motion disables animation, not the tour).
 *  - keyboard: focus-trapped dialog, ←/→ to move, ESC pauses (progress saved to tour_progress). Missing targets are logged and skipped.
 *  - ≤640px: the popover becomes a bottom sheet. Optional narration via speechSynthesis (off by default).
 */
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X, ChevronLeft, ChevronRight, Pause, Volume2, VolumeX, Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOURS, isTourKey, resumeStep, shouldAutoStart, type TourKey, type TourProgress } from "@/engine/tours";

type Active = { key: TourKey; step: number };
type Rect = { top: number; left: number; width: number; height: number };
const PAD = 8;

async function save(tourKey: TourKey, step: number, extra: { completed?: boolean; reset?: boolean } = {}) {
  try { await fetch("/api/assistant/tours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tourKey, step, ...extra }) }); } catch {}
}
export const startTour = (key: TourKey, replay = false) => window.dispatchEvent(new CustomEvent("bb:tour", { detail: { key, replay } }));

function routeMatches(route: string | undefined, path: string, sp: URLSearchParams) {
  if (!route) return true;
  const [p, qs] = route.split("?");
  if (p !== path) return false;
  if (!qs) return true;
  return [...new URLSearchParams(qs)].every(([k, v]) => sp.get(k) === v);
}

export function TourHost() {
  const router = useRouter(); const path = usePathname(); const sp = useSearchParams();
  const [active, setActive] = React.useState<Active | null>(null);
  const [rect, setRect] = React.useState<Rect | null>(null);
  const [narrate, setNarrate] = React.useState(false);
  const [reduced, setReduced] = React.useState(false);
  const [mobile, setMobile] = React.useState(false);
  const progressRef = React.useRef<TourProgress[] | null>(null);
  const popRef = React.useRef<HTMLDivElement>(null); const lastFocus = React.useRef<HTMLElement | null>(null);
  const searching = React.useRef(0);

  React.useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)"); setReduced(m.matches);
    const mm = window.matchMedia("(max-width: 640px)"); setMobile(mm.matches); const h = () => setMobile(mm.matches); mm.addEventListener("change", h);
    try { setNarrate(localStorage.getItem("bb-tour-voice") === "1"); } catch {}
    return () => mm.removeEventListener("change", h);
  }, []);

  const begin = React.useCallback(async (key: TourKey, replay = false) => {
    lastFocus.current = document.activeElement as HTMLElement | null;
    if (!progressRef.current) progressRef.current = await fetch("/api/assistant/tours").then((r) => (r.ok ? r.json() : { progress: [] })).then((j) => j.progress as TourProgress[]).catch(() => []);
    const p = progressRef.current?.find((x) => x.tourKey === key);
    const step = replay ? 0 : resumeStep(TOURS[key], p) ?? 0;
    if (replay || p?.completedAt) save(key, 0, { reset: true });
    setActive({ key, step });
  }, []);

  // start triggers
  React.useEffect(() => {
    const onEvt = (e: Event) => { const d = (e as CustomEvent<{ key: string; replay?: boolean }>).detail; if (isTourKey(d?.key)) begin(d.key, !!d.replay); };
    window.addEventListener("bb:tour", onEvt); return () => window.removeEventListener("bb:tour", onEvt);
  }, [begin]);
  const urlStarted = React.useRef<string | null>(null);
  React.useEffect(() => { const t = sp.get("tour"); if (isTourKey(t) && urlStarted.current !== t) { urlStarted.current = t; begin(t, sp.get("replay") === "1"); } }, [sp, begin]);
  React.useEffect(() => {
    if (path !== "/app" || active) return;
    if ((navigator as Navigator & { webdriver?: boolean }).webdriver) return;
    let cancelled = false;
    fetch("/api/assistant/tours").then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (cancelled || !j) return; progressRef.current = j.progress;
      if (shouldAutoStart(j.progress) && document.querySelector('[data-testid="home-band"]')) { save("first-run", 0); progressRef.current = [...j.progress, { tourKey: "first-run", step: 0, completedAt: null, updatedAt: new Date().toISOString() }]; setTimeout(() => !cancelled && setActive({ key: "first-run", step: 0 }), 900); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const tour = active ? TOURS[active.key] : null;
  const step = tour && active ? tour.steps[active.step] : null;

  const finish = React.useCallback((completed: boolean) => {
    if (!active) return;
    save(active.key, active.step, { completed });
    progressRef.current = (progressRef.current ?? []).filter((p) => p.tourKey !== active.key).concat({ tourKey: active.key, step: active.step, completedAt: completed ? new Date().toISOString() : null, updatedAt: new Date().toISOString() });
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setActive(null); setRect(null); lastFocus.current?.focus?.();
  }, [active]);
  const goto = React.useCallback((n: number) => {
    if (!active || !tour) return;
    if (n >= tour.steps.length) return finish(true);
    const s = Math.max(0, n); setActive({ key: active.key, step: s }); save(active.key, s);
  }, [active, tour, finish]);

  // navigate to the step's route, then locate the target (skip gracefully when missing)
  React.useEffect(() => {
    if (!active || !step) return;
    setRect(null);
    if (!routeMatches(step.route, path, new URLSearchParams(sp.toString()))) { router.push(step.route!); return; }
    const token = ++searching.current; const started = Date.now();
    const find = () => {
      if (token !== searching.current) return;
      const el = document.querySelector<HTMLElement>(`[data-testid="${step.target}"]`);
      if (el && el.getBoundingClientRect().height > 0) {
        if (mobile) window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 76), behavior: reduced ? "auto" : "smooth" }); // clear the sticky header; bottom sheet covers the lower half
        else el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
        setTimeout(() => { if (token === searching.current) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left, width: r.width, height: r.height }); } }, reduced ? 0 : 350);
        return;
      }
      if (Date.now() - started > 4000) { console.info(`[tour] ${active.key}: target "${step.target}" not found — skipping step ${active.step + 1}`); goto(active.step + 1); return; }
      setTimeout(find, 150);
    };
    find();
  }, [active, step, path, sp, router, reduced, mobile, goto]);

  // keep the spotlight attached while scrolling / resizing
  React.useEffect(() => {
    if (!active || !step) return;
    const upd = () => { const el = document.querySelector<HTMLElement>(`[data-testid="${step.target}"]`); if (el) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left, width: r.width, height: r.height }); } };
    window.addEventListener("scroll", upd, true); window.addEventListener("resize", upd);
    return () => { window.removeEventListener("scroll", upd, true); window.removeEventListener("resize", upd); };
  }, [active, step]);

  // focus + narration
  React.useEffect(() => {
    if (!rect || !step) return;
    popRef.current?.querySelector<HTMLElement>("[data-tour-primary]")?.focus({ preventScroll: true });
    if (narrate && "speechSynthesis" in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(`${step.title}. ${step.body}`)); }
  }, [rect, step, narrate]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!active) return;
    if (e.key === "Escape") { e.preventDefault(); finish(false); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); goto(active.step + 1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); goto(active.step - 1); return; }
    if (e.key === "Tab" && popRef.current) {
      const f = popRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  if (!active || !tour || !step || !rect) return null;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1440; const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const spot = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  const popW = Math.min(360, vw - 32);
  const H = 240; const bottom = spot.top + spot.height;
  const place = bottom + H + 12 < vh ? "below" : spot.top - H - 12 > 0 ? "above" : spot.left + spot.width + popW + 24 < vw ? "right" : spot.left - popW - 24 > 0 ? "left" : "below";
  const clampTop = (t: number) => Math.max(16, Math.min(vh - H - 16, t));
  const centeredLeft = Math.max(16, Math.min(vw - popW - 16, spot.left + spot.width / 2 - popW / 2));
  const popStyle: React.CSSProperties = mobile ? {} :
    place === "below" ? { width: popW, left: centeredLeft, top: Math.min(vh - H - 16, bottom + 12) }
    : place === "above" ? { width: popW, left: centeredLeft, bottom: vh - spot.top + 12 }
    : place === "right" ? { width: popW, left: spot.left + spot.width + 12, top: clampTop(spot.top + spot.height / 2 - H / 2) }
    : { width: popW, left: spot.left - popW - 12, top: clampTop(spot.top + spot.height / 2 - H / 2) };
  const last = active.step === tour.steps.length - 1;
  return (
    <div className="no-print fixed inset-0 z-[70]" onKeyDown={onKey} data-testid="tour-overlay">
      <div className={cn("pointer-events-none absolute rounded-2xl ring-2 ring-purple", !reduced && "transition-all duration-300")} style={{ ...spot, boxShadow: "0 0 0 9999px rgba(7,20,38,.62)" }} data-testid="tour-spotlight" />
      <div className="absolute inset-0" onClick={() => finish(false)} aria-hidden />
      <div ref={popRef} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" data-testid="tour-popover" style={popStyle}
        className={cn("absolute border border-border bg-surface p-4 shadow-[var(--shadow-pop)]", mobile ? "inset-x-0 bottom-0 rounded-t-[22px] pb-6" : "rounded-2xl", !reduced && "fade-up")}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.14em] text-purple-ink"><Compass size={13} />{tour.title} · {active.step + 1}/{tour.steps.length}</div>
          <div className="flex gap-0.5">
            <button onClick={() => { const v = !narrate; setNarrate(v); try { localStorage.setItem("bb-tour-voice", v ? "1" : "0"); } catch {} if (!v) window.speechSynthesis?.cancel(); }} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2" aria-pressed={narrate} aria-label={narrate ? "Turn off narration" : "Narrate this tour"} data-testid="tour-voice">{narrate ? <Volume2 size={15} /> : <VolumeX size={15} />}</button>
            <button onClick={() => finish(false)} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2" aria-label="Pause tour (Esc)" data-testid="tour-pause"><Pause size={15} /></button>
            <button onClick={() => finish(true)} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2" aria-label="End tour" data-testid="tour-close"><X size={15} /></button>
          </div>
        </div>
        <h2 id="tour-title" className="mt-2 text-base font-bold">{step.title}</h2>
        <p id="tour-body" className="mt-1 text-sm text-ink-2">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex gap-1.5" aria-label={`Step ${active.step + 1} of ${tour.steps.length}`} role="img" data-testid="tour-dots">{tour.steps.map((_, i) => <span key={i} className={cn("h-1.5 rounded-full", i === active.step ? "w-5 bg-purple" : i < active.step ? "w-1.5 bg-purple/50" : "w-1.5 bg-surface-3")} />)}</div>
          <div className="flex gap-2">
            {active.step > 0 && <button onClick={() => goto(active.step - 1)} className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-surface-2" data-testid="tour-back"><ChevronLeft size={15} />Back</button>}
            <button data-tour-primary onClick={() => goto(active.step + 1)} className="inline-flex h-9 items-center gap-1 rounded-xl bg-[linear-gradient(135deg,#6366f1,#8b5cf6)] px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple/40" data-testid="tour-next">{last ? "Finish" : "Next"}{!last && <ChevronRight size={15} />}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Header help menu: start, resume or replay any tour. */
export function TourMenu() {
  const [open, setOpen] = React.useState(false); const [progress, setProgress] = React.useState<TourProgress[]>([]);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (!open) return; fetch("/api/assistant/tours").then((r) => (r.ok ? r.json() : { progress: [] })).then((j) => setProgress(j.progress ?? [])).catch(() => {}); const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false); document.addEventListener("mousedown", h); document.addEventListener("keydown", k); return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); }; }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="flex h-9 items-center gap-1.5 rounded-xl border border-border px-2.5 text-xs font-semibold text-ink-2 hover:bg-surface-2" aria-haspopup="menu" aria-expanded={open} data-testid="tour-menu"><Compass size={15} /><span className="hidden xl:inline">Take a tour</span></button>
      {open && (
        <div role="menu" className="card absolute right-0 z-50 mt-1 w-72 p-1.5 shadow-[var(--shadow-pop)]" data-testid="tour-menu-list">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-bold uppercase tracking-[.14em] text-ink-3">Guided tours</div>
          {Object.values(TOURS).map((t) => { const p = progress.find((x) => x.tourKey === t.key); const done = !!p?.completedAt; const paused = p && !done && p.step > 0; return (
            <div key={t.key} className="flex items-center gap-1 rounded-lg hover:bg-surface-2">
              <button role="menuitem" onClick={() => { setOpen(false); startTour(t.key, done); }} className="min-w-0 flex-1 px-2.5 py-2 text-left" data-testid={`tour-start-${t.key}`}>
                <div className="text-sm font-semibold">{t.title}{done && <span className="ml-1.5 text-[10px] font-bold uppercase text-emerald-ink">Done</span>}{paused && <span className="ml-1.5 text-[10px] font-bold uppercase text-gold-ink">Paused · step {p!.step + 1}</span>}</div>
                <div className="truncate text-[11px] text-ink-2">{t.description}</div>
              </button>
              {(done || paused) && <button role="menuitem" onClick={() => { setOpen(false); startTour(t.key, true); }} className="mr-1 rounded-md px-2 py-1 text-[11px] font-semibold text-royal-ink hover:bg-royal-soft" data-testid={`tour-replay-${t.key}`}>Replay</button>}
            </div>); })}
        </div>
      )}
    </div>
  );
}
