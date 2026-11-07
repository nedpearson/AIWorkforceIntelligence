"use server";
import { z } from "zod";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { ORG_COOKIE } from "@/lib/session";
import { acceptInvitation, OnboardingError } from "@/engine/onboarding";

type Result = { ok: true; orgId: string; email?: string } | { ok: false; error: string };
async function setOrgCookie(orgId: string) { (await cookies()).set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" }); }

/** Signed-in user accepts (their email must match the invitation). */
export async function acceptAsExisting(raw: unknown): Promise<Result> {
  const p = z.object({ token: z.string().min(16).max(200) }).safeParse(raw); if (!p.success) return { ok: false, error: "Invalid invitation link." };
  const s = await auth(); if (!s?.user?.id) return { ok: false, error: "Sign in first." };
  try { const r = await acceptInvitation({ token: p.data.token, mode: "existing", userId: s.user.id }); await setOrgCookie(r.orgId); return { ok: true, orgId: r.orgId }; }
  catch (e) { return { ok: false, error: e instanceof OnboardingError ? e.message : "Could not accept the invitation." }; }
}
/** New user: creates the account + membership. The client then signs in with the same credentials. */
export async function acceptAsNew(raw: unknown): Promise<Result> {
  const p = z.object({ token: z.string().min(16).max(200), name: z.string().min(2).max(120), password: z.string().min(10).max(200) }).safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.path[0] === "password" ? "Password must be at least 10 characters." : p.error.issues[0]?.message ?? "Invalid input" };
  try { const r = await acceptInvitation({ token: p.data.token, mode: "new", name: p.data.name, password: p.data.password }); await setOrgCookie(r.orgId); return { ok: true, orgId: r.orgId }; }
  catch (e) { return { ok: false, error: e instanceof OnboardingError ? e.message : "Could not accept the invitation." }; }
}
