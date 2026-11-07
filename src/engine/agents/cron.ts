/**
 * Minimal 5-field cron parser (minute hour day-of-month month day-of-week) for showing an agent's schedule and
 * its next run time. Supports `*`, numbers, lists `a,b`, ranges `a-b`, steps `*\/n` and `a-b/n`, and 0/7 = Sunday.
 * Standard cron semantics: when both day-of-month and day-of-week are restricted, a day matches if EITHER matches.
 * Times are evaluated in the given IANA time zone (default the org's, else UTC). Pure — no DB, no dependencies.
 */
export type CronSpec = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean; source: string };

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(raw: string, idx: number): Set<number> {
  const [lo, hi] = RANGES[idx];
  const out = new Set<number>();
  const val = (t: string) => {
    const l = t.toLowerCase();
    if (idx === 3 && MONTHS.includes(l)) return MONTHS.indexOf(l) + 1;
    if (idx === 4 && DAYS.includes(l)) return DAYS.indexOf(l);
    if (!/^\d+$/.test(t)) throw new Error(`invalid value "${t}"`);
    const n = Number(t); if (n < lo || n > hi) throw new Error(`value ${n} out of range ${lo}-${hi}`);
    return n;
  };
  for (const part of raw.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS == null ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step "${stepS}"`);
    let a: number, b: number;
    if (range === "*") { a = lo; b = hi; }
    else if (range.includes("-")) { const [x, y] = range.split("-"); a = val(x); b = val(y); if (a > b) throw new Error(`invalid range "${range}"`); }
    else { a = val(range); b = stepS == null ? a : hi; }
    for (let i = a; i <= b; i += step) out.add(idx === 4 && i === 7 ? 0 : i);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields: minute hour day-of-month month day-of-week");
  const f = parts.map((p, i) => parseField(p, i));
  return { minute: f[0], hour: f[1], dom: f[2], month: f[3], dow: f[4], domStar: parts[2] === "*", dowStar: parts[4] === "*", source: expr.trim() };
}

export function isValidCron(expr: string): boolean { try { parseCron(expr); return true; } catch { return false; } }

/** Wall-clock parts of `d` in `tz`. */
function partsIn(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const p: Record<string, string> = {}; for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, dow: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}

function matches(spec: CronSpec, d: Date, tz: string): boolean {
  const p = partsIn(d, tz);
  if (!spec.minute.has(p.minute) || !spec.hour.has(p.hour) || !spec.month.has(p.month)) return false;
  const domOk = spec.dom.has(p.day), dowOk = spec.dow.has(p.dow);
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk;
}

/** Next fire time strictly after `from`. Scans minute by minute (skipping non-matching hours) up to ~1 year. */
export function nextRun(expr: string, from: Date = new Date(), tz = "UTC"): Date | null {
  const spec = parseCron(expr);
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 366 * 86_400_000;
  while (t < limit) {
    const d = new Date(t);
    const p = partsIn(d, tz);
    if (!spec.month.has(p.month) || !spec.hour.has(p.hour)) { t += (60 - p.minute) * 60_000; continue; }
    if (matches(spec, d, tz)) return d;
    t += 60_000;
  }
  return null;
}

/** Plain-English description of common shapes; falls back to the expression. */
export function describeCron(expr: string): string {
  let s: CronSpec; try { s = parseCron(expr); } catch (e) { return `Invalid schedule (${e instanceof Error ? e.message : String(e)})`; }
  const one = (x: Set<number>) => (x.size === 1 ? [...x][0] : null);
  const m = one(s.minute), h = one(s.hour);
  const time = m != null && h != null ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : null;
  const allMonths = s.month.size === 12;
  if (time && s.domStar && s.dowStar && allMonths) return `Every day at ${time}`;
  if (time && s.domStar && !s.dowStar && allMonths) {
    const days = [...s.dow].sort();
    if (days.join() === "1,2,3,4,5") return `Weekdays at ${time}`;
    return `Every ${days.map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1)).join(", ")} at ${time}`;
  }
  if (time && !s.domStar && s.dowStar && allMonths) return `Day ${[...s.dom].sort((a, b) => a - b).join(", ")} of each month at ${time}`;
  if (m != null && s.hour.size === 24 && s.domStar && s.dowStar) return `Every hour at :${String(m).padStart(2, "0")}`;
  return `Cron ${s.source}`;
}
