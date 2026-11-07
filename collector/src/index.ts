#!/usr/bin/env node
/**
 * BridgeBox desktop activity collector (Windows + macOS; Linux for --simulate / CI).
 *
 * PRIVACY GUARANTEES (enforced in code, not policy):
 *   - Never captures keystrokes, clipboard contents, screenshots, URLs, file names, window titles,
 *     or message/email content. There are no input hooks in this program and no dependency that
 *     installs one.
 *   - The only per-sample inputs are the foreground process identity and the window title string;
 *     the title is reduced in-process to a coarse category ("invoice", "report", ...) and a salted,
 *     non-reversible hash before anything is queued. Raw titles are never written to disk or sent.
 *   - Apps on the blocked list (password managers, banking, health, personal messaging, plus
 *     whatever the org configures) are never sampled at all.
 *   - Collection only happens inside the org's observation schedule, only after the employee has
 *     seen and accepted the notice, and the employee can pause at any time (`pause` command).
 *
 * Usage:
 *   bridgebox-collector                       run (enrolls on first run using env/flags below)
 *   bridgebox-collector --accept-notice       accept the notice non-interactively (for managed installs)
 *   bridgebox-collector --simulate [file]     synthetic foreground (or replay a JSON events file)
 *   bridgebox-collector pause [minutes]       ask the running collector to pause (default 60)
 *   bridgebox-collector resume
 *   bridgebox-collector status
 * Env:  BRIDGEBOX_URL, BRIDGEBOX_ENROLL_CODE, BRIDGEBOX_DATA_DIR, BRIDGEBOX_QUIET=1
 * Flags: --url <u> --enroll-code <c> --data-dir <d> --once (one batch then exit; used by tests)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, platform as osPlatform } from "node:os";
import { createInterface } from "node:readline";
import { EnrollResponse, ConfigResponse, EventBatchResponse, WireEvent, MAX_EVENTS_PER_BATCH, DEFAULT_BLOCKED_APPS, type CollectorConfig } from "../../src/collector-protocol/schema";
import { inSchedule } from "../../src/collector-protocol/schedule";
import { DiskQueue, Backoff } from "./queue";
import { Sampler, RealForeground, SimulatedForeground, type ForegroundSource } from "./sampler";
import { newSalt } from "./normalize";
import { Tray, writeControl, readStatus, type Control } from "./tray";

export const VERSION = "0.1.0";

type State = { url: string; collectorId: string; token: string; salt: string; noticeVersionAccepted?: string; config: CollectorConfig; platform: "windows" | "macos" | "linux" | "simulated" };

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
const quiet = !!process.env.BRIDGEBOX_QUIET || flag("--quiet");
const log = (...a: unknown[]) => { if (!quiet) console.log("[bridgebox-collector]", ...a); };

export function defaultDataDir(): string {
  if (process.env.BRIDGEBOX_DATA_DIR) return process.env.BRIDGEBOX_DATA_DIR;
  const p = osPlatform();
  if (p === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "BridgeBoxCollector");
  if (p === "darwin") return join(homedir(), "Library", "Application Support", "BridgeBoxCollector");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "bridgebox-collector");
}
const dataDir = opt("--data-dir") ?? defaultDataDir();
mkdirSync(dataDir, { recursive: true });
const statePath = join(dataDir, "collector.json");
const loadState = (): State | null => (existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : null);
const saveState = (s: State) => writeFileSync(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });

function detectPlatform(simulate: boolean): State["platform"] {
  if (simulate) return "simulated";
  const p = osPlatform();
  return p === "win32" ? "windows" : p === "darwin" ? "macos" : "linux";
}

// ---------- HTTP ----------
async function api<T>(url: string, path: string, init: RequestInit & { token?: string }, parse?: { parse: (x: unknown) => T }): Promise<{ ok: true; data: T; status: number } | { ok: false; status: number; error: string; body?: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": `bridgebox-collector/${VERSION}`, ...(init.headers as Record<string, string> ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let res: Response;
  try { res = await fetch(new URL(path, url), { ...init, headers }); } catch (e) { return { ok: false, status: 0, error: `network: ${e instanceof Error ? e.message : String(e)}` }; }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) return { ok: false, status: res.status, error: (body as { error?: string })?.error ?? `http_${res.status}`, body };
  try { return { ok: true, status: res.status, data: parse ? parse.parse(body) : (body as T) }; } catch (e) { return { ok: false, status: res.status, error: `bad_response: ${e instanceof Error ? e.message : String(e)}` }; }
}

async function askYesNo(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(`${q} [y/N] `, (a) => { rl.close(); r(/^y(es)?$/i.test(a.trim())); }));
}

// ---------- enrollment + notice ----------
async function enroll(simulate: boolean): Promise<State> {
  const url = opt("--url") ?? process.env.BRIDGEBOX_URL;
  const code = opt("--enroll-code") ?? process.env.BRIDGEBOX_ENROLL_CODE;
  if (!url || !code) { console.error("Not enrolled. Set BRIDGEBOX_URL and BRIDGEBOX_ENROLL_CODE (or --url/--enroll-code)."); process.exit(2); }
  const platform = detectPlatform(simulate);
  const r = await api(url, "/api/collect/enroll", { method: "POST", body: JSON.stringify({ enrollmentCode: code, platform, hostname: hostname(), version: VERSION }) }, EnrollResponse);
  if (!r.ok) { console.error(`Enrollment failed: ${r.error} (http ${r.status})`); process.exit(3); }
  const s: State = { url, collectorId: r.data.collectorId, token: r.data.token, salt: newSalt(), config: r.data.config, platform };
  saveState(s);
  log(`enrolled as collector ${s.collectorId}`);
  await ensureNotice(s, r.data.notice);
  return s;
}

async function ensureNotice(s: State, notice: { version: string; text: string }) {
  if (s.noticeVersionAccepted === notice.version) return;
  console.log("\n================ EMPLOYEE NOTICE (version " + notice.version + ") ================\n" + notice.text + "\n=====================================================================\n");
  let accepted = flag("--accept-notice");
  if (!accepted) accepted = await askYesNo("Do you acknowledge this notice and agree to run the collector?");
  if (!accepted) { console.error("Notice not accepted. The collector will not record anything. Re-run with --accept-notice or answer 'y'."); process.exit(4); }
  const r = await api(s.url, "/api/collect/consent", { method: "POST", token: s.token, body: JSON.stringify({ collectorId: s.collectorId, noticeVersion: notice.version }) });
  if (!r.ok) { console.error(`Could not record consent: ${r.error}`); process.exit(5); }
  s.noticeVersionAccepted = notice.version; saveState(s);
  log("consent recorded");
}

// ---------- main loop ----------
async function run() {
  const simulate = flag("--simulate");
  const once = flag("--once");
  let s = loadState() ?? (await enroll(simulate));
  const queue = new DiskQueue(join(dataDir, "queue.jsonl"));
  const backoff = new Backoff();
  const source: ForegroundSource = simulate ? new SimulatedForeground() : new RealForeground();
  const replayFile = simulate && argv[argv.indexOf("--simulate") + 1] && !argv[argv.indexOf("--simulate") + 1].startsWith("-") ? argv[argv.indexOf("--simulate") + 1] : null;

  let cfg = s.config;
  let serverStatus: ConfigResponse["status"] = "active";
  let pausedUntil: number | null = null;
  let consent: ConfigResponse["consent"] = s.noticeVersionAccepted ? "acknowledged" : "missing";
  let campaigns: ConfigResponse["campaigns"] = [];
  let sent = 0, lastFlushAt: string | null = null, lastError: string | null = null;
  const blocked = () => [...new Set([...DEFAULT_BLOCKED_APPS, ...(cfg.blockedApps ?? [])])];
  const sampler = new Sampler({ salt: s.salt, blockedApps: blocked(), idleThresholdSec: cfg.idleThresholdSec ?? 180, titleMode: cfg.titleMode ?? "hash" });
  let stopping = false;

  const tray = new Tray(dataDir, (c: Control) => { void handleControl(c); }, quiet);
  async function handleControl(c: Control) {
    if (c.command === "stop") { stopping = true; return; }
    const body = c.command === "pause" ? { collectorId: s.collectorId, minutes: c.minutes ?? 60 } : { collectorId: s.collectorId, resume: true };
    const r = await api(s.url, "/api/collect/pause", { method: "POST", token: s.token, body: JSON.stringify(body) });
    if (r.ok) { const d = r.data as { pausedUntil: string | null }; pausedUntil = d.pausedUntil ? Date.parse(d.pausedUntil) : null; serverStatus = pausedUntil ? "paused" : "active"; log(c.command === "pause" ? `paused until ${d.pausedUntil}` : "resumed"); }
    else { lastError = `pause/resume failed: ${r.error}`; if (c.command === "pause") pausedUntil = Date.now() + (c.minutes ?? 60) * 60_000; else pausedUntil = null; }
    if (c.command === "pause") queue.push(...sampler.flush());
  }

  async function refreshConfig() {
    const r = await api(s.url, "/api/collect/config", { method: "GET", token: s.token }, ConfigResponse);
    if (!r.ok) { if (r.status === 401) { lastError = "token rejected by server; delete collector.json and re-enroll"; stopping = true; } else if (r.status === 403 && r.error === "collector_revoked") { lastError = "collector revoked by your organization"; stopping = true; } else lastError = `config: ${r.error}`; return; }
    cfg = r.data.config; serverStatus = r.data.status; pausedUntil = r.data.pausedUntil ? Date.parse(r.data.pausedUntil) : null; consent = r.data.consent; campaigns = r.data.campaigns;
    if (serverStatus === "revoked") { lastError = "collector revoked by your organization"; stopping = true; }
    if (r.data.notice.version !== s.noticeVersionAccepted) { await ensureNotice(s, r.data.notice); consent = "acknowledged"; }
    sampler.update({ blockedApps: blocked(), idleThresholdSec: cfg.idleThresholdSec ?? 180, titleMode: cfg.titleMode ?? "hash" });
    s = { ...s, config: cfg }; saveState(s);
    lastError = null;
  }

  const inWindow = (d: Date) => {
    if (!inSchedule(d, cfg.schedule)) return false;
    if (!campaigns.length) return true; // server decides; it will drop if no campaign
    return campaigns.some((c) => (!c.startsAt || d >= new Date(c.startsAt)) && (!c.endsAt || d <= new Date(c.endsAt)) && inSchedule(d, c.schedule));
  };
  const isPaused = () => (pausedUntil != null && pausedUntil > Date.now()) || serverStatus === "paused" && pausedUntil == null;
  const state = (): "running" | "paused" | "outside_schedule" | "consent_missing" => isPaused() ? "paused" : consent !== "acknowledged" ? "consent_missing" : !inWindow(new Date()) ? "outside_schedule" : "running";

  async function flush(): Promise<boolean> {
    if (!queue.size || !backoff.ready) return false;
    const events = queue.peek(MAX_EVENTS_PER_BATCH);
    const r = await api(s.url, "/api/collect/events", { method: "POST", token: s.token, body: JSON.stringify({ collectorId: s.collectorId, events }) }, EventBatchResponse);
    if (!r.ok) {
      if (r.status === 400 || r.status === 413) { queue.ack(events.length); lastError = `server rejected batch (${r.error}); discarded ${events.length} events`; return false; } // malformed: never retry forever
      if (r.status === 401) { lastError = "token rejected; re-enroll"; stopping = true; return false; }
      backoff.fail(); lastError = `upload failed (${r.error}), retry #${backoff.attempts}`; return false;
    }
    queue.ack(events.length); backoff.reset(); sent += r.data.accepted; lastFlushAt = new Date().toISOString(); lastError = null;
    if (r.data.dropped) log(`server dropped ${r.data.dropped}:`, r.data.reasons);
    return true;
  }
  async function heartbeat() {
    const st = state();
    const r = await api(s.url, "/api/collect/heartbeat", { method: "POST", token: s.token, body: JSON.stringify({ collectorId: s.collectorId, version: VERSION, status: st === "running" ? "running" : st === "paused" ? "paused" : "outside_schedule", pausedUntil: pausedUntil ? new Date(pausedUntil).toISOString() : undefined, queueDepth: queue.size }) });
    if (!r.ok) lastError = `heartbeat: ${r.error}`;
  }

  // replay mode: push a JSON events file straight into the queue (schema-validated), flush, exit.
  if (replayFile) {
    const raw = JSON.parse(readFileSync(replayFile, "utf8")) as unknown[];
    const evs = raw.map((e) => WireEvent.parse(e));
    queue.push(...evs);
    log(`queued ${evs.length} replay events`);
  }

  await refreshConfig();
  await heartbeat();
  const sampleMs = simulate ? Math.min(cfg.sampleIntervalMs ?? 2000, 100) : cfg.sampleIntervalMs ?? 2000;
  const batchMs = once ? 500 : cfg.batchIntervalMs ?? 30_000;
  let lastBatch = Date.now(), lastHb = Date.now(), lastCfg = Date.now(), lastRender = 0;
  const sim = simulate as boolean;

  const stop = () => { stopping = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  log(`running (source=${source.name}, sample=${sampleMs}ms, batch=${batchMs}ms, data=${dataDir})`);

  while (!stopping) {
    const now = Date.now();
    const st = state();
    if (st === "running") {
      try {
        const fg = await source.read();
        const idle = source.idleSeconds ? await source.idleSeconds() : null;
        queue.push(...sampler.tick(fg, idle));
      } catch (e) { lastError = e instanceof Error ? e.message : String(e); if (!sim) { console.error(lastError); break; } }
    } else if (sampler) { queue.push(...sampler.flush()); }
    if (now - lastBatch >= batchMs) { lastBatch = now; const ok = await flush(); if (once && (ok || !queue.size)) break; }
    if (now - lastHb >= 60_000) { lastHb = now; await heartbeat(); }
    if (now - lastCfg >= 5 * 60_000) { lastCfg = now; await refreshConfig(); }
    if (now - lastRender >= 2000) { lastRender = now; tray.render({ state: st, pausedUntil: pausedUntil ? new Date(pausedUntil).toISOString() : null, queued: queue.size, sent, lastFlushAt, lastError, source: source.name }); }
    await new Promise((r) => setTimeout(r, st === "running" ? sampleMs : Math.min(5000, sampleMs * 5)));
  }
  // graceful shutdown: close the open segment, try one last flush, tell the server.
  queue.push(...sampler.flush());
  await flush();
  tray.render({ state: "stopping", queued: queue.size, sent, lastFlushAt, lastError, source: source.name });
  await api(s.url, "/api/collect/heartbeat", { method: "POST", token: s.token, body: JSON.stringify({ collectorId: s.collectorId, version: VERSION, status: "stopping", queueDepth: queue.size }) });
  tray.stop();
  log(`stopped. sent=${sent} queued=${queue.size}`);
}

// ---------- CLI sub-commands ----------
async function main() {
  if (command === "pause") { writeControl(dataDir, { command: "pause", minutes: Number(argv[1] ?? 60) }); console.log(`pause requested (${argv[1] ?? 60} min)`); return; }
  if (command === "resume") { writeControl(dataDir, { command: "resume" }); console.log("resume requested"); return; }
  if (command === "stop") { writeControl(dataDir, { command: "stop" }); console.log("stop requested"); return; }
  if (command === "status") { const st = readStatus(dataDir); console.log(st ? JSON.stringify(st, null, 2) : "not running (no status file)"); return; }
  if (command === "version" || flag("--version")) { console.log(VERSION); return; }
  if (command) { console.error(`unknown command ${command}`); process.exit(1); }
  await run();
}
main().catch((e) => { console.error(e); process.exit(1); });
