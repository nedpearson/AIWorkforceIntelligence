/**
 * Content-Security-Policy builder (used by src/middleware.ts on every page request).
 * Nonce-based: Next.js reads the nonce from the request's CSP header and stamps it on its own <script> tags; the root
 * layout passes the same nonce (`x-nonce`) to the inline theme script. 'strict-dynamic' lets those nonce'd scripts
 * load the app's chunks. Styles keep 'unsafe-inline' (React style attributes, Recharts) — scripts never do.
 * Images allow https: so a client's branding logo URL keeps working. Pure/Edge-safe: no Node APIs.
 */
export const CSP_HEADER = "Content-Security-Policy";

export function buildCsp(nonce: string, opts: { dev?: boolean; https?: boolean } = {}): string {
  const d: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", "'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(opts.dev ? ["'unsafe-eval'"] : [])],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:", "https:"],
    ["font-src", "'self'", "data:"],
    ["connect-src", "'self'", ...(opts.dev ? ["ws:"] : [])],
    ["media-src", "'self'", "blob:", "data:"],
    ["worker-src", "'self'", "blob:"],
    ["frame-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  if (opts.https) d.push(["upgrade-insecure-requests"]);
  return d.map((x) => x.join(" ")).join("; ");
}

/** 128-bit random nonce, base64. Works in the Edge runtime and Node. */
export function makeNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
