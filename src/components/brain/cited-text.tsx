"use client";
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** Renders answer text with inline [n] markers as numbered citation chips linking to their sources. */
export function CitedText({ text, citations, className, onCite }: { text: string; citations: { n?: number; label: string; href?: string }[]; className?: string; onCite?: (n: number) => void }) {
  const paras = text.split(/\n{2,}/);
  return (
    <div className={cn("space-y-2", className)}>
      {paras.map((para, pi) => (
        <p key={pi} className="whitespace-pre-line">
          {para.split(/(\[\d{1,2}\])/g).map((part, i) => {
            const m = part.match(/^\[(\d{1,2})\]$/);
            if (!m) return <React.Fragment key={i}>{part}</React.Fragment>;
            const n = Number(m[1]); const c = citations.find((x) => x.n === n) ?? citations[n - 1];
            const chip = <span className="mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-purple-soft px-1 align-text-top text-[10px] font-bold text-purple-ink">{n}</span>;
            if (onCite) return <button key={i} type="button" onClick={() => onCite(n)} aria-label={`Source ${n}: ${c?.label ?? ""}`} title={c?.label} data-testid={`cite-${n}`}>{chip}</button>;
            return c?.href ? <Link key={i} href={c.href} aria-label={`Source ${n}: ${c.label}`} title={c.label}>{chip}</Link> : <span key={i} title={c?.label}>{chip}</span>;
          })}
        </p>
      ))}
    </div>
  );
}

export function ModeBadge({ mode }: { mode: "retrieval" | "llm" | string | null | undefined }) {
  const llm = mode === "llm";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", llm ? "bg-purple-soft text-purple-ink" : "bg-cyan-soft text-cyan-ink")} title={llm ? "Written by Claude from your approved data (retrieved text isolated as untrusted)" : "Retrieval mode: assembled directly from your approved data — no AI model was used"} data-testid="mode-badge">
      {llm ? "AI model" : "Retrieval mode"}
    </span>
  );
}
