import { and, desc, eq, ne } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { brainHealth } from "@/engine/brain";
import { memberDepartment } from "@/engine/brain/answer";
import { reviewQueue, canApproveItem } from "@/engine/brain/review";
import { listBrainSources } from "@/engine/brain/sources";
import { DEMO_DOCUMENTS } from "@/engine/brain/demo-content";
import { BrainCenter, type BrainData } from "@/components/brain/brain-center";

export const metadata = { title: "AI Brain" };
export const dynamic = "force-dynamic";

type SP = { tab?: string; doc?: string; fact?: string };

export default async function BrainPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx("workflows:read");
  const sp = await searchParams;
  const isAdminish = ["owner", "admin", "consultant"].includes(ctx.role);
  const myDept = await memberDepartment(ctx.orgId, ctx);
  const isApprover = ["owner", "admin", "manager"].includes(ctx.role);
  const [health, rows, queue, sources] = await Promise.all([
    brainHealth(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => {
      const [org] = await tx.select({ isDemo: schema.organizations.isDemo, name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
      const depts = await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId)).orderBy(schema.departments.name);
      const docs = await tx.select({ id: schema.knowledgeDocuments.id, title: schema.knowledgeDocuments.title, status: schema.knowledgeDocuments.status, version: schema.knowledgeDocuments.version, category: schema.knowledgeDocuments.category, departmentId: schema.knowledgeDocuments.departmentId, allowedRoles: schema.knowledgeDocuments.allowedRoles, approvedAt: schema.knowledgeDocuments.approvedAt, reviewEveryDays: schema.knowledgeDocuments.reviewEveryDays, createdAt: schema.knowledgeDocuments.createdAt, wordCount: schema.knowledgeDocuments.wordCount, mimeType: schema.knowledgeDocuments.mimeType, supersedesId: schema.knowledgeDocuments.supersedesId })
        .from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.orgId, ctx.orgId)).orderBy(desc(schema.knowledgeDocuments.createdAt)).limit(500);
      const facts = await tx.select().from(schema.brainFacts).where(and(eq(schema.brainFacts.orgId, ctx.orgId), ne(schema.brainFacts.status, "archived"))).orderBy(desc(schema.brainFacts.createdAt)).limit(800);
      return { org, depts, docs, facts };
    }),
    isApprover ? reviewQueue(ctx.orgId, { role: ctx.role, departmentId: ctx.role === "manager" ? myDept : null }) : Promise.resolve([]),
    listBrainSources(ctx.orgId),
  ]);
  // Non-admin members only see what their role/department may read.
  const visibleDoc = (d: { allowedRoles: string[]; departmentId: string | null }) => isAdminish || ((!d.allowedRoles.length || d.allowedRoles.includes(ctx.role)) && (!d.departmentId || d.departmentId === myDept));
  const now = Date.now();
  const data: BrainData = {
    orgName: rows.org?.name ?? ctx.orgName,
    isDemo: !!rows.org?.isDemo,
    role: ctx.role,
    myDepartmentId: myDept,
    perms: { ingest: can(ctx.role, "employees:write") || can(ctx.role, "org:manage"), approve: isApprover, owner: ctx.role === "owner" },
    departments: rows.depts,
    health,
    demoDocCount: DEMO_DOCUMENTS.length,
    docs: rows.docs.filter(visibleDoc).map((d) => ({
      id: d.id, title: d.title, status: d.status, version: d.version, category: d.category, departmentId: d.departmentId, allowedRoles: d.allowedRoles, mimeType: d.mimeType, wordCount: d.wordCount, supersedesId: d.supersedesId,
      createdAt: d.createdAt.toISOString(), approvedAt: d.approvedAt?.toISOString() ?? null, reviewEveryDays: d.reviewEveryDays,
      stale: !!d.approvedAt && d.status === "approved" && now - +d.approvedAt > d.reviewEveryDays * 86400000,
      canApprove: canApproveItem(ctx.role, myDept, d.departmentId),
    })),
    facts: rows.facts.filter((f) => isAdminish || !f.departmentId || f.departmentId === myDept).map((f) => ({
      id: f.id, category: f.category, subject: f.subject, statement: f.statement, status: f.status, version: f.version, supersedesId: f.supersedesId, sourceRef: f.sourceRef, confidence: f.confidence, departmentId: f.departmentId,
      createdAt: f.createdAt.toISOString(), approvedAt: f.approvedAt?.toISOString() ?? null, canApprove: canApproveItem(ctx.role, myDept, f.departmentId),
    })),
    queue,
    sources,
    initial: { tab: sp.tab ?? null, doc: sp.doc ?? null, fact: sp.fact ?? null },
  };
  return <BrainCenter data={data} />;
}
