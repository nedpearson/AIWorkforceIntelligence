/**
 * Performance baseline (NOT part of the default e2e/unit runs).
 *
 *   npx tsx tests/perf/perf.ts                        # 2,000 employees × 10 workdays (defaults)
 *   PERF_EMPLOYEES=500 PERF_DAYS=5 npx tsx tests/perf/perf.ts
 *   PERF_KEEP=1 …                                     # keep the synthetic org afterwards (default: deleted)
 *
 * Needs the production server running on PERF_BASE_URL (default http://localhost:3000) against the same DATABASE_URL.
 * Steps
 *   1. creates a synthetic perf org (is_demo) with N employees cycled from the demo templates, consent, an org-wide
 *      running campaign, one active collector per employee (fresh bearer tokens) and an owner login;
 *   2. generates events per employee with src/engine/synthetic.ts and ships them through POST /api/collect/events in
 *      batches of ≤ 5,000 (the protocol maximum) with PERF_CONCURRENCY parallel senders → events/sec;
 *   3. times runAnalysis() for the org;
 *   4. logs in through the real form and measures server-render latency of /app, /app/opportunities,
 *      /app/process-mining, /app/savings: 20 sequential requests (p50/p95/max) + 5 concurrent (p50/max);
 *   5. writes tests/perf/results.json and deletes the org (events included) unless PERF_KEEP=1.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { chromium } from "@playwright/test";
import { db, pg, schema } from "@/db/client";
import { DEMO_ORG, generateEvents, type SynthEmployee } from "@/engine/synthetic";
import { runAnalysis } from "@/engine/analysis";
import { ensureDefaultFinancialModel } from "@/engine/finance";
import { sha256, randomToken } from "@/lib/crypto";
import { DEFAULT_NOTICE_VERSION, MAX_EVENTS_PER_BATCH } from "@/collector-protocol/schema";

const N = Number(process.env.PERF_EMPLOYEES ?? 2000);
const DAYS = Number(process.env.PERF_DAYS ?? 10);
const CONC = Number(process.env.PERF_CONCURRENCY ?? 4);
const BASE = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const KEEP = process.env.PERF_KEEP === "1";
const PASSWORD = "Perf!Pass-" + randomToken().slice(0, 8);
const tag = Date.now().toString(36);
const log = (...a: unknown[]) => console.log(`[perf ${new Date().toISOString().slice(11, 19)}]`, ...a);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
const round = (n: number) => Math.round(n * 10) / 10;

async function main() {
  const t0 = Date.now();
  const results: Record<string, unknown> = {
    startedAt: new Date().toISOString(), employees: N, workdays: DAYS, concurrency: CONC, baseUrl: BASE,
    host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGB: round(os.totalmem() / 2 ** 30), node: process.version, platform: `${os.type()} ${os.release()}` },
  };

  // ---------- 1. org scaffold ----------
  const [org] = await db.insert(schema.organizations).values({ name: `Perf Synthetic ${tag}`, slug: `perf-${tag}`, kind: "client", industry: "Synthetic perf", isDemo: true, timezone: "UTC", settings: { benefitsLoadPct: 0.3, workHoursPerWeek: 40, workWeeksPerYear: 48, adoptionRate: 0.75, realizationRate: 0.6 } }).returning();
  const orgId = org.id;
  log(`org ${orgId} (${N} employees × ${DAYS} workdays)`);
  try {
    const email = `perf-${tag}@perf.invalid`;
    const [user] = await db.insert(schema.users).values({ email, name: "Perf Owner", passwordHash: await bcrypt.hash(PASSWORD, 10), emailVerified: new Date() }).returning();
    await db.insert(schema.memberships).values({ userId: user.id, orgId, role: "owner" });
    await db.insert(schema.subscriptions).values({ orgId, plan: "enterprise", status: "active", seats: N, agentSlots: 50 });
    await db.insert(schema.authorizations).values({ orgId, signedByUserId: user.id, signerName: "Perf Owner", signerTitle: "CEO", scope: "perf", documentText: "Synthetic performance test authorization." });
    const deptIds: Record<string, string> = {};
    for (const name of DEMO_ORG.departments) { const [d] = await db.insert(schema.departments).values({ orgId, name }).returning(); deptIds[name] = d.id; }

    const templates = DEMO_ORG.employees;
    const emps: (SynthEmployee & { id?: string; collectorId?: string; token?: string })[] = Array.from({ length: N }, (_, i) => {
      const t = templates[i % templates.length];
      return { key: `p${i}`, name: `${t.name} #${i}`, title: t.title, department: t.department, baseAnnualCost: t.baseAnnualCost, patterns: t.patterns };
    });
    const CH = 500;
    for (let i = 0; i < emps.length; i += CH) {
      const slice = emps.slice(i, i + CH);
      const rows = await db.insert(schema.employees).values(slice.map((e) => ({ orgId, departmentId: deptIds[e.department], displayName: e.name, title: e.title, email: `${e.key}-${tag}@perf.invalid`, baseAnnualCost: String(e.baseAnnualCost), loadedHourlyCost: ((e.baseAnnualCost * 1.3) / (40 * 48)).toFixed(2), costBasis: "observed" as const, hoursPerWeek: "40" }))).returning({ id: schema.employees.id });
      rows.forEach((r, j) => { slice[j].id = r.id; });
      await db.insert(schema.consentRecords).values(slice.map((e) => ({ orgId, employeeId: e.id!, noticeVersion: DEFAULT_NOTICE_VERSION, noticeText: "Synthetic perf notice", acknowledgedAt: new Date(Date.now() - 40 * 86400000), method: "collector_ui" as const })));
      for (const e of slice) e.token = randomToken();
      const cs = await db.insert(schema.collectors).values(slice.map((e) => ({ orgId, employeeId: e.id!, name: `${e.key} workstation`, platform: "simulated" as const, tokenHash: sha256(e.token!), status: "active" as const, version: "perf", config: { titleMode: "hash" as const } }))).returning({ id: schema.collectors.id });
      cs.forEach((c, j) => { slice[j].collectorId = c.id; });
    }
    const [campaign] = await db.insert(schema.observationCampaigns).values({ orgId, name: `Perf campaign ${tag}`, status: "running", startsAt: new Date(Date.now() - 40 * 86400000), endsAt: new Date(Date.now() + 86400000), departmentIds: [], employeeIds: [], createdBy: user.id }).returning();
    await ensureDefaultFinancialModel(orgId);
    log(`scaffold ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ---------- 2. ingestion over HTTP ----------
    let sent = 0, accepted = 0, batches = 0; const batchMs: number[] = []; const dropped: Record<string, number> = {};
    let next = 0; let genMs = 0;
    const start = new Date(Date.now() - 86400000);
    const tIngest = Date.now();
    async function worker() {
      while (next < emps.length) {
        const i = next++; const e = emps[i];
        const g0 = Date.now();
        const evs = generateEvents({ seed: 1000 + i, days: DAYS, start, employees: [e] });
        genMs += Date.now() - g0;
        for (let k = 0; k < evs.length; k += MAX_EVENTS_PER_BATCH) {
          const chunk = evs.slice(k, k + MAX_EVENTS_PER_BATCH).map((v) => ({ ts: v.ts.toISOString(), type: v.type, app: v.app, appCategory: v.appCategory || undefined, titleCategory: v.titleCategory || undefined, titleHash: v.titleHash || undefined, durationMs: v.durationMs, meta: v.meta }));
          const b0 = performance.now();
          const res = await fetch(`${BASE}/api/collect/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${e.token}` }, body: JSON.stringify({ collectorId: e.collectorId, events: chunk }) });
          batchMs.push(performance.now() - b0);
          if (!res.ok) throw new Error(`batch ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const j = (await res.json()) as { accepted: number; dropped: number; reasons: Record<string, number> };
          sent += chunk.length; accepted += j.accepted; batches++;
          for (const [r, n] of Object.entries(j.reasons)) dropped[r] = (dropped[r] ?? 0) + n;
        }
        if ((i + 1) % 200 === 0) log(`ingested ${i + 1}/${N} employees · ${accepted.toLocaleString()} events · ${Math.round(accepted / ((Date.now() - tIngest) / 1000))} ev/s`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    const ingestSec = (Date.now() - tIngest) / 1000;
    results.ingestion = { eventsSent: sent, eventsAccepted: accepted, dropped, batches, seconds: round(ingestSec), eventsPerSec: Math.round(accepted / ingestSec), eventsPerSecExclGeneration: Math.round(accepted / Math.max(0.001, ingestSec - genMs / 1000 / CONC)), batchLatencyMs: { p50: Math.round(pct(batchMs, 50)), p95: Math.round(pct(batchMs, 95)), max: Math.round(Math.max(...batchMs)) } };
    log("ingestion", JSON.stringify(results.ingestion));
    const [{ n: stored }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, orgId));
    results.eventsStored = stored;

    // ---------- 3. analysis ----------
    const mem0 = process.memoryUsage().rss;
    const a0 = Date.now();
    const run = await runAnalysis({ orgId, campaignId: campaign.id });
    results.analysis = { seconds: round((Date.now() - a0) / 1000), ...run, rssDeltaMB: Math.round((process.memoryUsage().rss - mem0) / 2 ** 20), peakRssMB: Math.round(process.memoryUsage().rss / 2 ** 20) };
    log("analysis", JSON.stringify(results.analysis));

    // ---------- 4. server-render latency ----------
    const browser = await chromium.launch({ args: ["--renderer-process-limit=1"] });
    try {
      const ctx = await browser.newContext({ baseURL: BASE });
      const page = await ctx.newPage();
      await page.goto(`/login?next=%2Fapp`);
      await page.getByTestId("login-email").fill(email);
      await page.getByTestId("login-password").fill(PASSWORD);
      await page.getByTestId("login-submit").click();
      await page.waitForURL((u) => u.pathname === "/app", { timeout: 90_000 });
      await page.close();
      const latency: Record<string, unknown> = {};
      for (const route of ["/app", "/app/opportunities", "/app/process-mining", "/app/savings"]) {
        const w0 = performance.now();
        const warm = await ctx.request.get(route, { timeout: 180_000 }); await warm.body(); // first render, reported separately
        const firstMs = Math.round(performance.now() - w0);
        if (warm.status() !== 200) throw new Error(`${route} → ${warm.status()}`);
        const seq: number[] = [];
        for (let i = 0; i < 20; i++) { const s = performance.now(); const r = await ctx.request.get(route, { timeout: 180_000 }); await r.body(); if (r.status() !== 200) throw new Error(`${route} → ${r.status()}`); seq.push(performance.now() - s); }
        const conc = await Promise.all(Array.from({ length: 5 }, async () => { const s = performance.now(); const r = await ctx.request.get(route, { timeout: 180_000 }); await r.body(); return { ms: performance.now() - s, status: r.status() }; }));
        latency[route] = { firstRequest: firstMs, sequential20: { p50: Math.round(pct(seq, 50)), p95: Math.round(pct(seq, 95)), max: Math.round(Math.max(...seq)) }, concurrent5: { p50: Math.round(pct(conc.map((c) => c.ms), 50)), max: Math.round(Math.max(...conc.map((c) => c.ms))), statuses: [...new Set(conc.map((c) => c.status))] } };
        log(route, JSON.stringify(latency[route]));
      }
      results.latencyMs = latency;
    } finally { await browser.close(); }
  } finally {
    if (!KEEP) {
      const c0 = Date.now();
      await db.delete(schema.activityEvents).where(eq(schema.activityEvents.orgId, orgId));
      await pg`delete from audit_log where org_id = ${orgId}`;
      await pg`delete from jobs where org_id = ${orgId}`.catch(() => {});
      const users = await pg<{ user_id: string }[]>`select user_id from memberships where org_id = ${orgId}`;
      await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      for (const u of users) await pg`delete from users where id = ${u.user_id} and not exists (select 1 from memberships m where m.user_id = ${u.user_id})`;
      const [{ n }] = await pg<{ n: number }[]>`select count(*)::int n from activity_events where org_id = ${orgId}`;
      results.cleanup = { seconds: round((Date.now() - c0) / 1000), remainingEvents: n };
      log("cleanup", JSON.stringify(results.cleanup));
    }
    results.totalSeconds = round((Date.now() - t0) / 1000);
    const out = path.join(__dirname, `results-${N}x${DAYS}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    log("wrote", out);
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
