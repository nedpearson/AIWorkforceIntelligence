/**
 * Ask the Brain — permission-aware, cited answers over APPROVED company knowledge.
 *
 *  askBrain(orgId, question, { role, departmentIds, userId? }) → { answer, citations, passages, mode, fallback }
 *    - retrieval mode (default, no LLM key): composes an answer from the most relevant sentences of the top passages,
 *      each followed by an inline [n] citation that points at passages[n-1]. Never adds words that are not in the source
 *      beyond connective framing. No relevant approved passage → FALLBACK_ANSWER.
 *    - llm mode (ANTHROPIC_API_KEY set): Messages API, retrieved text wrapped by isolateUntrusted() and UNTRUSTED_POLICY in
 *      the system prompt; [n] references are mapped back to real passages, unknown indices dropped.
 *  brainScopeFor(orgId, ctx) → the Scope a signed-in member retrieves with (role + department restriction).
 */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { retrieve, isolateUntrusted, UNTRUSTED_POLICY, type Passage, type Citation } from "./index";

export const FALLBACK_ANSWER = "I don't have approved information about that. Nothing in your company's approved documents or business memory covers it yet — add or approve a document in the AI Brain library and I'll be able to answer.";
/** Non-matching UUID used to restrict a member with no department to org-wide knowledge only. */
export const NO_DEPARTMENT = "00000000-0000-0000-0000-000000000000";

export type BrainCitation = Citation & { n: number; approvedAt?: string | null };
export type BrainAnswer = { answer: string; citations: BrainCitation[]; passages: Passage[]; mode: "retrieval" | "llm"; fallback: boolean; note: string };

const STOP = new Set("a an and are as at be by can could do does for from had has have how i if in into is it its may me my of on or our should so than that the their them then there these they this to us was we what when where which who why will with would you your about tell show give much many any all get".split(" "));
export const keywords = (q: string) => [...new Set(q.toLowerCase().replace(/[^a-z0-9$%.,\s-]/g, " ").split(/\s+/).map((w) => w.replace(/^[.,-]+|[.,-]+$/g, "")).filter((w) => w.length > 2 && !STOP.has(w)))];
const stem = (w: string) => w.replace(/(ies|es|s|ing|ed)$/, "");

function sentences(text: string): string[] {
  return text.replace(/\n+/g, " \n ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“$])|\s\n\s/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 3);
}
function sentenceScore(s: string, kws: string[]) {
  const words = s.toLowerCase().split(/[^a-z0-9$%,.]+/).map(stem);
  return kws.reduce((acc, k) => acc + (words.some((w) => w === stem(k) || (w.length > 3 && stem(k).length > 3 && (w.startsWith(stem(k)) || stem(k).startsWith(w)))) ? 1 : 0), 0);
}

/** Pure: build a cited retrieval-mode answer from ranked passages. Exported for unit tests. */
export function composeRetrievalAnswer(question: string, passages: Passage[], maxPassages = 3): { answer: string; used: Passage[]; fallback: boolean } {
  const kws = keywords(question);
  // A passage must cover most of the question's keywords (title + heading + text) — one stray word match is not an answer.
  const need = Math.min(3, Math.ceil(kws.length * 0.6));
  const picked: { p: Passage; lines: string[] }[] = [];
  for (const p of passages) {
    if (!kws.length) break;
    const coverage = sentenceScore(`${p.title} ${p.heading ?? ""} ${p.text}`, kws);
    if (coverage < need) continue;
    const ss = sentences(p.text);
    const scored = ss.map((s, i) => ({ s, i, sc: sentenceScore(s, kws) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc || a.i - b.i);
    const lines = scored.length ? scored.slice(0, 2).sort((a, b) => a.i - b.i).map((x) => x.s) : ss.slice(0, 2);
    picked.push({ p, lines });
    if (picked.length >= maxPassages) break;
  }
  if (!picked.length) return { answer: FALLBACK_ANSWER, used: [], fallback: true };
  const parts = picked.map((x, i) => {
    const src = x.p.kind === "fact" ? `Business memory (${x.p.title})` : `${x.p.title}${x.p.heading ? ` — ${x.p.heading}` : ""}`;
    const body = x.lines.map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)).join(" ");
    return `${i === 0 ? "According to" : "Also, per"} ${src}: ${body} [${i + 1}]`;
  });
  return { answer: parts.join("\n\n"), used: picked.map((x) => x.p), fallback: false };
}

const SYSTEM = (org: string) => `You answer questions for employees of ${org} using ONLY the approved company knowledge provided in <source> tags.
${UNTRUSTED_POLICY}
Rules: 1) Use only facts stated in the sources. 2) After every sentence that uses a source, cite it as [n] where n is the source index. 3) If the sources do not answer the question, reply exactly: "${FALLBACK_ANSWER}" 4) Plain English, 2-5 sentences, no headings. 5) Never invent numbers, names, thresholds or policies.`;

async function askAnthropic(orgName: string, question: string, passages: Passage[]): Promise<{ text: string } | { error: string }> {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return { error: "ANTHROPIC_API_KEY not configured" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 700, system: SYSTEM(orgName), messages: [{ role: "user", content: `${isolateUntrusted(passages)}\n\nQUESTION: ${question}` }] }),
    });
    const body = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
    if (!res.ok) return { error: `Anthropic API HTTP ${res.status}: ${body.error?.message ?? "error"}` };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    return text ? { text } : { error: "empty response" };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Map [n] markers to passages; drop indices that don't exist (never invent a source). Renumbers to 1..k in order of use. */
export function mapCitationMarkers(text: string, passages: Passage[]): { text: string; used: Passage[] } {
  const used: Passage[] = []; const map = new Map<number, number>();
  const out = text.replace(/\[(\d{1,2})\]/g, (_m, d: string) => {
    const i = Number(d) - 1; const p = passages[i]; if (!p) return "";
    if (!map.has(i)) { used.push(p); map.set(i, used.length); }
    return `[${map.get(i)}]`;
  }).replace(/[ \t]+([.,;:])/g, "$1").trim();
  return { text: out, used };
}

const toCitations = (used: Passage[]): BrainCitation[] => used.map((p, i) => ({ ...p.citation, n: i + 1, approvedAt: p.approvedAt ?? null }));

/**
 * retrieve() uses websearch syntax, which ANDs every word — natural questions ("How often does X renew?") then miss facts.
 * Run it as asked AND as an OR-of-keywords query, merge by id (best score wins); composeRetrievalAnswer then enforces coverage.
 */
export async function retrieveBroad(orgId: string, q: string, scope: { role: string; departmentIds?: string[] | null }, limit = 6): Promise<Passage[]> {
  const kws = keywords(q).map((k) => k.replace(/[^a-z0-9$%]/g, "")).filter(Boolean).slice(0, 8);
  const [strict, broad] = await Promise.all([retrieve(orgId, q, scope, limit), kws.length > 1 ? retrieve(orgId, kws.join(" or "), scope, limit * 2) : Promise.resolve([] as Passage[])]);
  const byId = new Map<string, Passage>();
  for (const p of [...strict.map((x) => ({ ...x, score: x.score + 1 })), ...broad]) { const cur = byId.get(p.id); if (!cur || p.score > cur.score) byId.set(p.id, p); }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function askBrain(orgId: string, question: string, opts: { role: string; departmentIds?: string[] | null; userId?: string | null; limit?: number; audit?: boolean }): Promise<BrainAnswer> {
  const q = question.trim().slice(0, 500);
  const passages = q ? await retrieveBroad(orgId, q, { role: opts.role, departmentIds: opts.departmentIds ?? null }, opts.limit ?? 6) : [];
  const r = composeRetrievalAnswer(q, passages);
  let result: BrainAnswer = { answer: r.answer, citations: toCitations(r.used), passages: r.fallback ? passages : r.used, mode: "retrieval", fallback: r.fallback, note: r.fallback ? "No approved passage matched; nothing was inferred." : "Composed verbatim from approved company knowledge; each [n] links to its source." };
  if (process.env.ANTHROPIC_API_KEY && passages.length) {
    const org = await withTenant(orgId, async (tx) => (await tx.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0]);
    const llm = await askAnthropic(org?.name ?? "the company", q, passages);
    if ("text" in llm) {
      const m = mapCitationMarkers(llm.text, passages);
      const fb = m.used.length === 0;
      result = { answer: fb ? FALLBACK_ANSWER : m.text, citations: toCitations(m.used), passages: fb ? passages : m.used, mode: "llm", fallback: fb, note: "AI-written from the approved passages shown; retrieved text was isolated as untrusted data." };
    } else result.note += ` (AI model unavailable: ${llm.error})`;
  }
  if (opts.audit !== false && opts.userId) await audit({ orgId, actorUserId: opts.userId, action: "brain.question", entityType: "brain", details: { mode: result.mode, fallback: result.fallback, passages: result.passages.length, role: opts.role, questionLength: q.length } });
  return result;
}

/**
 * Retrieval scope for a member. owner/admin/consultant see every department; everyone else is limited to org-wide knowledge
 * plus their own department (from their linked employee record). A member with no department gets org-wide knowledge only.
 */
export async function brainScopeFor(orgId: string, ctx: { userId: string; role: string; employeeId?: string | null }): Promise<{ role: string; departmentIds: string[] | null; departmentId: string | null }> {
  const departmentId = await memberDepartment(orgId, ctx);
  if (["owner", "admin", "consultant"].includes(ctx.role)) return { role: ctx.role, departmentIds: null, departmentId };
  return { role: ctx.role, departmentIds: departmentId ? [departmentId] : [NO_DEPARTMENT], departmentId };
}
export async function memberDepartment(orgId: string, ctx: { userId: string; employeeId?: string | null }): Promise<string | null> {
  return withTenant(orgId, async (tx) => {
    const [e] = ctx.employeeId
      ? await tx.select({ d: schema.employees.departmentId }).from(schema.employees).where(and(eq(schema.employees.id, ctx.employeeId), eq(schema.employees.orgId, orgId))).limit(1)
      : await tx.select({ d: schema.employees.departmentId }).from(schema.employees).where(and(eq(schema.employees.userId, ctx.userId), eq(schema.employees.orgId, orgId))).limit(1);
    return e?.d ?? null;
  });
}
