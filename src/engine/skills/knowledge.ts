/**
 * Skill-side knowledge access. Thin, permission-aware readers over APPROVED AI Brain knowledge (facts + documents),
 * scoped by the AI employee's knowledgeScope and the caller's role — the same rules as `retrieve()` in
 * src/engine/brain (which this module also uses for ranked passages). Plus small deterministic parsers that turn
 * approved policy text into structured settings (approval thresholds, tolerances, pricing, GL codes, vendors).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { retrieve, type Citation, type Passage, type Scope } from "@/engine/brain";
import { parseMoney, type VendorRef } from "./invoice";

export type KFact = { id: string; category: string; subject: string; statement: string; citation: Citation };
export type KDoc = { id: string; title: string; category: string; content: string; citation: Citation };
export type KnowledgeScope = { departmentIds?: string[]; documentIds?: string[]; categories?: string[] };

const roleAllowed = (allowed: string[] | null | undefined, role: string) => !allowed || allowed.length === 0 || allowed.includes(role) || ["owner", "admin"].includes(role);
export const factCitation = (f: { id: string; subject: string }): Citation => ({ type: "fact", id: f.id, label: f.subject, href: `/app/brain?tab=facts&fact=${f.id}` });
export const docCitation = (d: { id: string; title: string }): Citation => ({ type: "document", id: d.id, label: d.title, href: `/app/brain?doc=${d.id}` });

/** Category list allowed by scope ∩ wanted (null = no category restriction). Empty array = nothing allowed. */
function categoriesFor(scope: KnowledgeScope, wanted?: string[]): string[] | null {
  const s = scope.categories?.length ? scope.categories : null;
  if (!wanted?.length) return s;
  return s ? wanted.filter((c) => s.includes(c)) : wanted;
}

export function brainScope(scope: KnowledgeScope, role: string): Scope {
  return { role, departmentIds: scope.departmentIds?.length ? scope.departmentIds : null, categories: scope.categories?.length ? scope.categories : null, documentIds: scope.documentIds?.length ? scope.documentIds : null };
}

export async function approvedFacts(orgId: string, scope: KnowledgeScope, categories?: string[]): Promise<KFact[]> {
  const cats = categoriesFor(scope, categories);
  if (cats && !cats.length) return [];
  const depts = scope.departmentIds?.length ? scope.departmentIds : null;
  const rows = await withTenant(orgId, (tx) => tx.select({ id: schema.brainFacts.id, category: schema.brainFacts.category, subject: schema.brainFacts.subject, statement: schema.brainFacts.statement, departmentId: schema.brainFacts.departmentId })
    .from(schema.brainFacts).where(and(eq(schema.brainFacts.orgId, orgId), eq(schema.brainFacts.status, "approved"),
      cats ? inArray(schema.brainFacts.category, cats) : sql`true`,
      depts ? sql`(${schema.brainFacts.departmentId} is null or ${schema.brainFacts.departmentId} in (${sql.join(depts.map((d) => sql`${d}::uuid`), sql`, `)}))` : sql`true`)).limit(500));
  return rows.map((f) => ({ id: f.id, category: f.category, subject: f.subject, statement: f.statement, citation: factCitation(f) }));
}

export async function approvedDocs(orgId: string, scope: KnowledgeScope, role: string, categories?: string[]): Promise<KDoc[]> {
  const cats = categoriesFor(scope, categories);
  if (cats && !cats.length) return [];
  const depts = scope.departmentIds?.length ? scope.departmentIds : null;
  const rows = await withTenant(orgId, (tx) => tx.select({ id: schema.knowledgeDocuments.id, title: schema.knowledgeDocuments.title, category: schema.knowledgeDocuments.category, content: schema.knowledgeDocuments.content, allowedRoles: schema.knowledgeDocuments.allowedRoles })
    .from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.orgId, orgId), eq(schema.knowledgeDocuments.status, "approved"),
      cats ? inArray(schema.knowledgeDocuments.category, cats) : sql`true`,
      scope.documentIds?.length ? inArray(schema.knowledgeDocuments.id, scope.documentIds) : sql`true`,
      depts ? sql`(${schema.knowledgeDocuments.departmentId} is null or ${schema.knowledgeDocuments.departmentId} in (${sql.join(depts.map((d) => sql`${d}::uuid`), sql`, `)}))` : sql`true`)).limit(100));
  return rows.filter((d) => roleAllowed(d.allowedRoles, role)).map((d) => ({ id: d.id, title: d.title, category: d.category, content: d.content.slice(0, 200_000), citation: docCitation(d) }));
}

export async function rankedPassages(orgId: string, query: string, scope: KnowledgeScope, role: string, limit = 6): Promise<Passage[]> {
  try { return await retrieve(orgId, query, brainScope(scope, role), limit); } catch { return []; }
}

// ---------------------------------------------------------------------------------------------- policy parsers
export type TextSrc = { text: string; source: string; citation?: Citation };

/** "Invoices over $5,000 require controller approval" → { threshold: 5000, approverRole: "controller" }. */
export function parseApprovalPolicy(srcs: TextSrc[], subject = /invoice|bill|payable|payment|purchase|spend|expense/i): { threshold: number; approverRole: string; source: string; citation?: Citation; sentence: string } | null {
  for (const s of srcs) {
    for (const sentence of s.text.split(/(?<=[.;!?\n])\s+/)) {
      const m = sentence.match(/\b(?:over|above|exceeding|exceeds?|greater than|more than|in excess of|>)\s*\$\s?([\d,]+(?:\.\d{2})?)\s*(k\b)?/i);
      if (!m || !/approv/i.test(sentence) || !subject.test(sentence)) continue;
      const threshold = (parseMoney(m[1]) ?? 0) * (m[2] ? 1000 : 1);
      if (!threshold) continue;
      const role = sentence.match(/\b(controller|cfo|chief financial officer|owner|ceo|president|finance director|finance manager|director|manager|admin(?:istrator)?)\b/i)?.[1]?.toLowerCase() ?? "manager";
      return { threshold, approverRole: role === "chief financial officer" ? "cfo" : role, source: s.source, citation: s.citation, sentence: sentence.trim() };
    }
  }
  return null;
}
/** "PO match tolerance is 3%" / "within 5% of the PO" → 3 / 5. */
export function parseTolerancePct(srcs: TextSrc[]): { pct: number; source: string; citation?: Citation } | null {
  for (const s of srcs) {
    const m = s.text.match(/(?:tolerance[^.%\n]{0,40}?(\d+(?:\.\d+)?)\s*%)|(?:within\s+(\d+(?:\.\d+)?)\s*%\s+of\s+the\s+(?:po|purchase order))/i);
    if (m) return { pct: Number(m[1] ?? m[2]), source: s.source, citation: s.citation };
  }
  return null;
}
/** Approved vendors from vendor facts (subject = vendor name). Facts that say a vendor is blocked are excluded. */
export function vendorsFromFacts(facts: KFact[]): { approved: VendorRef[]; blocked: VendorRef[] } {
  const approved: VendorRef[] = [], blocked: VendorRef[] = [];
  for (const f of facts) {
    if (f.category !== "vendor") continue;
    const name = f.subject.replace(/^(approved\s+)?vendor\s*[:\-–]\s*/i, "").trim();
    const ref = { name, source: `AI Brain fact “${f.subject}”`, citationId: f.id };
    if (/\b(not approved|blocked|do not (use|pay)|suspended|on hold|inactive)\b/i.test(f.statement)) blocked.push(ref); else approved.push(ref);
  }
  return { approved, blocked };
}
export type PriceRef = { item: string; price: number; unit: string; source: string; citation?: Citation };
/** "Standard labor rate is $85/hour", "Gate valve 2in: $38.50 each", "Installation — $1,200 per project". */
export function parsePricing(srcs: TextSrc[]): PriceRef[] {
  const out: PriceRef[] = [];
  for (const s of srcs) {
    for (const sentence of s.text.split(/(?<=[.;\n])\s*/)) {
      const m = sentence.match(/^(.*?)\s*(?:is|are|=|:|—|-|costs?|at|priced at)\s*\$\s?([\d,]+(?:\.\d{1,2})?)\s*(?:\/|per\s+|an?\s+)?(hour|hr|day|month|mo|year|yr|unit|each|ea|project|visit|user|seat|sq\.?\s?ft|item)?/i);
      if (!m) continue;
      const item = m[1].replace(/^(our|the|a|an)\s+/i, "").replace(/\b(standard|current)\s+price\s+(for|of)\s+/i, "").trim();
      const price = parseMoney(m[2]); if (!item || price == null || item.length > 80) continue;
      out.push({ item, price, unit: (m[3] ?? "each").toLowerCase().replace(/^hr$/, "hour").replace(/^ea$/, "each").replace(/^mo$/, "month").replace(/^yr$/, "year"), source: s.source, citation: s.citation });
    }
  }
  return out;
}
export function findPrice(name: string, prices: PriceRef[]): PriceRef | null {
  const toks = (x: string) => new Set(x.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|with|rate|price|standard)$/.test(w)));
  const A = toks(name); let best: { p: PriceRef; s: number } | null = null;
  for (const p of prices) { const B = toks(p.item); if (!A.size || !B.size) continue; let i = 0; for (const x of A) if (B.has(x)) i++; const s = i / Math.min(A.size, B.size); if (s > (best?.s ?? 0)) best = { p, s }; }
  return best && best.s >= 0.5 ? best.p : null;
}
export function factsToSrc(facts: KFact[]): TextSrc[] { return facts.map((f) => ({ text: `${f.subject}: ${f.statement}`, source: `AI Brain fact “${f.subject}”`, citation: f.citation })); }
export function docsToSrc(docs: KDoc[]): TextSrc[] { return docs.map((d) => ({ text: d.content, source: `AI Brain document “${d.title}”`, citation: d.citation })); }
