/**
 * Deterministic date/time formatting shared by server and client components.
 *
 * Server components render in the server's time zone (UTC on Vercel and CI) while the browser hydrates in the
 * viewer's zone, so `toLocaleString()` without an explicit `timeZone` produces different text on each side → React
 * hydration error #418 → React re-renders from the root (dropping the `data-theme` the inline theme script set).
 * Every rendered timestamp therefore goes through these helpers with an explicit zone: the organization's
 * `organizations.timezone` (DEFAULT_TIME_ZONE when unknown) for instants, "UTC" for calendar dates stored as
 * UTC midnight (month keys, due dates). Locale is pinned to en-US for the same reason.
 * Pure: no server or React imports.
 */
export const DEFAULT_TIME_ZONE = "America/Chicago";
const LOCALE = "en-US";

type When = string | number | Date;

function zone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIME_ZONE;
  try { new Intl.DateTimeFormat(LOCALE, { timeZone: tz }); return tz; } catch { return DEFAULT_TIME_ZONE; }
}

/** Same output as `toLocaleString("en-US", opts)` but in `tz`. Default: "11/7/2026, 10:44:17 AM". */
export function formatDateTime(v: When, tz: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Date(v).toLocaleString(LOCALE, { ...opts, timeZone: zone(tz) });
}
/** Same output as `toLocaleDateString("en-US", opts)` but in `tz`. Default: "11/7/2026". */
export function formatDate(v: When, tz: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Date(v).toLocaleDateString(LOCALE, { ...opts, timeZone: zone(tz) });
}
/** Same output as `toLocaleTimeString("en-US", opts)` but in `tz`. Default: "10:44:17 AM". */
export function formatTime(v: When, tz: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Date(v).toLocaleTimeString(LOCALE, { ...opts, timeZone: zone(tz) });
}
/** Locale-pinned integer/decimal formatting (`n.toLocaleString()` depends on the runtime's default locale). */
export function formatCount(n: number, maximumFractionDigits = 0): string {
  return n.toLocaleString(LOCALE, { maximumFractionDigits });
}
