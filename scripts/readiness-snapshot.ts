/**
 * READ-ONLY: print the Production Readiness Command Center's computed status (live checks + evidence + findings)
 * from the terminal — same code as /admin/readiness. Usage: DATABASE_URL=... OWNER_EMAIL=... npx tsx scripts/readiness-snapshot.ts
 */
import "dotenv/config";
import { runLiveChecks, loadEvidence, loadFindings } from "../src/engine/readiness/live";
import { computeReadiness } from "../src/engine/readiness/gates";

async function main() {
  const live = await runLiveChecks({ origin: process.env.READINESS_ORIGIN ?? "https://app.bridgebox.ai" });
  const r = computeReadiness(live, await loadEvidence(), await loadFindings()) as unknown as Record<string, unknown>;
  console.log("LIVE:"); for (const c of live) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label} — ${c.detail}`);
  console.log(JSON.stringify(r, (k, v) => (k === "description" || k === "nextAction" ? undefined : v), 1).slice(0, 4000));
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
