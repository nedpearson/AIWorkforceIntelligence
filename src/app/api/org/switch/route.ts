import { cookies } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { listUserOrgs, ORG_COOKIE } from "@/lib/session";
export async function POST(req: Request) {
  const s = await auth(); if (!s?.user?.id) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { orgId } = z.object({ orgId: z.string().uuid() }).parse(await req.json());
  const allowed = (await listUserOrgs(s.user.id)).some((o) => o.id === orgId);
  if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });
  (await cookies()).set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  return Response.json({ ok: true });
}
