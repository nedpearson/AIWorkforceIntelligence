/**
 * Record release-gate evidence for the Production Readiness Command Center (/admin/readiness).
 *   npm run readiness:record -- --gate e2e --status pass --command "npx playwright test" --evidence "65 passed" [--environment local-ci-equivalent] [--commit <sha>] [--by <name>]
 *   npm run readiness:record -- --sync-findings      upsert src/engine/readiness/findings.ts into security_findings
 *   npm run readiness:record -- --list               print recorded evidence
 * Writes to the database in DATABASE_URL. Never record a gate you did not verify in the stated environment.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { db, schema, pg } from "../src/db/client";
import { GATE_KEYS } from "../src/engine/readiness/gates";
import { FINDINGS } from "../src/engine/readiness/findings";

function args(argv: string[]) {
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; } }
  return o;
}
const git = (c: string) => { try { return execSync(`git ${c}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };

async function main() {
  const a = args(process.argv.slice(2));
  if (a["sync-findings"]) {
    for (const f of FINDINGS) {
      await db.insert(schema.securityFindings).values({ ...f, updatedAt: new Date() }).onConflictDoUpdate({ target: schema.securityFindings.id, set: { title: f.title, severity: f.severity, status: f.status, component: f.component, summary: f.summary, fix: f.fix, evidence: f.evidence, owner: f.owner, nextAction: f.nextAction, updatedAt: new Date() } });
    }
    console.log(`synced ${FINDINGS.length} findings`);
  }
  if (a.list) {
    const rows = await db.select().from(schema.readinessEvidence).orderBy(sql`recorded_at desc`);
    for (const r of rows) console.log(`${r.recordedAt.toISOString()} ${r.gate.padEnd(24)} ${r.status.padEnd(7)} ${r.environment} ${r.commitSha.slice(0, 7)} ${r.recordedBy} :: ${r.command} :: ${r.evidence}`);
  }
  if (a.gate) {
    const gate = String(a.gate); const status = String(a.status ?? "");
    if (!GATE_KEYS.includes(gate)) throw new Error(`unknown gate "${gate}". Gates: ${GATE_KEYS.join(", ")}`);
    if (!["pass", "fail", "blocked"].includes(status)) throw new Error("--status must be pass | fail | blocked");
    const command = typeof a.command === "string" ? a.command : ""; const evidence = typeof a.evidence === "string" ? a.evidence : "";
    if (!command || !evidence) throw new Error("--command and --evidence are required (what you ran, and what it showed)");
    const commitSha = typeof a.commit === "string" ? a.commit : git("rev-parse HEAD") || "unknown";
    const recordedBy = typeof a.by === "string" ? a.by : git("config user.email") || process.env.USER || "unknown";
    const environment = typeof a.environment === "string" ? a.environment : "local";
    const [row] = await db.insert(schema.readinessEvidence).values({ gate, status: status as "pass" | "fail" | "blocked", commitSha, command, environment, evidence, recordedBy }).returning();
    console.log(`recorded ${row.gate}=${row.status} (${row.environment} @ ${row.commitSha.slice(0, 7)}) id=${row.id}`);
  }
  if (!a["sync-findings"] && !a.list && !a.gate) console.log("nothing to do: pass --gate/--status/--command/--evidence, --sync-findings or --list");
  await pg.end({ timeout: 5 });
}
main().catch(async (e) => { console.error(e instanceof Error ? e.message : e); await pg.end({ timeout: 5 }).catch(() => {}); process.exit(1); });
