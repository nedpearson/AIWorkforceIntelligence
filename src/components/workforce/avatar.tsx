"use client";
/**
 * Visual identity for the AI Workforce. AI and humans are always distinct by SHAPE + BADGE (not color alone):
 *  - AI employee: rounded-square portrait/monogram + "AI" glyph; AI-generated portraits carry a caption/tooltip.
 *  - Human: circle photo (only with recorded consent) or initials.
 */
import * as React from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export type TeamAccent = "indigo" | "emerald" | "gold" | "cyan" | "purple" | "royal" | "coral";
export const TEAM_ACCENT: Record<string, TeamAccent> = { executive: "indigo", finance: "emerald", sales: "gold", operations: "cyan", marketing: "purple", hr: "royal", customer_service: "coral", custom: "purple" };
export const TEAM_LABEL: Record<string, string> = { executive: "Executive AI Team", finance: "Finance AI Team", sales: "Sales AI Team", operations: "Operations AI Team", marketing: "Marketing AI Team", hr: "People & HR AI Team", customer_service: "Customer Service AI Team", custom: "Custom AI Team" };
export const GRADIENT: Record<TeamAccent, string> = {
  indigo: "from-indigo via-purple to-midnight", emerald: "from-emerald via-cyan to-midnight", gold: "from-gold via-coral to-midnight", cyan: "from-cyan via-royal to-midnight",
  purple: "from-purple via-indigo to-midnight", royal: "from-royal via-indigo to-midnight", coral: "from-coral via-purple to-midnight",
};
export const TILE: Record<TeamAccent, string> = { indigo: "bg-indigo-soft text-indigo-ink", emerald: "bg-emerald-soft text-emerald-ink", gold: "bg-gold-soft text-gold-ink", cyan: "bg-cyan-soft text-cyan-ink", purple: "bg-purple-soft text-purple-ink", royal: "bg-royal-soft text-royal-ink", coral: "bg-coral-soft text-coral-ink" };
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function AiBadge({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full bg-purple-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-purple-ink ring-1 ring-purple/30", className)} data-testid="ai-badge">
      <Bot size={11} aria-hidden />{compact ? "AI" : "AI Agent"}
    </span>
  );
}

const SIZES = { xs: "h-8 w-8 text-[11px] rounded-lg", sm: "h-11 w-11 text-sm rounded-xl", md: "h-16 w-16 text-lg rounded-2xl", lg: "h-28 w-28 text-3xl rounded-[26px]", xl: "h-40 w-40 text-5xl rounded-[32px] sm:h-48 sm:w-48" } as const;

/** AI employee avatar: rounded square, portrait or premium monogram, always with an AI glyph. */
export function AiAvatar({ name, portraitUrl, provenance, team, size = "md", className, caption }: { name: string; portraitUrl?: string | null; provenance?: string | null; team: string; size?: keyof typeof SIZES; className?: string; caption?: boolean }) {
  const accent = TEAM_ACCENT[team] ?? "purple";
  const [broken, setBroken] = React.useState(false);
  const showImg = !!portraitUrl && !broken;
  const provLabel = provenance === "licensed" ? "Licensed portrait of an AI agent" : "AI-generated portrait";
  return (
    <span className={cn("inline-flex flex-col items-center", className)}>
      <span className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br font-display font-bold text-white shadow-[var(--shadow-card)] ring-2 ring-white/70 dark:ring-white/10", GRADIENT[accent], SIZES[size])}
        role="img" aria-label={`${name}, AI agent${showImg ? ` — ${provLabel}` : ""}`} title={showImg ? provLabel : `${name} — AI agent (monogram)`}>
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={portraitUrl!} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} loading="lazy" />
        ) : (
          <>
            <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,.35),transparent_55%)]" />
            <span className="relative tracking-tight">{initialsOf(name)}</span>
          </>
        )}
        <span className={cn("absolute bottom-1 right-1 inline-flex items-center justify-center rounded-md bg-midnight/80 font-bold text-white ring-1 ring-white/30", size === "xs" ? "h-3.5 px-0.5 text-[7px]" : size === "sm" ? "h-4 px-1 text-[8px]" : "h-5 px-1.5 text-[9px]")} aria-hidden>AI</span>
      </span>
      {caption && showImg && <span className="mt-1 text-[10px] font-medium text-ink-3" data-testid="portrait-caption">{provLabel}</span>}
    </span>
  );
}

/** Human avatar: circle; photo only when provided (consented), otherwise initials. */
export function HumanAvatar({ name, photoUrl, size = "sm", className }: { name: string; photoUrl?: string | null; size?: "xs" | "sm" | "md"; className?: string }) {
  const s = size === "xs" ? "h-8 w-8 text-[11px]" : size === "sm" ? "h-11 w-11 text-sm" : "h-16 w-16 text-lg";
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 font-semibold text-ink-2 ring-2 ring-border", s, className)} role="img" aria-label={`${name} (person)`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {photoUrl ? <img src={photoUrl} alt="" className="h-full w-full object-cover" /> : initialsOf(name)}
    </span>
  );
}
