/** GET /api/collect/config — effective config, notice, consent state and campaign windows for this collector. */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { ConfigResponse } from "@/collector-protocol/schema";
import { authCollector, json, noticeFromSettings, effectiveConfig, consentState, campaignsForEmployee } from "../_lib";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const c = await authCollector(req, { allowRevoked: true });
  if (c instanceof Response) return c;
  const [org] = await db.select({ settings: schema.organizations.settings, timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, c.orgId)).limit(1);
  const tz = org?.timezone ?? "UTC";
  const campaigns = await campaignsForEmployee(c.orgId, c.employeeId);
  // Collector-level config, with the most restrictive titleMode across campaigns applied.
  const cfg = effectiveConfig(c);
  const rank = { none: 0, category: 1, hash: 2 } as const;
  for (const k of campaigns) { const m = k.config?.titleMode; if (m && rank[m] < rank[cfg.titleMode]) cfg.titleMode = m; }
  if (cfg.schedule && !cfg.schedule.tz) cfg.schedule = { ...cfg.schedule, tz };
  await db.update(schema.collectors).set({ lastSeenAt: new Date() }).where(eq(schema.collectors.id, c.id));
  const res: ConfigResponse = {
    collectorId: c.id, status: c.status, pausedUntil: c.pausedUntil?.toISOString() ?? null, config: cfg, notice: noticeFromSettings(org?.settings),
    consent: await consentState(c.orgId, c.employeeId),
    campaigns: campaigns.map((k) => ({ id: k.id, startsAt: k.startsAt?.toISOString() ?? null, endsAt: k.endsAt?.toISOString() ?? null, schedule: k.config?.schedule ? { ...k.config.schedule, tz: k.config.schedule.tz ?? tz } : cfg.schedule, titleMode: k.config?.titleMode })),
  };
  return json(res);
}
