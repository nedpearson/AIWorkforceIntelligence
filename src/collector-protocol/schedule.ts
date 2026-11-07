/**
 * Observation-window helper shared by the server (drop events outside windows) and the
 * collector (sleep outside windows). Pure, timezone-aware via Intl, no dependencies.
 */
export type Schedule = { days: number[]; start: string; end: string; tz?: string };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" }); }
    catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" }); }
    fmtCache.set(tz, f);
  }
  return f;
}
const DAY_IDX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Returns { day: 0..6, minutes: minutes since local midnight } for `d` in `tz`. */
export function localParts(d: Date, tz: string): { day: number; minutes: number } {
  const parts = fmt(tz).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24; // some engines emit "24" for midnight
  return { day: DAY_IDX[get("weekday")] ?? 0, minutes: hour * 60 + Number(get("minute")) };
}
export function parseHHMM(s: string): number { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); }

/** True when `d` falls inside the schedule (inclusive start, exclusive end). No schedule = always inside. */
export function inSchedule(d: Date, schedule: Schedule | undefined | null, defaultTz = "UTC"): boolean {
  if (!schedule) return true;
  const { day, minutes } = localParts(d, schedule.tz || defaultTz);
  if (schedule.days.length && !schedule.days.includes(day)) return false;
  const s = parseHHMM(schedule.start), e = parseHHMM(schedule.end);
  if (s === e) return true;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e; // overnight window
}

/** True when `d` is within the campaign's date range (null bounds are open). */
export function inDateRange(d: Date, startsAt: Date | string | null | undefined, endsAt: Date | string | null | undefined): boolean {
  const t = d.getTime();
  if (startsAt && t < new Date(startsAt).getTime()) return false;
  if (endsAt && t > new Date(endsAt).getTime()) return false;
  return true;
}
