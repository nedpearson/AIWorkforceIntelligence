import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, makeNonce, CSP_HEADER } from "@/lib/csp";
/**
 * 1. Content-Security-Policy with a fresh nonce on every page request (src/lib/csp.ts); the nonce is forwarded as
 *    `x-nonce` for the root layout's inline theme script, and the CSP request header lets Next.js nonce its scripts.
 * 2. `x-bb-path` request header: the pathname, for server layouts (MFA enrolment gate, readiness 404).
 * 3. UX gate: unauthenticated users hitting /app, /admin or /present are redirected to /login.
 *    Real authorization happens server-side in requireCtx(); this is not a security boundary.
 * HSTS is added when the request arrived over HTTPS (Vercel / a TLS proxy sets x-forwarded-proto).
 */
export function middleware(req: NextRequest) {
  const p = req.nextUrl.pathname;
  const hasSession = req.cookies.getAll().some((c) => c.name.includes("authjs.session-token"));
  if ((p.startsWith("/app") || p.startsWith("/admin") || p.startsWith("/present")) && !hasSession) {
    const url = req.nextUrl.clone(); url.pathname = "/login"; url.searchParams.set("next", p);
    return NextResponse.redirect(url);
  }
  const https = req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:";
  const nonce = makeNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production", https });
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("x-bb-path", p);
  headers.set(CSP_HEADER, csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set(CSP_HEADER, csp);
  if (https) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return res;
}
// Every page; not API routes (JSON), Next static assets or files with an extension.
export const config = { matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)"] };
