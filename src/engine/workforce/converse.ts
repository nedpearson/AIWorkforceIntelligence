/**
 * "Talk to <name>" — conversation with an AI employee.
 *
 *  composeRetrievalAnswer(input)  → pure, deterministic retrieval-mode answer (unit tested): intent match over the employee's
 *                                   persona, recommendations (finance engine), live financials, Brain passages and the BridgeBox
 *                                   evidence-pack answer. Always states AI identity in the first sentence; always cites.
 *  converse(args)                 → loads everything inside the tenant, answers (Anthropic Messages API when ANTHROPIC_API_KEY
 *                                   is set — retrieved text wrapped by isolateUntrusted + UNTRUSTED_POLICY — else retrieval),
 *                                   persists ai_conversations / ai_messages, audits (no message text in the audit log).
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import type { Role } from "@/lib/rbac";
import { fmtUSD, fmtNum } from "@/lib/utils";
import { retrieve, isolateUntrusted, UNTRUSTED_POLICY, type Passage } from "@/engine/brain";
import { buildEvidencePack, answerFromEvidence } from "@/engine/assistant";
import { computeOrgFinancials } from "@/engine/finance";
import { personaByKey } from "./personas";
import { recommendations, type Recommendation } from "./recommendations";
import { employeeFinancials, defaultRange, type EmployeeFinancialsResult } from "./financials";
import { listSkillInfo, skillLabel, type SkillInfo } from "./skills-adapter";
import type { AiEmployee } from "./core";

export type ChatCitation = { type: string; id: string; label: string; href?: string };
export type ChatAction = { kind: "start_demo" | "assign_task" | "open" | "connect_tools"; label: string; href?: string; payload?: Record<string, unknown> };
export type ChatAnswer = { content: string; mode: "retrieval" | "llm"; citations: ChatCitation[]; actions: ChatAction[]; intent: string; note?: string };

export type ComposeInput = {
  employee: Pick<AiEmployee, "id" | "firstName" | "title" | "intro" | "responsibilities" | "skills" | "status" | "permissionLevel" | "personaKey" | "opportunityId">;
  question: string;
  recs: Recommendation[]; // recommendations for THIS employee (already filtered)
  fin: Pick<EmployeeFinancialsResult, "totals"> | null;
  passages: Passage[];
  evidence: { answer: string; citations: ChatCitation[] } | null;
  skills: SkillInfo[] | null;
  demoSkill: string | null;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ").trim();
const has = (q: string, ...k: string[]) => k.some((x) => q.includes(x));
const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function composeRetrievalAnswer(i: ComposeInput): ChatAnswer {
  const e = i.employee; const q = norm(i.question);
  const who = `I'm ${e.firstName}, an AI agent (${e.title}).`;
  const oppCite = (r: Recommendation): ChatCitation => ({ type: "opportunity", id: r.opportunityId, label: r.opportunityTitle, href: `/app/opportunities/${r.opportunityId}` });
  const wfCite = (r: Recommendation): ChatCitation[] => r.workflowId ? [{ type: "workflow", id: r.workflowId, label: r.workflowName ?? r.workflowLabel, href: `/app/workflows/${r.workflowId}` }] : [];
  const demo: ChatAction[] = i.demoSkill ? [{ kind: "start_demo", label: `Watch ${e.firstName} demonstrate ${skillLabel(i.demoSkill, i.skills).toLowerCase()}`, payload: { skillKey: i.demoSkill } }] : [];
  const out = (intent: string, body: string, citations: ChatCitation[], actions: ChatAction[] = [], note?: string): ChatAnswer => ({ content: `${who} ${body}`.trim(), mode: "retrieval", citations: dedupe(citations), actions, intent, note });

  if (has(q, "demonstrat", "demo", "show me", "watch you", "example")) {
    if (!i.demoSkill) return out("demo", "I don't have a demonstration skill configured yet. An owner can add skills under Customize responsibilities.", []);
    return out("demo", `Yes — I can run "${skillLabel(i.demoSkill, i.skills)}" right now in the sandbox on a synthetic sample, so nothing touches your real systems. Press the button below to watch each step.`, [], demo);
  }
  if (has(q, "save", "saving", "money", "roi", "worth", "value", "cost", "pay for")) {
    const parts: string[] = []; const cites: ChatCitation[] = [];
    if (i.recs.length) {
      const tot = i.recs.reduce((s, r) => s + r.realizableAnnualSavings, 0); const hrs = i.recs.reduce((s, r) => s + r.hoursRecoverablePerWeek, 0);
      parts.push(`Based on your observed workflows, the work I'd take over is projected at about ${fmtUSD(tot)} a year in recovered capacity (${fmtNum(hrs, 1)} hours/week, estimated by the finance engine): ${list(i.recs.slice(0, 3).map((r) => `${r.workflowLabel} — ${fmtUSD(r.realizableAnnualSavings)}/yr`))}.`);
      parts.push("That is capacity — time your people get back — not a payroll cut; cash savings only count once finance approves them in the savings ledger.");
      i.recs.slice(0, 3).forEach((r) => cites.push(oppCite(r), ...wfCite(r)));
    } else parts.push("I haven't been matched to a discovered opportunity in your workflows yet, so I can't project savings without inventing numbers.");
    if (i.fin) {
      const t = i.fin.totals;
      parts.push(t.liveRuns ? `So far I've completed ${t.tasksCompleted} live task(s), recovering ${fmtNum(t.verifiedHoursRecovered, 1)} verified hours (${fmtUSD(t.capacityValue)} capacity value) against ${fmtUSD(t.operatingCost)} operating cost.` : "I have no live runs yet, so nothing is verified — sandbox demonstrations never count toward savings.");
      cites.push({ type: "ai_employee", id: e.id, label: `${e.firstName}'s work history`, href: `/app/workforce/${e.id}?tab=savings` });
    }
    return out("savings", parts.join(" "), cites, demo.length ? [...demo, { kind: "open", label: "Review my savings", href: `/app/workforce/${e.id}?tab=savings` }] : []);
  }
  if (has(q, "take over", "tasks", "which work", "what work", "automate", "workload", "help with")) {
    if (!i.recs.length) return out("tasks", `My responsibilities are: ${list(e.responsibilities.map((r) => r.toLowerCase()))}. I haven't been matched to a specific discovered workflow at your company yet — once workflow discovery finds one in my area I'll show the observed hours here.`, []);
    const top = i.recs.slice(0, 4);
    return out("tasks", `From the workflows BridgeBox observed at your company, I could take over: ${list(top.map((r) => `${r.workflowLabel} (your team spends ~${fmtNum(r.observedHoursPerWeek, 1)} hrs/week; about ${fmtNum(r.hoursRecoverablePerWeek, 1)} hrs/week is automatable)`))}. Anything consequential would still go to a person for approval.`, top.flatMap((r) => [oppCite(r), ...wfCite(r)]), demo);
  }
  if (has(q, "what can you do", "what do you do", "who are you", "capabil", "your skills", "introduce", "hello", "hi ", "about you") || q === "hi") {
    const sk = e.skills.map((k) => skillLabel(k, i.skills));
    return out("capabilities", `${e.intro.replace(/^Hi, I'm [^.!?]*[.!?]\s*/, "")} My responsibilities: ${list(e.responsibilities.map((r) => r.toLowerCase()))}. Skills I can run: ${list(sk)}. I work at "${e.permissionLevel.replace(/_/g, " ")}" permission and I'm currently in ${e.status} status.`.trim(),
      i.recs.slice(0, 2).map(oppCite), demo);
  }
  // knowledge question: approved Brain passages first, then BridgeBox evidence
  if (i.passages.length) {
    const top = i.passages.slice(0, 3);
    const body = `Here is what your approved company knowledge says: ${top.map((p) => `“${p.text.replace(/\s+/g, " ").slice(0, 260).trim()}${p.text.length > 260 ? "…" : ""}” (${p.citation.label})`).join(" ")}`;
    return out("knowledge", body, top.map((p) => ({ ...p.citation })), [], "Quoted from approved Brain documents/facts only.");
  }
  if (i.evidence && i.evidence.citations.length) return out("evidence", i.evidence.answer, i.evidence.citations);
  return out("unknown", "I don't have approved company knowledge or BridgeBox evidence that answers that, so I won't guess. You can add the relevant policy or procedure in the AI Brain and I'll use it once it's approved.", [], []);
}

function dedupe(c: ChatCitation[]) { const s = new Set<string>(); return c.filter((x) => { const k = `${x.type}:${x.id}`; if (s.has(k)) return false; s.add(k); return true; }); }

// ---------------------------------------------------------------- LLM mode
function systemPrompt(e: ComposeInput["employee"], instructions: string, memory: string[]) {
  return [
    `You are ${e.firstName}, an AI agent employed as "${e.title}" inside BridgeBox. You are an AI, never a human; your first sentence must say you are an AI agent.`,
    `Responsibilities: ${e.responsibilities.join("; ")}. Permission level: ${e.permissionLevel}. Status: ${e.status}.`,
    instructions ? `Owner instructions (trusted): ${instructions.slice(0, 2000)}` : "",
    memory.length ? `Approved procedures you have learned (trusted): ${memory.slice(0, 20).join(" | ")}` : "",
    "Answer ONLY from the SOURCES and the BRIDGEBOX EVIDENCE provided. If they do not contain the answer, say so plainly. Never invent numbers. Projected figures are estimates; savings are capacity, not payroll cuts; never recommend terminating anyone.",
    "Keep answers under 160 words, plain English, for a non-technical business owner.",
    UNTRUSTED_POLICY,
  ].filter(Boolean).join("\n");
}
async function askModel(system: string, history: { role: "user" | "assistant"; content: string }[], user: string): Promise<{ text: string } | { error: string }> {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return { error: "ANTHROPIC_API_KEY not configured" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 700, system, messages: [...history.slice(-6), { role: "user", content: user }] }) });
    const body = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
    if (!res.ok) return { error: `Anthropic API HTTP ${res.status}: ${body.error?.message ?? "unknown"}` };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    return text ? { text } : { error: "empty response" };
  } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
}

// ---------------------------------------------------------------- orchestration
export type ConverseArgs = { orgId: string; userId: string; role: Role; aiEmployeeId: string; conversationId?: string | null; message: string };
export async function converse(a: ConverseArgs): Promise<{ conversationId: string; user: { id: string; content: string }; reply: ChatAnswer & { id: string } }> {
  const question = a.message.trim().slice(0, 1500);
  if (!question) throw new Error("empty message");
  const loaded = await withTenant(a.orgId, async (tx) => {
    const [emp] = await tx.select().from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, a.orgId), eq(schema.aiEmployees.id, a.aiEmployeeId))).limit(1);
    if (!emp) throw new Error("AI employee not found");
    let conv = a.conversationId ? (await tx.select().from(schema.aiConversations).where(and(eq(schema.aiConversations.orgId, a.orgId), eq(schema.aiConversations.id, a.conversationId), eq(schema.aiConversations.userId, a.userId), eq(schema.aiConversations.aiEmployeeId, emp.id))).limit(1))[0] : undefined;
    if (!conv) [conv] = await tx.insert(schema.aiConversations).values({ orgId: a.orgId, aiEmployeeId: emp.id, userId: a.userId, title: question.slice(0, 80) }).returning();
    const history = await tx.select({ role: schema.aiMessages.role, content: schema.aiMessages.content }).from(schema.aiMessages).where(and(eq(schema.aiMessages.orgId, a.orgId), eq(schema.aiMessages.conversationId, conv.id))).orderBy(asc(schema.aiMessages.createdAt));
    const memory = await tx.select({ text: schema.aiEmployeeMemory.text }).from(schema.aiEmployeeMemory).where(and(eq(schema.aiEmployeeMemory.orgId, a.orgId), eq(schema.aiEmployeeMemory.aiEmployeeId, emp.id), eq(schema.aiEmployeeMemory.status, "approved")));
    return { emp, conv, history, memory: memory.map((m) => m.text) };
  });
  const { emp } = loaded;
  const fin = await computeOrgFinancials(a.orgId);
  const [recsAll, efin, skills, passages, pack] = await Promise.all([
    recommendations(a.orgId, { fin }),
    employeeFinancials(a.orgId, emp.id, defaultRange(), { fin }).catch(() => null),
    listSkillInfo(),
    retrieve(a.orgId, question, { role: a.role, departmentIds: emp.knowledgeScope.departmentIds ?? null, categories: emp.knowledgeScope.categories ?? null, documentIds: emp.knowledgeScope.documentIds ?? null }, 6).catch(() => [] as Passage[]),
    buildEvidencePack(a.orgId, { role: a.role }),
  ]);
  const recs = recsAll.filter((r) => r.opportunityId === emp.opportunityId || (emp.personaKey && r.persona.key === emp.personaKey));
  const ev = answerFromEvidence(pack, question);
  const persona = personaByKey(emp.personaKey);
  const input: ComposeInput = { employee: emp, question, recs, fin: efin, passages, evidence: { answer: ev.answer, citations: ev.citations }, skills, demoSkill: persona?.demoSkill ?? emp.skills[0] ?? null };
  let reply = composeRetrievalAnswer(input);
  if (process.env.ANTHROPIC_API_KEY) {
    const evidence = { recommendations: recs.map((r) => ({ workflow: r.workflowLabel, observedHoursPerWeek: r.observedHoursPerWeek, hoursRecoverablePerWeek: r.hoursRecoverablePerWeek, realizableAnnualSavingsEstimated: r.realizableAnnualSavings })), myLiveResults: efin?.totals ?? null, platformAnswer: ev.answer, draftAnswer: reply.content };
    const r = await askModel(systemPrompt(emp, emp.instructions, loaded.memory), loaded.history.map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.content })),
      `SOURCES:\n${isolateUntrusted(passages)}\n\nBRIDGEBOX EVIDENCE (trusted platform data):\n${JSON.stringify(evidence)}\n\nQUESTION: ${question}`);
    if ("text" in r) {
      const text = /\bAI agent\b/i.test(r.text.split(/(?<=[.!?])\s/)[0] ?? "") ? r.text : `I'm ${emp.firstName}, an AI agent. ${r.text}`;
      reply = { ...reply, content: text, mode: "llm", citations: dedupe([...passages.slice(0, 4).map((p) => ({ ...p.citation })), ...reply.citations]) };
    } else reply = { ...reply, note: `AI model unavailable (${r.error}); answered in retrieval mode.` };
  }
  const saved = await withTenant(a.orgId, async (tx) => {
    const [u] = await tx.insert(schema.aiMessages).values({ orgId: a.orgId, conversationId: loaded.conv.id, role: "user", content: question }).returning({ id: schema.aiMessages.id });
    const [m] = await tx.insert(schema.aiMessages).values({ orgId: a.orgId, conversationId: loaded.conv.id, role: "assistant", content: reply.content, mode: reply.mode, citations: reply.citations, actions: reply.actions }).returning({ id: schema.aiMessages.id });
    await tx.update(schema.aiConversations).set({ updatedAt: new Date() }).where(eq(schema.aiConversations.id, loaded.conv.id));
    return { u: u.id, m: m.id };
  });
  await audit({ orgId: a.orgId, actorUserId: a.userId, action: "ai_employee.converse", entityType: "ai_employee", entityId: emp.id, details: { mode: reply.mode, intent: reply.intent, citations: reply.citations.length, questionLength: question.length } });
  return { conversationId: loaded.conv.id, user: { id: saved.u, content: question }, reply: { ...reply, id: saved.m } };
}

export async function conversationHistory(orgId: string, userId: string, aiEmployeeId: string) {
  return withTenant(orgId, async (tx) => {
    const [conv] = await tx.select().from(schema.aiConversations).where(and(eq(schema.aiConversations.orgId, orgId), eq(schema.aiConversations.userId, userId), eq(schema.aiConversations.aiEmployeeId, aiEmployeeId))).orderBy(desc(schema.aiConversations.updatedAt)).limit(1);
    if (!conv) return { conversationId: null as string | null, messages: [] as { id: string; role: string; content: string; mode: string | null; citations: ChatCitation[]; actions: ChatAction[] }[] };
    const msgs = await tx.select().from(schema.aiMessages).where(and(eq(schema.aiMessages.orgId, orgId), eq(schema.aiMessages.conversationId, conv.id))).orderBy(asc(schema.aiMessages.createdAt));
    return { conversationId: conv.id as string | null, messages: msgs.slice(-40).map((m) => ({ id: m.id, role: m.role, content: m.content, mode: m.mode, citations: m.citations, actions: m.actions as ChatAction[] })) };
  });
}
