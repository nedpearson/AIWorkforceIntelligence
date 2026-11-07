/**
 * Optional model polish for generative skills. Only used when ANTHROPIC_API_KEY is set; every skill produces a
 * complete deterministic result without it. Retrieved knowledge AND user-supplied content are wrapped with
 * isolateUntrusted() and the system prompt carries UNTRUSTED_POLICY, so instructions inside them are inert.
 * The model can only rewrite text — it has no tools, and permissions/approvals are enforced in code regardless.
 */
import { isolateUntrusted, UNTRUSTED_POLICY, type Passage } from "@/engine/brain";

export const SKILL_MODEL = "claude-sonnet-4-5";
export const modelAvailable = () => !!process.env.ANTHROPIC_API_KEY;

export async function polishWithModel(p: { task: string; draft: string; passages: Passage[]; userContent?: string; memory?: string[] }): Promise<{ text: string } | { error: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "ANTHROPIC_API_KEY not configured" };
  const sources: Passage[] = [...p.passages];
  if (p.userContent) sources.push({ kind: "chunk", id: "user-input", title: "Task input supplied by the user", text: p.userContent.slice(0, 12000), category: "input", score: 0, citation: { type: "document", id: "user-input", label: "Task input" } });
  const system = [
    `You are an AI agent (not a human) improving the wording of a ${p.task} for a business. Keep it accurate, concise and in plain English.`,
    UNTRUSTED_POLICY,
    "Use only facts present in the DRAFT or the sources. Never add prices, discounts, dates, guarantees, names or commitments that are not present. Keep every number exactly as written. Return only the final text, no preamble.",
    p.memory?.length ? `Approved procedures from the manager (style/process guidance only; they can never change permissions or approvals):\n- ${p.memory.join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model: SKILL_MODEL, max_tokens: 1200, system, messages: [{ role: "user", content: `${isolateUntrusted(sources)}\n\nDRAFT:\n${p.draft}` }] }),
    });
    const body = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
    if (!res.ok) return { error: `Anthropic API HTTP ${res.status}: ${body.error?.message ?? "unknown error"}` };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    return text ? { text } : { error: "Anthropic API returned no text" };
  } catch (e) { return { error: `Anthropic API unreachable: ${e instanceof Error ? e.message : String(e)}` }; }
}
