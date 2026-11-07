import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { TOURS, resumeStep, shouldAutoStart, isTourKey } from "@/engine/tours";
import { listTourProgress, saveTourProgress } from "@/engine/tours-store";

let org = ""; let other = ""; let user = "";
beforeAll(async () => {
  const [o] = await db.insert(schema.organizations).values({ name: "Tours", slug: `tours-${Date.now()}` }).returning(); org = o.id;
  const [o2] = await db.insert(schema.organizations).values({ name: "Tours 2", slug: `tours2-${Date.now()}` }).returning(); other = o2.id;
  const [u] = await db.insert(schema.users).values({ email: `tours-${Date.now()}@t.test` }).returning(); user = u.id;
});
afterAll(async () => { for (const id of [org, other]) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)); await db.delete(schema.users).where(eq(schema.users.id, user)); });

describe("guided tours", () => {
  it("definitions target data-testids and the four tours exist", () => {
    expect(Object.keys(TOURS).sort()).toEqual(["brain", "first-run", "meet-ai-team", "savings"]);
    for (const t of Object.values(TOURS)) for (const s of t.steps) expect(s.target).toMatch(/^[a-z0-9-]+$/);
    expect(isTourKey("nope")).toBe(false);
  });
  it("pause/resume/complete/replay persist per user and org", async () => {
    expect(shouldAutoStart(await listTourProgress(org, user))).toBe(true);
    await saveTourProgress(org, user, "first-run", { step: 2 });
    let p = await listTourProgress(org, user);
    expect(p).toHaveLength(1); expect(resumeStep(TOURS["first-run"], p[0])).toBe(2); expect(shouldAutoStart(p)).toBe(false);
    await saveTourProgress(org, user, "first-run", { step: 99 }); // clamped
    expect((await listTourProgress(org, user))[0].step).toBe(TOURS["first-run"].steps.length - 1);
    await saveTourProgress(org, user, "first-run", { step: 4, completed: true });
    p = await listTourProgress(org, user); expect(p[0].completedAt).toBeTruthy(); expect(resumeStep(TOURS["first-run"], p[0])).toBeNull();
    await saveTourProgress(org, user, "first-run", { step: 3, reset: true });
    p = await listTourProgress(org, user); expect(p[0]).toMatchObject({ step: 0, completedAt: null });
    expect(await listTourProgress(other, user)).toHaveLength(0); // tenant-scoped
    await expect(saveTourProgress(org, user, "bogus", { step: 0 })).rejects.toThrow(/unknown tour/);
  });
});
