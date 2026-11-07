/**
 * Runs at the end of `npm run build` on the deploy platform (Vercel/Docker). Idempotent.
 * Applies migrations + RLS; seeds the synthetic demo once when BOOTSTRAP_SEED_DEMO=1 (or on Vercel production
 * when the database has no organizations yet). Skips silently when DATABASE_URL is absent (CI build-only runs).
 */
import "dotenv/config";
async function main() {
  if (!process.env.DATABASE_URL) { console.log("[bootstrap] DATABASE_URL not set — skipping"); return; }
  if (process.env.SKIP_BOOTSTRAP === "1") { console.log("[bootstrap] SKIP_BOOTSTRAP=1 — skipping"); return; }
  const { runMigrations } = await import("../src/engine/migrate");
  const r = await runMigrations({ log: (m) => console.log("[bootstrap]", m) });
  const wantSeed = process.env.BOOTSTRAP_SEED_DEMO === "1" || (process.env.VERCEL_ENV === "production" && process.env.BOOTSTRAP_SEED_DEMO !== "0");
  if (wantSeed) {
    const { seedDemo } = await import("../src/engine/seed");
    const s = await seedDemo({ log: (m) => console.log("[bootstrap]", m.split("\n")[0]) });
    console.log("[bootstrap] seed:", s.skipped ? "already seeded" : `${s.events} events`);
  }
  console.log("[bootstrap] done", JSON.stringify({ applied: r.applied }));
  process.exit(0);
}
main().catch((e) => { console.error("[bootstrap] FAILED", e); process.exit(1); });
