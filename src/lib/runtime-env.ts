/**
 * Runtime-environment policy shared by the app, the build bootstrap and scripts (no `server-only`: scripts import it).
 * "Production" is any Vercel production deployment or any process started with NODE_ENV=production (`next start`,
 * the Docker image). Local `next start` therefore counts as production: e2e/CI opt back in with ALLOW_DEMO_LOGINS=1.
 */
type Env = Record<string, string | undefined>;

export const DEFAULT_DEMO_PASSWORD = "Demo!Pass123";
export const MIN_PRODUCTION_SEED_PASSWORD = 16;

export function isProductionRuntime(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
}

/** Demo (`*.demo` / demo-org-only) accounts may sign in outside production, or in production only with ALLOW_DEMO_LOGINS=1. */
export function demoLoginsAllowed(env: Env = process.env): boolean {
  return !isProductionRuntime(env) || env.ALLOW_DEMO_LOGINS === "1";
}

export const isDemoEmail = (email: string) => /\.demo$/i.test(email.trim());

/**
 * A demo account: its email ends in `.demo`, or it has at least one membership and every one of them is in an
 * `is_demo` organization. The platform owner (member of the real consultancy + demo clients) is NOT a demo account.
 */
export function isDemoAccount(email: string, memberships: { isDemo: boolean }[]): boolean {
  if (isDemoEmail(email)) return true;
  return memberships.length > 0 && memberships.every((m) => m.isDemo);
}

/** The build-time bootstrap seeds the synthetic demo only when explicitly asked (SEC-001: never by default). */
export function shouldSeedOnBuild(env: Env = process.env): boolean {
  return env.BOOTSTRAP_SEED_DEMO === "1";
}
