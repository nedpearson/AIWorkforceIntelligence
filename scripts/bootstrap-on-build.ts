/**
 * Runs at the end of `npm run build` on the deploy platform (Vercel/Docker). Idempotent.
 * Applies migrations + RLS; seeds the synthetic demo ONLY when BOOTSTRAP_SEED_DEMO=1 is set explicitly (SEC-001: a
 * production build used to seed by default with the README password). Skips silently when DATABASE_URL is absent.
 */
import "dotenv/config";
async function main() {
  if (!process.env.DATABASE_URL) { console.log("[bootstrap] DATABASE_URL not set — skipping"); return; }
  if (process.env.SKIP_BOOTSTRAP === "1") { console.log("[bootstrap] SKIP_BOOTSTRAP=1 — skipping"); return; }
  const { runMigrations } = await import("../src/engine/migrate");
  const r = await runMigrations({ log: (m) => console.log("[bootstrap]", m) });
  const { shouldSeedOnBuild } = await import("../src/lib/runtime-env");
  if (shouldSeedOnBuild()) {
    const { seedDemo } = await import("../src/engine/seed");
    const s = await seedDemo({ log: (m) => console.log("[bootstrap]", m.split("\n")[0]) });
    console.log("[bootstrap] seed:", s.skipped ? "already seeded" : `${s.events} events`);
  }
  {
    const { backfillPersonaPortraits } = await import("../src/engine/workforce/core");
    const { db } = await import("../src/db/client");
    const n = await backfillPersonaPortraits(db as never);
    if (n) console.log(`[bootstrap] portraits: ${n} AI employee(s) given their AI-generated library portrait`);
  }
  if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD_HASH) {
    const { ensurePlatformOwner } = await import("../src/engine/owner");
    await ensurePlatformOwner({ email: process.env.OWNER_EMAIL, passwordHash: process.env.OWNER_PASSWORD_HASH, log: (m) => console.log("[bootstrap]", m) });
  }
  console.log("[bootstrap] done", JSON.stringify({ applied: r.applied }));
  process.exit(0);
}
main().catch((e) => { console.error("[bootstrap] FAILED", e); process.exit(1); });
