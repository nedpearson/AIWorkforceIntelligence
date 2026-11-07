/** /api/health public vs detailed response (SEC-002). */
import { describe, it, expect, afterAll } from "vitest";
import { pg } from "@/db/client";
import { GET } from "@/app/api/health/route";

afterAll(async () => { await pg.end({ timeout: 5 }); });
describe("/api/health", () => {
  it("public: only { ok, version } — no env flags, no org count", async () => {
    const r = await GET(new Request("http://t.local/api/health"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Object.keys(j).sort()).toEqual(["ok", "version"]);
    expect(j.ok).toBe(true);
  });
  it("wrong bearer: still public", async () => {
    process.env.CRON_SECRET = "health-test-secret";
    const j = await (await GET(new Request("http://t.local/api/health", { headers: { authorization: "Bearer nope" } }))).json();
    expect(Object.keys(j).sort()).toEqual(["ok", "version"]);
  });
  it("Authorization: Bearer $CRON_SECRET: detailed (names/booleans only, never values)", async () => {
    process.env.CRON_SECRET = "health-test-secret";
    const j = await (await GET(new Request("http://t.local/api/health", { headers: { authorization: "Bearer health-test-secret" } }))).json();
    expect(j.env).toMatchObject({ DATABASE_URL: true, CRON_SECRET: true });
    expect(typeof j.database.orgs).toBe("number");
    expect(JSON.stringify(j)).not.toContain("health-test-secret");
    expect(JSON.stringify(j)).not.toContain(process.env.DATABASE_URL!);
  });
});
