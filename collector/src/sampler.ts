/**
 * Foreground sampler + event state machine.
 *
 * Sources:
 *  - RealForeground: uses `active-win` (optional dependency, loaded lazily) to read the foreground
 *    window's owner process and title. Only the process identity and the title string enter this
 *    process; the title is immediately reduced to { titleCategory, titleHash } by normalize.ts.
 *    No input hooks, no screenshots, no URL reading (active-win's `url` field is ignored on purpose).
 *  - SimulatedForeground: deterministic synthetic office day for --simulate / CI on Linux.
 *
 * Idle detection: `desktop-idle` is used ONLY if present; otherwise a heuristic — no foreground
 * change for idleThresholdSec counts as idle. (Without OS input hooks true idle is unknowable; we
 * deliberately do not install hooks.)
 */
import type { WireEvent } from "../../src/collector-protocol/schema";
import { normalizeApp, categorizeTitle, hashTitle, isBlocked, DOC_APP_CATEGORIES, type AppInfo } from "./normalize";

export type Foreground = { processName?: string; appName?: string; bundleId?: string; path?: string; title?: string } | null;
export interface ForegroundSource { read(): Promise<Foreground>; idleSeconds?(): Promise<number | null>; readonly name: string; }

// ---------- real source (active-win) ----------
type ActiveWinResult = { title?: string; owner?: { name?: string; processId?: number; bundleId?: string; path?: string } } | undefined;
export class RealForeground implements ForegroundSource {
  readonly name = "active-win";
  private activeWin: null | (() => Promise<ActiveWinResult>) = null;
  private idle: null | (() => number) = null;
  private loaded = false;
  private async load() {
    if (this.loaded) return; this.loaded = true;
    try { const m = await import("active-win"); this.activeWin = (m as unknown as { default?: () => Promise<ActiveWinResult>; activeWindow?: () => Promise<ActiveWinResult> }).default ?? (m as { activeWindow?: () => Promise<ActiveWinResult> }).activeWindow ?? null; }
    catch (e) { throw new Error(`active-win is not installed or failed to load on this platform (${e instanceof Error ? e.message : e}). Run \`npm install\` in collector/ on Windows/macOS, or use --simulate.`); }
    try { const d = await import("desktop-idle"); this.idle = (d as unknown as { getIdleTime?: () => number }).getIdleTime ?? null; } catch { this.idle = null; }
  }
  async read(): Promise<Foreground> {
    await this.load();
    if (!this.activeWin) return null;
    const w = await this.activeWin();
    if (!w) return null;
    return { appName: w.owner?.name, bundleId: w.owner?.bundleId, path: w.owner?.path, title: w.title }; // w.url intentionally dropped
  }
  async idleSeconds() { await this.load(); return this.idle ? this.idle() : null; }
}

// ---------- simulated source ----------
const SIM_DAY: [string, string, number][] = [ // [process, title, ticks]
  ["OUTLOOK.EXE", "Inbox - dana@example.com - Outlook", 6], ["OUTLOOK.EXE", "Invoice #10422 from Acme - Message", 4],
  ["AcroRd32.exe", "INV-10422.pdf - Adobe Acrobat Reader", 5], ["QBW32.EXE", "Enter Bills - QuickBooks Desktop", 14],
  ["EXCEL.EXE", "AP Invoice Log 2026.xlsx - Excel", 7], ["OUTLOOK.EXE", "RE: Approval request INV-10422 - Message", 5],
  ["chrome.exe", "Customer Portal - Orders - Google Chrome", 6], ["chrome.exe", "NetSuite: Sales Order - Google Chrome", 12],
  ["EXCEL.EXE", "Pricing Sheet Q4.xlsx - Excel", 4], ["Teams.exe", "Weekly standup | Microsoft Teams", 10],
  ["1Password.exe", "1Password", 2], ["slack.exe", "#finance - Gulf Coast Supply - Slack", 3],
  ["EXCEL.EXE", "Weekly Report.xlsx - Excel", 9], ["POWERPNT.EXE", "Weekly Deck.pptx - PowerPoint", 8],
  ["", "", 10], // idle stretch
  ["chrome.exe", "Chase Online Banking - Google Chrome", 2], ["Zendesk", "Ticket #4471 - Zendesk", 6],
];
export class SimulatedForeground implements ForegroundSource {
  readonly name = "simulated";
  private i = 0; private left = SIM_DAY[0][2];
  constructor(private readonly rnd: () => number = Math.random) {}
  async read(): Promise<Foreground> {
    const [proc, title] = SIM_DAY[this.i];
    this.left -= 1;
    if (this.left <= 0) { this.i = (this.i + 1) % SIM_DAY.length; this.left = Math.max(1, Math.round(SIM_DAY[this.i][2] * (0.6 + this.rnd() * 0.8))); }
    return proc ? { processName: proc, title } : null;
  }
}

// ---------- state machine ----------
export type SamplerOptions = { salt: string; blockedApps: string[]; idleThresholdSec: number; titleMode: "hash" | "category" | "none"; maxSegmentMs?: number; now?: () => number };
type Segment = { app: AppInfo; titleCategory: string; titleHash: string; startedAt: number } | null;

export class Sampler {
  private seg: Segment = null;
  private lastChangeAt: number;
  private idleSince: number | null = null;
  private readonly now: () => number;
  constructor(private opts: SamplerOptions) { this.now = opts.now ?? Date.now; this.lastChangeAt = this.now(); }
  update(opts: Partial<SamplerOptions>) { Object.assign(this.opts, opts); }

  private titleFields(title?: string): { titleCategory?: string; titleHash?: string } {
    const cat = categorizeTitle(title), h = hashTitle(title, this.opts.salt);
    if (this.opts.titleMode === "none") return {};
    if (this.opts.titleMode === "category") return cat ? { titleCategory: cat } : {};
    return { ...(cat ? { titleCategory: cat } : {}), ...(h ? { titleHash: h } : {}) };
  }
  private closeSegment(at: number, out: WireEvent[]) {
    if (!this.seg) return;
    const dur = Math.max(0, at - this.seg.startedAt);
    if (dur > 0) out.push({ ts: new Date(this.seg.startedAt).toISOString(), type: "app_focus", app: this.seg.app.app, appCategory: this.seg.app.appCategory, durationMs: dur, ...this.titleFieldsFromSeg() });
    this.seg = null;
  }
  private titleFieldsFromSeg() {
    if (!this.seg) return {};
    const { titleCategory, titleHash } = this.seg;
    if (this.opts.titleMode === "none") return {};
    if (this.opts.titleMode === "category") return titleCategory ? { titleCategory } : {};
    return { ...(titleCategory ? { titleCategory } : {}), ...(titleHash ? { titleHash } : {}) };
  }

  /** Feed one sample. Returns the events to emit (possibly none). */
  tick(fg: Foreground, osIdleSec: number | null = null): WireEvent[] {
    const now = this.now(), out: WireEvent[] = [];
    const blocked = !!fg && isBlocked(this.opts.blockedApps, fg.processName, fg.appName, fg.bundleId, fg.path);
    const info = fg && !blocked ? normalizeApp(fg) : null;
    const titleCategory = info ? categorizeTitle(fg?.title) : "";
    const titleHash = info ? hashTitle(fg?.title, this.opts.salt) : "";
    const changed = !this.seg ? !!info : !info || info.app !== this.seg.app.app || titleHash !== this.seg.titleHash;

    // idle: OS idle time when available, otherwise "nothing changed for idleThresholdSec".
    const idleNow = osIdleSec != null ? osIdleSec >= this.opts.idleThresholdSec : now - this.lastChangeAt >= this.opts.idleThresholdSec * 1000 && !changed;
    if (idleNow && this.idleSince == null) {
      const since = osIdleSec != null ? now - osIdleSec * 1000 : this.lastChangeAt;
      this.closeSegment(since, out);
      this.idleSince = since;
      out.push({ ts: new Date(since).toISOString(), type: "idle_start", app: "", appCategory: "idle", durationMs: 0 });
      return out;
    }
    if (!idleNow && this.idleSince != null) {
      out.push({ ts: new Date(this.idleSince).toISOString(), type: "idle_end", app: "", appCategory: "idle", durationMs: now - this.idleSince });
      this.idleSince = null; this.lastChangeAt = now;
      if (info) { this.seg = { app: info, titleCategory, titleHash, startedAt: now }; out.push({ ts: new Date(now).toISOString(), type: "app_switch", app: info.app, appCategory: info.appCategory, durationMs: 0, ...this.titleFields(fg?.title) }); }
      return out;
    }
    if (this.idleSince != null) return out;

    if (changed) {
      const prev = this.seg;
      this.closeSegment(now, out);
      this.lastChangeAt = now;
      if (info) {
        this.seg = { app: info, titleCategory, titleHash, startedAt: now };
        const sameApp = prev?.app.app === info.app;
        if (!sameApp) out.push({ ts: new Date(now).toISOString(), type: "app_switch", app: info.app, appCategory: info.appCategory, durationMs: 0, ...this.titleFields(fg?.title), ...(prev ? { meta: { from: prev.app.app } } : {}) });
        if (DOC_APP_CATEGORIES.has(info.appCategory) && titleCategory && (!sameApp || prev?.titleCategory !== titleCategory)) {
          out.push({ ts: new Date(now).toISOString(), type: "document_open", app: info.app, appCategory: info.appCategory, durationMs: 0, ...this.titleFields(fg?.title) });
        }
      }
    } else if (this.seg && now - this.seg.startedAt >= (this.opts.maxSegmentMs ?? 5 * 60_000)) {
      // long-running segment: flush it so batches carry progress, then continue a fresh one
      const s = this.seg; this.closeSegment(now, out); this.seg = { ...s, startedAt: now };
    }
    return out;
  }
  /** On shutdown: close the open segment. */
  flush(): WireEvent[] { const out: WireEvent[] = []; this.closeSegment(this.now(), out); return out; }
}
