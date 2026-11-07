"use client";
import * as React from "react";
import Link from "next/link";
import { MessageSquare, Send, Sparkles, Database } from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { AssistantAnswer } from "@/engine/assistant";

const SUGGESTED = [
  "Which department wastes the most time?",
  "What would we save?",
  "What is the top opportunity?",
  "What is the payback?",
  "What has been verified?",
  "Which workflows need human judgment?",
  "What is the status of the collectors?",
  "How many hours does Dana spend on invoices?",
];
type Msg = { id: number; role: "user" | "assistant"; text: string; answer?: AssistantAnswer; error?: string };

export function AssistantClient({ llmConfigured, canManage, orgName }: { llmConfigured: boolean; canManage: boolean; orgName: string }) {
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs]);

  async function ask(question: string) {
    const text = question.trim(); if (!text || busy) return;
    const id = Date.now();
    setMsgs((m) => [...m, { id, role: "user", text }]); setQ(""); setBusy(true);
    try {
      const res = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: text }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setMsgs((m) => [...m, { id: id + 1, role: "assistant", text: "", error: body.error ?? `Request failed (${res.status})` }]);
      else setMsgs((m) => [...m, { id: id + 1, role: "assistant", text: body.answer, answer: body as AssistantAnswer }]);
    } catch (e) { setMsgs((m) => [...m, { id: id + 1, role: "assistant", text: "", error: e instanceof Error ? e.message : "network error" }]); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[520px] flex-col" data-testid="assistant-page">
      <div className="mb-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Ask BridgeBox</h1>
        <p className="mt-1 text-sm text-ink-2">Plain-English answers about {orgName}, built only from your observed data, model and measurements. Every answer lists the evidence it used.</p>
      </div>
      {!llmConfigured && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="assistant-retrieval-banner">
          <Database size={14} />
          <span>Running in <strong>evidence retrieval mode</strong>: questions are matched against your data deterministically. Connect an AI model key in {canManage ? <Link href="/app/settings/integrations" className="underline">Settings → Integrations</Link> : "Settings → Integrations"} (<code>ANTHROPIC_API_KEY</code>) for free-form questions.</span>
        </div>
      )}
      <Card className="flex min-h-0 flex-1 flex-col p-0">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin" data-testid="assistant-thread">
          {msgs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <MessageSquare size={28} className="text-ink-3" />
              <p className="text-sm font-medium">What do you want to know?</p>
              <p className="max-w-md text-xs text-ink-2">Try one of these, or type your own. Numbers come back labelled observed, estimated or assumed, with links to the workflows, people and opportunities behind them.</p>
            </div>
          )}
          {msgs.map((m) => m.role === "user" ? (
            <div key={m.id} className="flex justify-end" data-testid="assistant-msg-user"><div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-4 py-2 text-sm text-white">{m.text}</div></div>
          ) : (
            <div key={m.id} className="flex justify-start" data-testid="assistant-msg-assistant">
              <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm border border-border bg-surface-2 px-4 py-3 text-sm">
                {m.error ? <p className="text-danger" data-testid="assistant-error">{m.error}</p> : <p className="whitespace-pre-wrap leading-relaxed" data-testid="assistant-answer">{m.text}</p>}
                {m.answer && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1" data-testid="assistant-meta">
                    {m.answer.mode === "llm" ? <Badge tone="projected"><Sparkles size={10} className="mr-1" />AI-generated from your evidence</Badge> : <Badge tone="verified"><Database size={10} className="mr-1" />Answered from your evidence</Badge>}
                    {m.answer.citations.map((c) => <Link key={`${c.type}:${c.id}`} href={c.href} className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-2 hover:border-brand hover:text-brand" data-testid={`assistant-citation-${c.type}`}><span className="uppercase text-ink-3">{c.type}</span> {c.label}</Link>)}
                  </div>
                )}
                {m.answer && <p className="text-[11px] text-ink-3">{m.answer.basis.note} Scenario: {m.answer.basis.scenario}.</p>}
              </div>
            </div>
          ))}
          {busy && <div className="flex justify-start"><div className="rounded-2xl border border-border bg-surface-2 px-4 py-2 text-xs text-ink-2" data-testid="assistant-thinking">Looking through your evidence…</div></div>}
          <div ref={endRef} />
        </div>
        <div className="border-t border-border p-3">
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin" data-testid="assistant-suggestions">
            {SUGGESTED.map((s) => <button key={s} onClick={() => ask(s)} disabled={busy} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs text-ink-2 hover:border-brand hover:text-brand disabled:opacity-50" data-testid="assistant-suggestion">{s}</button>)}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about departments, workflows, savings, agents…" maxLength={1000} className={cn("h-10 flex-1 rounded-lg border border-border bg-surface px-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20")} data-testid="assistant-input" aria-label="Your question" />
            <Button type="submit" disabled={!q.trim()} loading={busy} data-testid="assistant-send"><Send size={15} />Ask</Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
