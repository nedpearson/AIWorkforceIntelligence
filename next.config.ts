import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pdfkit", "postgres"],
  outputFileTracingIncludes: { "/api/admin/bootstrap": ["./drizzle/**"], "/admin/readiness": ["./drizzle/**"] },
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  // Content-Security-Policy (nonce) and HSTS are set per request in src/middleware.ts.
  headers: async () => [{
    source: "/(.*)",
    headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
    ],
  }],
};
export default nextConfig;
