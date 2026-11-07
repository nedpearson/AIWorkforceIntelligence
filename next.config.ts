import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pdfkit", "postgres"],
  outputFileTracingIncludes: { "/api/admin/bootstrap": ["./drizzle/**"] },
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
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
