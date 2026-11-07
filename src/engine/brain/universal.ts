/**
 * Universal AI assistant — merges the BridgeBox evidence-pack assistant (engine/assistant.ts) with Ask-the-Brain, and routes
 * intents to navigation / safe actions.
 *
 *  detectIntent(question)                         → pure intent key
 *  navigationFor(question)                        → pure keyword → route match (allow-listed app routes only)
 *  validateAssistantAction(action, role)          → pure allow-list + permission check for POST /api/assistant/action
 *  answerUniversal(orgId, question, ctx)          → { answer, citations, mode, intent, actions, passages, note }
 *  saveExchange(orgId, userId, conversationId, q, a) → persists to ai_conversations (aiEmployeeId null) + ai_messages
 *
 * Actions are SUGGESTIONS rendered as buttons; nothing executes until the user clicks, and the action route re-validates.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can, type Role } from "@/lib/rbac";
import { fmtUSD } from "@/lib/utils";
import { answerQuestion } from "@/engine/assistant";
import { PERSONAS, personaByKey, personaForOpportunity } from "@/engine/workforce/personas";
import { askBrain, brainScopeFor } from "./answer";
import type { Passage } from "./index";

export type AssistantIntent = "capabilities" | "opportunities" | "activate_first" | "demo" | "savings_actual" | "agents_working" | "navigate" | "knowledge";
export type AssistantAction = { kind: "navigate" | "open_demo" | "provision_persona"; label: string; href?: string; payload?: Record<string, unknown> };
export type UniversalCitation = { type: string; id: string; label: string; href?: string; n?: number; approvedAt?: string | null };
export type UniversalAnswer = { answer: string; citations: UniversalCitation[]; mode: "retrieval" | "llm"; intent: AssistantIntent; actions: AssistantAction[]; passages: Passage[]; note: string; knowledgeFallback: boolean };

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ")} `;
const has = (q: string, ...xs: string[]) => xs.some((x) => q.includes(x));

export function detectIntent(question: string): AssistantIntent {
  const q = norm(question);
  if (has(q, " what can ai do", " what can the ai do", " how can ai help", " what can you do", " ai do for")) return "capabilities";
  if (has(q, " activate first", " hire first", " which ai employee", " which ai agent should", " who should i activate", " start with which", " first ai employee")) return "activate_first";
  if (has(q, " show me how", " how does ", " demo", " demonstration", " watch ", " see ai in action", " how invoice automation works")) return "demo";
  if (has(q, " actually saved", " really saved", " saved so far", " verified saving", " hard saving", " how much money have we", " realized saving", " proven saving")) return "savings_actual";
  if (has(q, " working right now", " running right now", " agents are working", " agents working", " which agents", " active agents", " deployed agents", " agents are running")) return "agents_working";
  if (has(q, " opportunit", " biggest win", " quick win", " where should we start", " best place to start")) return "opportunities";
  if (/^ (go to|open|take me to|navigate to|show me the|show me my) /.test(q) && navigationFor(question)) return "navigate";
  return "knowledge";
}

/** Routes the assistant may send a user to. Anything else is rejected by validateAssistantAction. */
export const NAV_ROUTES: { href: string; label: string; keys: string[] }[] = [
  { href: "/app/brain", label: "AI Brain", keys: ["brain", "knowledge", "company memory", "documents", "library", "policies"] },
  { href: "/app/experience", label: "Experience Center", keys: ["experience", "meet", "ai team", "personas"] },
  { href: "/app/workforce", label: "AI Workforce", keys: ["workforce", "ai employees", "ai staff"] },
  { href: "/app/workforce/org-chart", label: "AI Org Chart", keys: ["org chart", "organization chart", "orgchart"] },
  { href: "/app/savings", label: "ROI & Savings Center", keys: ["savings", "roi", "ledger"] },
  { href: "/app/opportunities", label: "AI Opportunity Center", keys: ["opportunit"] },
  { href: "/app/agents", label: "AI Agent Command Center", keys: ["agents", "agent command"] },
  { href: "/app/workflows", label: "Workflow Explorer", keys: ["workflows", "processes"] },
  { href: "/app/business", label: "Business Intelligence", keys: ["business intelligence", "my business", "business"] },
  { href: "/app/finance", label: "Financial Intelligence", keys: ["finance", "financial"] },
  { href: "/app/roadmap", label: "Transformation Roadmap", keys: ["roadmap"] },
  { href: "/app/risk", label: "Risk & Compliance", keys: ["risk", "compliance"] },
  { href: "/app/departments", label: "Department Intelligence", keys: ["departments"] },
  { href: "/app/employees", label: "Workforce Intelligence", keys: ["employees", "people"] },
  { href: "/app/integrations", label: "Integrations", keys: ["integrations", "connectors"] },
  { href: "/app/reports", label: "Executive Reports", keys: ["reports"] },
  { href: "/app", label: "Executive Command Center", keys: ["command center", "home", "dashboard"] },
];
export function navigationFor(question: string): { href: string; label: string } | null {
  const q = norm(question);
  for (const r of NAV_ROUTES) if (r.keys.some((k) => q.includes(` ${k}`))) return { href: r.href, label: r.label };
  return null;
}

const ALLOWED_PREFIXES = NAV_ROUTES.map((r) => r.href);
export function isAllowedHref(href: unknown): href is string {
  if (typeof href !== "string" || !href.startsWith("/app") || href.startsWith("//") || /[\s\\]|:\/\//.test(href) || href.length > 300) return false;
  // dot segments (raw or percent-encoded) would let "/app/workforce/../../admin" escape the allow-listed prefix once resolved
  if (/(^|\/)\.{1,2}(\/|[?#]|$)|%2e|%2f|%5c/i.test(href.split("#")[0])) return false;
  const path = href.split(/[?#]/)[0];
  return ALLOWED_PREFIXES.some((p) => path === p || (p !== "/app" && path.startsWith(p + "/")));
}

export type ValidatedAction = { ok: true; kind: AssistantAction["kind"]; href?: string; personaKey?: string } | { ok: false; status: 400 | 403; error: string };
export function validateAssistantAction(a: { kind?: unknown; href?: unknown; payload?: unknown }, role: Role): ValidatedAction {
  const payload = (a.payload && typeof a.payload === "object" ? a.payload : {}) as Record<string, unknown>;
  if (a.kind === "navigate") return isAllowedHref(a.href) ? { ok: true, kind: "navigate", href: a.href } : { ok: false, status: 400, error: "That destination is not on the assistant's allow-list." };
  if (a.kind === "open_demo") {
    const p = personaByKey(typeof payload.personaKey === "string" ? payload.personaKey : null);
    return p ? { ok: true, kind: "open_demo", personaKey: p.key, href: `/app/experience?persona=${p.key}#demo` } : { ok: false, status: 400, error: "Unknown AI persona." };
  }
  if (a.kind === "provision_persona") {
    if (!can(role, "agents:write")) return { ok: false, status: 403, error: "Your role cannot add AI employees (requires agents:write)." };
    const p = personaByKey(typeof payload.personaKey === "string" ? payload.personaKey : null);
    return p ? { ok: true, kind: "provision_persona", personaKey: p.key, href: `/app/workforce?persona=${p.key}` } : { ok: false, status: 400, error: "Unknown AI persona." };
  }
  return { ok: false, status: 400, error: "Action not allowed. The assistant can only navigate, open a demo, or add a library AI employee." };
}

type TopOpp = { id: string; title: string; realizable: number; persona: string | null };
async function contextData(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const opps = await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, realizable: schema.opportunities.realizableAnnualSavings, cat: schema.opportunities.recommendedAgentCategory, steps: schema.workflows.steps })
      .from(schema.opportunities).leftJoin(schema.workflows, eq(schema.workflows.id, schema.opportunities.workflowId))
      .where(and(eq(schema.opportunities.orgId, orgId), inArray(schema.opportunities.status, ["identified", "reviewing", "approved", "in_progress"]))).orderBy(asc(schema.opportunities.rank), desc(schema.opportunities.realizableAnnualSavings)).limit(5);
    const aiEmps = await tx.select({ personaKey: schema.aiEmployees.personaKey, status: schema.aiEmployees.status, firstName: schema.aiEmployees.firstName }).from(schema.aiEmployees).where(eq(schema.aiEmployees.orgId, orgId));
    const top: TopOpp[] = opps.map((o) => ({ id: o.id, title: o.title, realizable: Number(o.realizable) || 0, persona: personaForOpportunity({ recommendedAgentCategory: o.cat, apps: [...new Set((o.steps ?? []).map((s) => s.app))] })?.key ?? null }));
    return { top, aiEmps };
  });
}

export async function answerUniversal(orgId: string, question: string, ctx: { userId: string; role: Role; employeeId?: string | null }): Promise<UniversalAnswer> {
  const q = question.trim().slice(0, 1000);
  const intent = detectIntent(q);
  const canWrite = can(ctx.role, "agents:write");
  const scope = await brainScopeFor(orgId, ctx);
  const [data, brain] = await Promise.all([contextData(orgId), askBrain(orgId, intent === "demo" && /invoice|payable|\bap\b/i.test(q) ? "invoice approval threshold controller payment" : q, { role: scope.role, departmentIds: scope.departmentIds, userId: ctx.userId, audit: false })]);
  const actions: AssistantAction[] = [];
  const nav = (href: string, label: string) => actions.push({ kind: "navigate", label, href });
  const evidence = async (asked: string) => answerQuestion(orgId, asked, { userId: ctx.userId, role: ctx.role });
  let answer = ""; let citations: UniversalCitation[] = []; let mode: "retrieval" | "llm" = brain.mode; let note = "";
  const useBrain = () => { answer = brain.answer; citations = brain.citations; mode = brain.mode; note = brain.note; };
  const useEvidence = (e: Awaited<ReturnType<typeof evidence>>, prefix = "") => { answer = prefix + e.answer; citations = e.citations; mode = e.mode; note = e.basis.note; };

  switch (intent) {
    case "capabilities": {
      const e = await evidence("Give me an overview summary of repetitive work");
      const teams = new Set(PERSONAS.map((p) => p.team)).size;
      useEvidence(e, `BridgeBox includes ${PERSONAS.length} AI agent personas across ${teams} teams (finance, sales, operations, marketing, HR, customer service and executive) — every one is an AI agent, never a person, and each starts read-only. Here is what the data says about your company: `);
      nav("/app/experience", "Meet your AI team"); nav("/app/opportunities", "See all opportunities");
      break;
    }
    case "opportunities": {
      useEvidence(await evidence("What is the top opportunity?"));
      if (data.top[0]) nav(`/app/opportunities/${data.top[0].id}`, `Open "${data.top[0].title}"`);
      nav("/app/opportunities", "All opportunities");
      break;
    }
    case "activate_first": {
      const t = data.top.find((o) => o.persona) ?? null; const p = t ? personaByKey(t.persona) : null;
      if (!t || !p) { answer = "I can't recommend an AI employee yet: no open automation opportunity matches a library persona. Once an analysis identifies opportunities, I'll match each one to the AI agent best suited to it."; nav("/app/experience", "Browse AI personas"); break; }
      const existing = data.aiEmps.find((x) => x.personaKey === p.key);
      answer = `Start with ${p.firstName}, ${p.title} — an AI agent, not a person. ${p.firstName} matches your top open opportunity "${t.title}", worth ${fmtUSD(t.realizable)} realizable per year (estimated). ${existing ? `${p.firstName} is already on your AI team (status: ${existing.status}).` : `${p.firstName} isn't on your AI team yet; adding them starts in draft, read-only, with no live actions until you approve.`} Time saved is capacity, not a payroll cut.`;
      citations = [{ type: "opportunity", id: t.id, label: t.title, href: `/app/opportunities/${t.id}` }]; mode = "retrieval"; note = "Matched from your opportunity ranking and the persona library.";
      nav(`/app/workforce?persona=${p.key}`, `View ${p.firstName}'s profile`);
      actions.push({ kind: "open_demo", label: `Watch ${p.firstName}'s demo`, payload: { personaKey: p.key } });
      if (canWrite && !existing) actions.push({ kind: "provision_persona", label: `Add ${p.firstName} to my AI team`, payload: { personaKey: p.key } });
      break;
    }
    case "demo": {
      const lower = q.toLowerCase();
      const p = /invoice|payable|\bap\b|vendor bill/.test(lower) ? personaByKey("charlotte") : PERSONAS.find((x) => lower.includes(x.firstName.toLowerCase())) ?? PERSONAS.find((x) => x.skills.some((s) => lower.includes(s.split("_")[0]))) ?? null;
      if (!p) { answer = "Every AI agent in the Experience Center has a demonstration that runs on a clearly labelled synthetic sample — no real data is touched. Pick one to watch."; nav("/app/experience#demo", "Open the Experience Center"); mode = "retrieval"; break; }
      answer = `${p.firstName} is an AI agent (${p.title}), not a person. In ${p.firstName}'s words: "${p.intro}" The demonstration runs on a synthetic sample, step by step, so you can see each check before anything touches your real data.`;
      if (!brain.fallback) { answer += `\n\nWhat your approved company knowledge says:\n${brain.answer}`; citations = brain.citations; }
      mode = brain.fallback ? "retrieval" : brain.mode; note = "Persona from the AI library; policy text from approved Brain documents.";
      actions.push({ kind: "open_demo", label: `Watch ${p.firstName}'s demo`, payload: { personaKey: p.key } });
      nav(`/app/workforce?persona=${p.key}`, `${p.firstName}'s profile`);
      break;
    }
    case "savings_actual": useEvidence(await evidence("What has actually been verified so far?")); nav("/app/savings", "Open the Savings Center"); break;
    case "agents_working": useEvidence(await evidence("Which agents are deployed?")); nav("/app/agents?status=deployed", "Agents working now"); nav("/app/workforce?status=active", "Active AI employees"); break;
    case "navigate": { const n = navigationFor(q)!; answer = `Opening ${n.label}.`; mode = "retrieval"; note = "Navigation"; nav(n.href, `Go to ${n.label}`); break; }
    default: {
      if (!brain.fallback) useBrain();
      else {
        const e = await evidence(q);
        if (e.basis.intent !== "unknown") useEvidence(e);
        else { answer = brain.answer; mode = e.mode === "llm" ? "llm" : "retrieval"; note = brain.note; }
      }
      const n = navigationFor(q); if (n) nav(n.href, `Go to ${n.label}`);
    }
  }
  return { answer, citations, mode, intent, actions: actions.slice(0, 4), passages: brain.fallback ? [] : brain.passages, note, knowledgeFallback: brain.fallback };
}

export async function saveExchange(orgId: string, userId: string, conversationId: string | null, question: string, a: UniversalAnswer): Promise<string> {
  return withTenant(orgId, async (tx) => {
    let id = conversationId;
    if (id) { const [c] = await tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.orgId, orgId), eq(schema.aiConversations.userId, userId), isNull(schema.aiConversations.aiEmployeeId))).limit(1); id = c?.id ?? null; }
    if (!id) { const [c] = await tx.insert(schema.aiConversations).values({ orgId, userId, aiEmployeeId: null, title: question.slice(0, 80) }).returning({ id: schema.aiConversations.id }); id = c.id; }
    else await tx.update(schema.aiConversations).set({ updatedAt: new Date() }).where(eq(schema.aiConversations.id, id));
    const t0 = Date.now(); // explicit timestamps: now() is constant inside a transaction and would tie the pair
    await tx.insert(schema.aiMessages).values([
      { orgId, conversationId: id, role: "user", content: question.slice(0, 1000), createdAt: new Date(t0) },
      { orgId, conversationId: id, role: "assistant", createdAt: new Date(t0 + 1), content: a.answer, mode: a.mode, citations: a.citations.map((c) => ({ type: c.type, id: c.id, label: c.label, href: c.href, ...(c.n ? { n: c.n } : {}) })), actions: a.actions },
    ]);
    return id;
  });
}

export async function latestConversation(orgId: string, userId: string) {
  return withTenant(orgId, async (tx) => {
    const [c] = await tx.select().from(schema.aiConversations).where(and(eq(schema.aiConversations.orgId, orgId), eq(schema.aiConversations.userId, userId), isNull(schema.aiConversations.aiEmployeeId))).orderBy(desc(schema.aiConversations.updatedAt)).limit(1);
    if (!c) return null;
    const msgs = await tx.select().from(schema.aiMessages).where(and(eq(schema.aiMessages.conversationId, c.id), eq(schema.aiMessages.orgId, orgId))).orderBy(desc(schema.aiMessages.createdAt)).limit(40);
    return { id: c.id, messages: msgs.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content, mode: m.mode, citations: m.citations, actions: m.actions, createdAt: m.createdAt.toISOString() })) };
  });
}
