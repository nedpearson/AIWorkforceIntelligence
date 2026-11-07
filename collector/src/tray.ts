/**
 * "Tray" without Electron: a console status line plus two control channels an employee (or an
 * IT script) can use to pause/resume the running collector:
 *   1. Control file  <dataDir>/control.json   { "command": "pause", "minutes": 30 } | { "command": "resume" }
 *      Written by `bridgebox-collector pause 30` / `bridgebox-collector resume`; polled every 2s.
 *   2. POSIX signals  SIGUSR1 = pause (60 min), SIGUSR2 = resume (macOS/Linux only).
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type Control = { command: "pause"; minutes?: number } | { command: "resume" } | { command: "stop" };
export type StatusSnapshot = { state: "running" | "paused" | "outside_schedule" | "consent_missing" | "stopping"; pausedUntil?: string | null; queued: number; sent: number; lastFlushAt?: string | null; lastError?: string | null; source: string };

export const controlPath = (dataDir: string) => join(dataDir, "control.json");
export const statusPath = (dataDir: string) => join(dataDir, "status.json");

export function writeControl(dataDir: string, c: Control) { writeFileSync(controlPath(dataDir), JSON.stringify(c)); }

export function readAndClearControl(dataDir: string): Control | null {
  const p = controlPath(dataDir);
  if (!existsSync(p)) return null;
  try { const c = JSON.parse(readFileSync(p, "utf8")) as Control; unlinkSync(p); return c; } catch { try { unlinkSync(p); } catch { /* ignore */ } return null; }
}

export class Tray {
  private last = "";
  private onControl: (c: Control) => void;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly dataDir: string, onControl: (c: Control) => void, private readonly quiet = false) {
    this.onControl = onControl;
    this.timer = setInterval(() => { const c = readAndClearControl(this.dataDir); if (c) this.onControl(c); }, 2000);
    this.timer.unref();
    if (process.platform !== "win32") {
      process.on("SIGUSR1", () => this.onControl({ command: "pause", minutes: 60 }));
      process.on("SIGUSR2", () => this.onControl({ command: "resume" }));
    }
  }
  render(s: StatusSnapshot) {
    try { writeFileSync(statusPath(this.dataDir), JSON.stringify({ ...s, at: new Date().toISOString() })); } catch { /* status file is best-effort */ }
    if (this.quiet) return;
    const line = `[bridgebox-collector] ${s.state}${s.pausedUntil ? ` until ${s.pausedUntil}` : ""} | source=${s.source} queued=${s.queued} sent=${s.sent}${s.lastError ? ` | last error: ${s.lastError}` : ""}`;
    if (line !== this.last) { console.log(line); this.last = line; }
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}

export function readStatus(dataDir: string): (StatusSnapshot & { at: string }) | null {
  const p = statusPath(dataDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
