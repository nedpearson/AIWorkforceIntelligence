"use client";
/**
 * Universal AI assistant — floating launcher + slide-over chat, available on every /app page.
 * Opens with "/" (outside text fields), Ctrl/⌘+K, the launcher, or window event `bb:assistant` ({ detail: { question? } }).
 * Answers come from POST /api/assistant (universal: evidence pack + AI Brain + intent routing); suggested actions are executed
 * only through POST /api/assistant/action (server allow-list + permission check). Voice input/output are feature-detected.
 */
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sparkles, X, Send, Mic, MicOff, Volume2, VolumeX, ArrowRight, Play, UserPlus, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { CitedText, ModeBadge } from "@/components/brain/cited-text";
import { SUGGESTED_QUESTIONS } from "@/engine/brain/assistant-suggestions";

type Action = { kind: string; label: string; href?: string; payload?: Record<string, unknown> };
type Cite = { type: string; id: string; label: string; href?: string; n?: number };
type Msg = { role: "user" | "assistant"; content: string; mode?: string | null; citations?: Cite[]; actions?: Action[]; intent?: string; pending?: boolean; error?: boolean };


type SR = { start(): void; stop(): void; lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
function speechRecognition(): (new () => SR) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  // The app's Permissions-Policy may block the microphone; respect it instead of failing at runtime.
  const fp = (document as unknown as { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
  if (Ctor && fp && !fp.allowsFeature("microphone")) return null;
  return Ctor;
}
const speakable = (s: string) => s.replace(/\[\d{1,2}\]/g, "").replace(/\s+/g, " ").slice(0, 1200);

export function AssistantPanel({ enabled: allowed }: { enabled: boolean }) {
  const router = useRouter();
  // /app/assistant IS the full-page assistant: no floating launcher there (it covered the page's Send button) and no
  // second panel with the same controls.
  const pathname = usePathname();
  const enabled = allowed && pathname !== "/app/assistant";
  const [open, setOpen] = React.useState(false);
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [q, setQ] = React.useState(""); const [busy, setBusy] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [voiceOut, setVoiceOut] = React.useState(false); const [listening, setListening] = React.useState(false);
  const [canListen, setCanListen] = React.useState(false); const [canSpeak, setCanSpeak] = React.useState(false);
  const [actionMsg, setActionMsg] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null); const listRef = React.useRef<HTMLDivElement>(null); const recRef = React.useRef<SR | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null); const lastFocus = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => { setCanListen(!!speechRecognition()); setCanSpeak(typeof window !== "undefined" && "speechSynthesis" in window); try { setVoiceOut(localStorage.getItem("bb-assistant-voice") === "1"); } catch {} }, []);
  const openPanel = React.useCallback((question?: string) => { lastFocus.current = document.activeElement as HTMLElement | null; setOpen(true); if (question) setTimeout(() => ask(question), 0); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const closePanel = React.useCallback(() => { setOpen(false); recRef.current?.stop(); if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel(); lastFocus.current?.focus?.(); }, []);

  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setOpen((o) => { if (!o) lastFocus.current = document.activeElement as HTMLElement | null; return !o; }); }
      else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openPanel(); }
      else if (e.key === "Escape" && open) closePanel();
    };
    const onEvt = (e: Event) => openPanel((e as CustomEvent<{ question?: string }>).detail?.question);
    window.addEventListener("keydown", onKey); window.addEventListener("bb:assistant", onEvt);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("bb:assistant", onEvt); };
  }, [enabled, open, openPanel, closePanel]);

  React.useEffect(() => {
    if (!open) return; setTimeout(() => inputRef.current?.focus(), 30);
    if (!loaded) { setLoaded(true); fetch("/api/assistant").then((r) => (r.ok ? r.json() : null)).then((j: { conversation?: { id: string; messages: Msg[] } | null } | null) => { if (j?.conversation) { setConversationId(j.conversation.id); setMsgs((m) => (m.length ? m : j.conversation!.messages.slice(-12))); } }).catch(() => {}); }
  }, [open, loaded]);
  React.useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [msgs]);

  const speak = (text: string) => { if (!voiceOut || !canSpeak) return; try { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(speakable(text)); u.rate = 1.02; window.speechSynthesis.speak(u); } catch {} };

  async function ask(text = q) {
    const question = text.trim(); if (question.length < 2 || busy) return;
    setQ(""); setBusy(true); setActionMsg(null);
    setMsgs((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "", pending: true }]);
    try {
      const res = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, universal: true, conversationId }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setConversationId(j.conversationId ?? conversationId);
      setMsgs((m) => [...m.slice(0, -1), { role: "assistant", content: j.answer, mode: j.mode, citations: j.citations, actions: j.actions, intent: j.intent }]);
      speak(j.answer);
    } catch (e) {
      setMsgs((m) => [...m.slice(0, -1), { role: "assistant", content: `I couldn't answer that: ${e instanceof Error ? e.message : "request failed"}.`, error: true }]);
    } finally { setBusy(false); }
  }

  async function runAction(a: Action) {
    setActionMsg(null);
    const res = await fetch("/api/assistant/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: a.kind, href: a.href, payload: a.payload }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setActionMsg(j.error ?? "That action isn't allowed."); return; }
    if (j.message) setActionMsg(j.message);
    if (j.href) { router.push(j.href); if (a.kind !== "provision_persona") setOpen(false); }
  }

  function toggleMic() {
    const Ctor = speechRecognition(); if (!Ctor) return;
    if (listening) { recRef.current?.stop(); return; }
    const r = new Ctor(); r.lang = "en-US"; r.interimResults = false;
    r.onresult = (e) => { const t = Array.from(e.results).map((x) => x[0]?.transcript ?? "").join(" ").trim(); if (t) { setQ(t); ask(t); } };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    recRef.current = r; setListening(true); try { r.start(); } catch { setListening(false); }
  }

  // focus trap inside the open panel
  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const f = panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, a[href], [tabindex]:not([tabindex='-1'])");
    if (!f.length) return; const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (!enabled) return null;
  const lastAnswer = [...msgs].reverse().find((m) => m.role === "assistant" && !m.pending && !m.error);
  return (
    <>
      {!open && (
        <button onClick={() => openPanel()} className="no-print fixed bottom-4 right-4 z-40 flex h-12 items-center gap-2 rounded-full bg-[linear-gradient(135deg,#6366f1,#8b5cf6)] pl-3.5 pr-4 text-sm font-semibold text-white shadow-[0_12px_30px_-10px_rgba(139,92,246,.9)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple/40 sm:bottom-6 sm:right-6"
          title="Open the AI assistant (press / or Ctrl+K)" data-testid="assistant-launcher" aria-keyshortcuts="/ Control+K">
          {/* accessible name = the visible "Ask AI" (WCAG 2.5.3 label in name); the shortcut hint is decorative */}
          <Sparkles size={18} aria-hidden /><span className="sr-only sm:not-sr-only">Ask AI</span><kbd className="hidden rounded bg-white/20 px-1.5 text-[10px] font-bold sm:inline" aria-hidden>/</kbd>
        </button>
      )}
      {open && <div className="no-print fixed inset-0 z-[55] bg-midnight/30 backdrop-blur-[1px]" onClick={closePanel} aria-hidden />}
      {open && (
        <div ref={panelRef} onKeyDown={onPanelKey} role="dialog" aria-modal="true" aria-labelledby="assistant-title" data-testid="assistant-panel"
          className="no-print fade-up fixed inset-x-0 bottom-0 z-[56] flex h-[88vh] flex-col rounded-t-[22px] border border-border bg-surface shadow-[var(--shadow-pop)] sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-4 sm:h-auto sm:w-[420px] sm:rounded-[22px]">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#6366f1,#8b5cf6)] text-white"><Bot size={18} /></span>
            <div className="min-w-0 flex-1">
              <h2 id="assistant-title" className="flex items-center gap-1.5 text-sm font-bold">BridgeBox Assistant <span className="rounded-md bg-purple-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-ink">AI</span></h2>
              <div className="flex items-center gap-1.5 text-[11px] text-ink-3">{lastAnswer ? <ModeBadge mode={lastAnswer.mode} /> : <span>Answers from your data, with sources</span>}</div>
            </div>
            {canSpeak && <button onClick={() => { const v = !voiceOut; setVoiceOut(v); try { localStorage.setItem("bb-assistant-voice", v ? "1" : "0"); } catch {} if (!v) window.speechSynthesis.cancel(); }} className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-pressed={voiceOut} aria-label={voiceOut ? "Turn off spoken answers" : "Read answers aloud"} data-testid="assistant-voice-out">{voiceOut ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>}
            <button onClick={closePanel} className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Close assistant" data-testid="assistant-close"><X size={18} /></button>
          </div>
          <div ref={listRef} className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite" data-testid="assistant-messages">
            {!msgs.length && (
              <div>
                <p className="text-sm text-ink-2">Ask anything about your business, your AI team or your company&apos;s approved knowledge. I&apos;ll cite where every answer comes from.</p>
                <div className="mt-3 grid gap-1.5" data-testid="assistant-suggestions">
                  {SUGGESTED_QUESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-left text-[13px] font-medium hover:border-purple hover:bg-purple-soft/40" data-testid="assistant-suggestion">{s}<ArrowRight size={14} className="shrink-0 text-ink-3" /></button>)}
                </div>
              </div>
            )}
            {msgs.map((m, i) => m.role === "user" ? (
              <div key={i} className="ml-8 rounded-2xl rounded-br-md bg-royal px-3.5 py-2 text-sm text-white">{m.content}</div>
            ) : (
              <div key={i} className={cn("mr-4 rounded-2xl rounded-bl-md border border-border bg-surface-2/60 px-3.5 py-2.5 text-sm", m.error && "border-coral/40")} data-testid="assistant-answer">
                {m.pending ? <div className="flex gap-1 py-1" aria-label="Thinking"><span className="h-2 w-2 animate-bounce rounded-full bg-purple" /><span className="h-2 w-2 animate-bounce rounded-full bg-purple [animation-delay:.1s]" /><span className="h-2 w-2 animate-bounce rounded-full bg-purple [animation-delay:.2s]" /></div> : <>
                  <CitedText text={m.content} citations={(m.citations ?? []).filter((c) => c.n != null)} className="leading-relaxed" />
                  {!!m.citations?.length && <div className="mt-2 flex flex-wrap gap-1">{m.citations.slice(0, 6).map((c) => <a key={c.type + c.id} href={c.href} className="rounded-md bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-royal-ink ring-1 ring-border hover:underline" data-testid="assistant-citation">{c.n ? `[${c.n}] ` : ""}{c.label}</a>)}</div>}
                  {!!m.actions?.length && <div className="mt-2.5 flex flex-wrap gap-1.5">{m.actions.map((a) => (
                    <button key={a.kind + a.label} onClick={() => runAction(a)} className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold", a.kind === "provision_persona" ? "bg-purple text-white hover:brightness-110" : "bg-royal-soft text-royal-ink hover:brightness-95")} data-testid={`assistant-action-${a.kind}`}>
                      {a.kind === "open_demo" ? <Play size={12} /> : a.kind === "provision_persona" ? <UserPlus size={12} /> : <ArrowRight size={12} />}{a.label}
                    </button>))}</div>}
                </>}
              </div>
            ))}
            {actionMsg && <p className="text-xs font-semibold text-ink-2" role="status" data-testid="assistant-action-msg">{actionMsg}</p>}
          </div>
          <form className="flex items-center gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); ask(); }}>
            {canListen && <button type="button" onClick={toggleMic} className={cn("rounded-xl border border-border p-2.5", listening ? "bg-coral-soft text-coral-ink" : "text-ink-2 hover:bg-surface-2")} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Ask by voice"} data-testid="assistant-mic">{listening ? <MicOff size={16} /> : <Mic size={16} />}</button>}
            <label htmlFor="assistant-input" className="sr-only">Ask the assistant</label>
            <input id="assistant-input" ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} maxLength={1000} placeholder="Ask about your business…" className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm focus:border-purple focus:outline-none focus:ring-2 focus:ring-purple/20" data-testid="assistant-input" />
            <button type="submit" disabled={busy || q.trim().length < 2} className="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#6366f1,#8b5cf6)] text-white disabled:opacity-50" aria-label="Send" data-testid="assistant-send"><Send size={16} /></button>
          </form>
        </div>
      )}
    </>
  );
}
