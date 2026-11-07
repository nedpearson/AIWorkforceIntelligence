"use client";
/**
 * "Talk to <name>" — chat with an AI employee. Persists via chatAction (ai_conversations / ai_messages).
 * Voice: SpeechRecognition (feature-detected; mic hidden when unsupported) + speechSynthesis TTS ("AI voice") with mute.
 * Every reply shows the AI Agent badge, its mode (Retrieval / AI model) and citations.
 */
import * as React from "react";
import { Send, Mic, MicOff, Volume2, VolumeX, Play } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";
import { chatAction } from "@/app/app/workforce/actions";
import { AiAvatar, AiBadge, HumanAvatar } from "./avatar";

export type ChatMsg = { id: string; role: string; content: string; mode: string | null; citations: { type: string; id: string; label: string; href?: string }[]; actions: { kind: string; label: string; href?: string; payload?: Record<string, unknown> }[] };
type SR = { start: () => void; stop: () => void; abort: () => void; lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };

export const SUGGESTIONS = ["What can you do for my company?", "What tasks could you take over?", "How much money could you save us?", "Can you demonstrate your work?"];

export function ChatPanel({ employee, initial, conversationId: initialConv, userName, onAction, testid = "chat" }: {
  employee: { id: string; firstName: string; title: string; team: string; portraitUrl: string | null; portraitProvenance: string | null; intro: string };
  initial: ChatMsg[]; conversationId: string | null; userName: string; onAction?: (a: ChatMsg["actions"][number]) => void; testid?: string;
}) {
  const [msgs, setMsgs] = React.useState<ChatMsg[]>(initial);
  const [conv, setConv] = React.useState<string | null>(initialConv);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [muted, setMuted] = React.useState(true);
  const [listening, setListening] = React.useState(false);
  const [srOk, setSrOk] = React.useState(false);
  const [ttsOk, setTtsOk] = React.useState(false);
  const recRef = React.useRef<SR | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    setSrOk(!!(w.SpeechRecognition ?? w.webkitSpeechRecognition));
    setTtsOk("speechSynthesis" in window);
    try { setMuted(localStorage.getItem("bb-ai-voice") !== "on"); } catch { /* ignore */ }
    return () => { recRef.current?.abort(); if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };
  }, []);
  React.useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [msgs.length, busy]);

  const speak = React.useCallback((t: string) => {
    if (muted || !ttsOk) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t.replace(/\[[^\]]+\]/g, "").slice(0, 600)); u.rate = 1.02; window.speechSynthesis.speak(u);
  }, [muted, ttsOk]);

  const send = async (q: string) => {
    const message = q.trim(); if (!message || busy) return;
    setBusy(true); setErr(null); setText("");
    const tmp: ChatMsg = { id: `tmp-${Date.now()}`, role: "user", content: message, mode: null, citations: [], actions: [] };
    setMsgs((m) => [...m, tmp]);
    const r = await chatAction({ aiEmployeeId: employee.id, conversationId: conv, message });
    setBusy(false);
    if (!r.ok) { setErr(r.error); setMsgs((m) => m.filter((x) => x.id !== tmp.id)); setText(message); return; }
    setConv(r.conversationId);
    setMsgs((m) => [...m.filter((x) => x.id !== tmp.id), { ...tmp, id: r.user.id }, { id: r.reply.id, role: "assistant", content: r.reply.content, mode: r.reply.mode, citations: r.reply.citations, actions: r.reply.actions }]);
    speak(r.reply.content);
  };

  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition; if (!C) return;
    const r = new C(); r.lang = "en-US"; r.interimResults = true; r.continuous = false;
    r.onresult = (e) => { const t = Array.from(e.results).map((x) => x[0].transcript).join(" "); setText(t); if (e.results[e.results.length - 1].isFinal) { r.stop(); void send(t); } };
    r.onend = () => setListening(false); r.onerror = (e) => { setListening(false); if (e.error !== "aborted") setErr(`Voice input unavailable (${e.error}).`); };
    recRef.current = r; setListening(true); r.start();
  };
  const toggleMute = () => { const m = !muted; setMuted(m); try { localStorage.setItem("bb-ai-voice", m ? "off" : "on"); } catch { /* ignore */ } if (m && ttsOk) window.speechSynthesis.cancel(); };

  const greeting = msgs.length === 0;
  return (
    <div className="flex h-full min-h-[460px] min-w-0 flex-col" data-testid={testid}>
      <div className="flex items-center gap-3 border-b border-border pb-3">
        <AiAvatar name={employee.firstName} portraitUrl={employee.portraitUrl} provenance={employee.portraitProvenance} team={employee.team} size="sm" />
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm font-bold">{employee.firstName}<AiBadge /></div><div className="truncate text-xs text-ink-2">{employee.title}</div></div>
        {ttsOk && (
          <button onClick={toggleMute} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-ink-2 hover:bg-surface-2" aria-pressed={!muted} data-testid={`${testid}-voice`}>
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}AI voice {muted ? "off" : "on"}
          </button>
        )}
      </div>
      <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto py-4" aria-live="polite" data-testid={`${testid}-messages`}>
        {greeting && (
          <Bubble ai name={employee.firstName} employee={employee} mode={null}>
            <p>{employee.intro}</p>
            <p className="mt-2 text-ink-2">Ask me anything about the work I could do for you. I answer only from your approved company knowledge and BridgeBox data, and I&apos;ll tell you when I don&apos;t know.</p>
          </Bubble>
        )}
        {msgs.map((m) => m.role === "user" ? (
          <div key={m.id} className="flex justify-end gap-2"><div className="max-w-[85%] rounded-2xl rounded-tr-md bg-royal px-3.5 py-2.5 text-sm text-white">{m.content}</div><HumanAvatar name={userName} size="xs" /></div>
        ) : (
          <Bubble key={m.id} ai name={employee.firstName} employee={employee} mode={m.mode}>
            <p className="whitespace-pre-line">{m.content}</p>
            {m.citations.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" data-testid={`${testid}-citations`}><span className="text-[10px] font-semibold uppercase text-ink-3">Sources</span>{m.citations.map((c) => <a key={c.type + c.id} href={c.href ?? "#"} className="rounded-md bg-surface px-2 py-0.5 text-[11px] font-medium text-royal-ink ring-1 ring-border hover:underline">{c.label}</a>)}</div>}
            {m.actions.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{m.actions.map((a, i) => a.href && a.kind === "open" ? <Button key={i} size="sm" variant="secondary" href={a.href}>{a.label}</Button> : <Button key={i} size="sm" variant="gradient" className="h-auto min-h-8 whitespace-normal py-1.5 text-left" onClick={() => onAction?.(a)} data-testid={`${testid}-action-${a.kind}`}><Play size={13} />{a.label}</Button>)}</div>}
          </Bubble>
        ))}
        {busy && <Bubble ai name={employee.firstName} employee={employee} mode={null}><span className="inline-flex gap-1" aria-label="Typing"><span className="live-dot h-2 w-2 rounded-full bg-purple" /><span className="live-dot h-2 w-2 rounded-full bg-purple [animation-delay:.2s]" /><span className="live-dot h-2 w-2 rounded-full bg-purple [animation-delay:.4s]" /></span></Bubble>}
        <div ref={endRef} />
      </div>
      {greeting && <div className="mb-2 flex flex-wrap gap-1.5">{SUGGESTIONS.map((s, i) => <button key={s} onClick={() => send(s)} className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-2 hover:border-purple hover:text-purple-ink" data-testid={`${testid}-suggest-${i}`}>{s}</button>)}</div>}
      {err && <p className="mb-2 rounded-lg bg-coral-soft px-3 py-1.5 text-xs text-coral-ink" role="alert">{err}</p>}
      <form className="flex items-center gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        {srOk && <button type="button" onClick={toggleMic} className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border", listening ? "border-coral bg-coral-soft text-coral-ink" : "border-border text-ink-2 hover:bg-surface-2")} aria-label={listening ? "Stop voice input" : "Speak your question"} aria-pressed={listening} data-testid={`${testid}-mic`}>{listening ? <MicOff size={16} /> : <Mic size={16} />}</button>}
        <label className="sr-only" htmlFor={`${testid}-input`}>Message {employee.firstName}</label>
        <input id={`${testid}-input`} value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? "Listening…" : `Ask ${employee.firstName}…`} maxLength={1500} className="h-9 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm focus:border-purple focus:outline-none" data-testid={`${testid}-input`} />
        <Button type="submit" size="md" variant="gradient" loading={busy} disabled={!text.trim()} aria-label="Send" data-testid={`${testid}-send`}><Send size={15} /></Button>
      </form>
    </div>
  );
}

function Bubble({ children, employee, mode }: { children: React.ReactNode; ai: true; name: string; employee: { firstName: string; team: string; portraitUrl: string | null; portraitProvenance: string | null }; mode: string | null }) {
  return (
    <div className="fade-up flex gap-2">
      <AiAvatar name={employee.firstName} portraitUrl={employee.portraitUrl} provenance={employee.portraitProvenance} team={employee.team} size="xs" />
      <div className="min-w-0 max-w-[88%] break-words rounded-2xl rounded-tl-md border border-purple/20 bg-purple-soft/40 px-3.5 py-2.5 text-sm">
        <div className="mb-1 flex items-center gap-1.5"><AiBadge compact />{mode && <Tooltip text={mode === "llm" ? "Written by the AI model from your approved sources only." : "Deterministic retrieval mode: assembled directly from your approved knowledge and BridgeBox data — no AI model involved."}><span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-ink-2 ring-1 ring-border" data-testid="chat-mode">{mode === "llm" ? "AI model" : "Retrieval mode"}</span></Tooltip>}</div>
        {children}
      </div>
    </div>
  );
}
