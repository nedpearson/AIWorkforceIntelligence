/** CSP builder + middleware (SEC-005). */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { buildCsp, makeNonce } from "@/lib/csp";
import { middleware } from "@/middleware";

describe("buildCsp", () => {
  it("is nonce-based with strict-dynamic, no unsafe-inline/unsafe-eval for scripts in production", () => {
    const c = buildCsp("abc123");
    const script = c.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(c).toContain("default-src 'self'");
    expect(c).toContain("object-src 'none'");
    expect(c).toContain("frame-ancestors 'none'");
    expect(c).toContain("base-uri 'self'");
    expect(c).not.toContain("upgrade-insecure-requests");
    expect(buildCsp("n", { https: true })).toContain("upgrade-insecure-requests");
    expect(buildCsp("n", { dev: true })).toContain("'unsafe-eval'");
  });
  it("nonces are random 128-bit base64", () => {
    const a = makeNonce(), b = makeNonce();
    expect(a).not.toBe(b); expect(Buffer.from(a, "base64").length).toBe(16);
  });
});

describe("middleware", () => {
  it("sets CSP on the response and forwards nonce + path to the server; HSTS only over https", () => {
    const res = middleware(new NextRequest("http://localhost:3000/login"));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    expect(csp).toContain(`'nonce-${res.headers.get("x-middleware-request-x-nonce")}'`);
    expect(res.headers.get("x-middleware-request-x-bb-path")).toBe("/login");
    expect(res.headers.get("strict-transport-security")).toBeNull();
    const https = middleware(new NextRequest("https://app.example.com/login", { headers: { "x-forwarded-proto": "https" } }));
    expect(https.headers.get("strict-transport-security")).toContain("max-age=");
  });
  it("still redirects cookie-less /app and /admin requests to /login", () => {
    const res = middleware(new NextRequest("http://localhost:3000/admin/readiness"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?next=%2Fadmin%2Freadiness");
  });
});
