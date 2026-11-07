import Link from "next/link";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { Badge, Empty } from "@/components/ui";
import { AuditTable } from "./audit-table";
import { VerifyChain } from "./verify-chain";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";
const PAGE = 50;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string; action?: string }> }) {
  const ctx = await requireCtx("audit:read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const actionFilter = (sp.action ?? "").trim().slice(0, 80);
  const { rows, total } = await withTenant(ctx.orgId, async (tx) => {
    const where = actionFilter ? and(eq(schema.auditLog.orgId, ctx.orgId), sql`${schema.auditLog.action} ilike ${"%" + actionFilter + "%"}`) : eq(schema.auditLog.orgId, ctx.orgId);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.auditLog).where(where);
    const rows = await tx.select().from(schema.auditLog).where(where).orderBy(desc(schema.auditLog.ts)).limit(PAGE).offset((page - 1) * PAGE);
    return { rows, total: n };
  });
  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const users = userIds.length ? await db.select({ id: schema.users.id, email: schema.users.email, orgId: schema.memberships.orgId }).from(schema.users).innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id)).where(inArray(schema.users.id, userIds)) : [];
  const who = new Map(users.filter((u) => u.orgId === ctx.orgId).map((u) => [u.id, u.email]));
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const link = (p: number) => `/app/settings/audit?page=${p}${actionFilter ? `&action=${encodeURIComponent(actionFilter)}` : ""}`;
  return (
    <div data-testid="audit-page">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-2">{total.toLocaleString("en-US")} entries. Every mutation, sign-in, report and assistant question is recorded here; entries are append-only and hash-chained, so an edited or removed entry is detectable.</p>
        <form className="flex gap-2" method="get"><input name="action" defaultValue={actionFilter} placeholder="Filter by action, e.g. report." className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" data-testid="audit-filter" /><button className="h-8 rounded-lg border border-border px-3 text-xs" data-testid="audit-filter-go">Filter</button></form>
      </div>
      <VerifyChain />
      {rows.length === 0 ? <Empty title="No audit entries" body={actionFilter ? "Nothing matches that filter." : "Actions will appear here as people use the app."} /> : (
        <AuditTable rows={rows.map((r) => ({ id: r.id, ts: r.ts.toISOString(), actor: r.actorUserId ? (who.get(r.actorUserId) ?? "member") : r.actorType, actorType: r.actorType, action: r.action, entityType: r.entityType, entityId: r.entityId, details: r.details ?? {} }))} />
      )}
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-ink-3">Page {page} of {pages}</span>
        <div className="flex gap-2">{page > 1 && <Link href={link(page - 1)} className="rounded-lg border border-border px-3 py-1.5" data-testid="audit-prev">Previous</Link>}{page < pages && <Link href={link(page + 1)} className="rounded-lg border border-border px-3 py-1.5" data-testid="audit-next">Next</Link>}</div>
      </div>
      <p className="mt-3 text-[11px] text-ink-3"><Badge tone="neutral">note</Badge> Assistant questions are logged by intent and length only; the question text itself is never stored.</p>
    </div>
  );
}
