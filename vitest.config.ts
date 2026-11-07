import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";
import path from "node:path";

// Load .env, but let an explicitly exported DATABASE_URL win (tests run against their own DB, never the seeded default).
const explicitDbUrl = process.env.DATABASE_URL;
loadEnv();
if (explicitDbUrl) process.env.DATABASE_URL = explicitDbUrl;

export default defineConfig({
  test: { environment: "node", include: ["tests/unit/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: path.resolve(__dirname, "tests/unit/_server-only-stub.ts") },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
});
