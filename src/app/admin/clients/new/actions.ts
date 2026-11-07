"use server";
import { startJobSoon } from "@/lib/job-kick";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireConsultant, appUrl } from "../../_lib";
import { createClientOrg, parseEmployeeCsv, OnboardingError } from "@/engine/onboarding";
import { PLAN_KEYS } from "@/engine/billing";

const Input = z.object({
  name: z.string().min(2).max(120),
  industry: z.string().max(120).optional(),
  timezone: z.string().min(2).max(64).default("America/Chicago"),
  adminEmail: z.string().email(),
  adminName: z.string().max(120).optional(),
  plan: z.enum(PLAN_KEYS as [string, ...string[]]),
  seats: z.number().int().min(1).max(10_000).optional(),
  employeesCsv: z.string().max(200_000).optional(),
  demo: z.boolean().default(false),
});
export type NewClientResult = { ok: true; orgId: string; inviteUrl: string; employeesCreated: number; departmentsCreated: number; demo: { events: number; collectors: number } | null } | { ok: false; error: string; csvErrors?: string[] };

export async function createClientAction(raw: unknown): Promise<NewClientResult> {
  const { ctx, consultancy } = await requireConsultant();
  const p = Input.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input" };
  let employees: ReturnType<typeof parseEmployeeCsv>["rows"] | undefined;
  if (p.data.employeesCsv?.trim()) {
    const parsed = parseEmployeeCsv(p.data.employeesCsv);
    if (parsed.errors.length) return { ok: false, error: "Fix the employee CSV and try again.", csvErrors: parsed.errors.slice(0, 10) };
    employees = parsed.rows;
  }
  try {
    const r = await createClientOrg({ consultancyId: consultancy.id, name: p.data.name, industry: p.data.industry, timezone: p.data.timezone, adminEmail: p.data.adminEmail, adminName: p.data.adminName, plan: p.data.plan as "starter" | "growth" | "enterprise", seats: p.data.seats, employees, demo: p.data.demo, actorUserId: ctx.userId, appUrl: appUrl() });
    revalidatePath("/admin");
    if (r.demo?.analysisJobId) startJobSoon(r.demo.analysisJobId);
    return { ok: true, orgId: r.orgId, inviteUrl: r.inviteUrl, employeesCreated: r.employeesCreated, departmentsCreated: r.departmentsCreated, demo: r.demo ? { events: r.demo.events, collectors: r.demo.collectors } : null };
  } catch (e) { return { ok: false, error: e instanceof OnboardingError ? e.message : `Could not create the client: ${e instanceof Error ? e.message : String(e)}` }; }
}

export async function previewCsvAction(text: string): Promise<{ rows: number; departments: number; errors: string[] }> {
  await requireConsultant();
  const parsed = parseEmployeeCsv(String(text ?? "").slice(0, 200_000));
  return { rows: parsed.rows.length, departments: new Set(parsed.rows.map((r) => r.department?.toLowerCase()).filter(Boolean)).size, errors: parsed.errors.slice(0, 10) };
}
