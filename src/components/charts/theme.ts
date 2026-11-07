/**
 * Chart colors come from the CSS tokens in src/app/globals.css so light/dark mode and org branding
 * flow through automatically. Projected = purple, Verified = teal, everywhere.
 * SVG `fill`/`stroke` accept `var(--token)` strings, so these are passed straight to Recharts.
 */
export const C = {
  brand: "var(--color-brand)",
  brand2: "var(--color-brand-2)",
  money: "var(--color-money)",
  projected: "var(--color-projected)",
  projectedSoft: "var(--color-projected-soft)",
  verified: "var(--color-verified)",
  verifiedSoft: "var(--color-verified-soft)",
  warn: "var(--color-warn)",
  info: "var(--color-info)",
  danger: "var(--color-danger)",
  ink: "var(--color-ink)",
  ink2: "var(--color-ink-2)",
  ink3: "var(--color-ink-3)",
  border: "var(--color-border)",
  surface: "var(--color-surface)",
  surface2: "var(--color-surface-2)",
} as const;

/** Recessive axis styling shared by every chart. */
export const axisProps = { tick: { fill: C.ink2, fontSize: 11 }, axisLine: { stroke: C.border }, tickLine: false as const };
export const gridProps = { stroke: C.border, strokeDasharray: undefined, vertical: false };

export const compactUSD = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);
export const compactNum = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
