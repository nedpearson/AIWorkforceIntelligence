/**
 * Disk-backed outbound event queue (JSON lines in the user data dir). Survives restarts and
 * network outages. Bounded: oldest events are discarded past MAX_QUEUED so the file cannot grow
 * unbounded on a machine that is offline for weeks.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WireEvent } from "../../src/collector-protocol/schema";

export const MAX_QUEUED = 200_000;

export class DiskQueue {
  private items: WireEvent[] = [];
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const l of lines) { try { this.items.push(JSON.parse(l)); } catch { /* skip corrupt line */ } }
      if (this.items.length > MAX_QUEUED) { this.items = this.items.slice(-MAX_QUEUED); this.rewrite(); }
    }
  }
  get size() { return this.items.length; }
  push(...evs: WireEvent[]) {
    if (!evs.length) return;
    this.items.push(...evs);
    appendFileSync(this.file, evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (this.items.length > MAX_QUEUED) { this.items = this.items.slice(-MAX_QUEUED); this.rewrite(); }
  }
  /** Oldest `n` events, left in the queue until ack() is called. */
  peek(n: number): WireEvent[] { return this.items.slice(0, n); }
  ack(n: number) { this.items = this.items.slice(n); this.rewrite(); }
  private rewrite() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, this.items.map((e) => JSON.stringify(e)).join("\n") + (this.items.length ? "\n" : ""));
    renameSync(tmp, this.file);
  }
}

/** Exponential backoff helper: 30s, 60s, 120s ... capped at 15 min, with jitter. */
export class Backoff {
  private failures = 0;
  private nextAt = 0;
  constructor(private readonly baseMs = 30_000, private readonly maxMs = 15 * 60_000) {}
  get ready() { return Date.now() >= this.nextAt; }
  get attempts() { return this.failures; }
  fail() { this.failures += 1; const d = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1)); this.nextAt = Date.now() + d + Math.random() * 0.2 * d; }
  reset() { this.failures = 0; this.nextAt = 0; }
}
