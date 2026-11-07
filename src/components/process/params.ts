/** Server-safe URL param helpers for the Business Intelligence / Process Mining pages. */
const UUID = /^[0-9a-f-]{36}$/i;
/** Only accept uuid-shaped ids from the URL; anything else is ignored. */
export const idParam = (v?: string | string[]) => (typeof v === "string" && UUID.test(v) ? v : null);

/** Parse YYYY-MM-DD URL params to a [from, to) window (to is inclusive of its whole day). */
export function parseDateRange(from?: string, to?: string): { from: Date | null; to: Date | null } {
  const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
  const f = ok(from) ? new Date(`${from}T00:00:00Z`) : null;
  const t = ok(to) ? new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000) : null;
  return { from: f, to: t };
}
