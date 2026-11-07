/**
 * Hydration determinism for rendered dates (CI run 42389504107): the server renders in UTC (Vercel, GitHub runner)
 * while the browser hydrates in the viewer's zone, so any timestamp formatted without an explicit time zone differs
 * between the two renders → React #418 → the root is client-rendered and <html data-theme> is lost.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { formatDate, formatDateTime, formatTime, formatCount, DEFAULT_TIME_ZONE } from "@/lib/datetime";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { process.env.TZ = ORIGINAL_TZ; });

describe("src/lib/datetime formatters", () => {
  const at = "2026-11-07T16:44:17Z";
  it("give the same text whatever the process time zone is", () => {
    const out = ["UTC", "America/Chicago", "Pacific/Kiritimati", "Asia/Kolkata"].map((tz) => {
      process.env.TZ = tz;
      return [formatDateTime(at, "America/Chicago"), formatDate(at, "America/Chicago", { dateStyle: "medium" }), formatTime(at, "America/Chicago"), formatCount(1234567)].join(" | ");
    });
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toBe("11/7/2026, 10:44:17 AM | Nov 7, 2026 | 10:44:17 AM | 1,234,567");
  });
  it("format in the organization's zone, and UTC for UTC-midnight calendar dates", () => {
    expect(formatDateTime(at, "UTC", { dateStyle: "medium", timeStyle: "short" })).toBe("Nov 7, 2026, 4:44 PM");
    expect(formatDate("2026-06-01T00:00:00Z", "UTC")).toBe("6/1/2026");
    expect(formatDate("2026-06-01T00:00:00Z", "America/Chicago")).toBe("5/31/2026");
  });
  it("fall back to the default zone for a missing or unknown zone", () => {
    expect(formatTime(at, null)).toBe(formatTime(at, DEFAULT_TIME_ZONE));
    expect(formatTime(at, "Not/AZone")).toBe(formatTime(at, DEFAULT_TIME_ZONE));
  });
});

describe("rendered UI code formats dates deterministically", () => {
  // Server and client components: every Date → text conversion must name its zone (use src/lib/datetime.ts).
  const roots = ["src/app", "src/components"].map((r) => path.join(__dirname, "..", "..", r));
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(e.name)) files.push(p); } };
  roots.forEach(walk);
  it("has no toLocale*String / Intl.DateTimeFormat call on a date without an explicit timeZone, and no default-locale toLocaleString()", () => {
    const bad: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const where = `${path.relative(path.join(__dirname, "..", ".."), f)}:${i + 1}`;
        for (const m of line.matchAll(/toLocale(Date|Time)String\(([^)]*)\)/g)) if (!/timeZone/.test(m[2])) bad.push(`${where} ${m[0]}`);
        for (const m of line.matchAll(/new Date\([^)]*\)\.toLocaleString\(([^)]*)\)/g)) if (!/timeZone/.test(m[1])) bad.push(`${where} ${m[0]}`);
        for (const m of line.matchAll(/toLocaleString\(\s*(\[\]|undefined)?\s*\)/g)) bad.push(`${where} ${m[0]}`);
        for (const m of line.matchAll(/Intl\.DateTimeFormat\(([^)]*)\)/g)) if (!/timeZone/.test(m[1])) bad.push(`${where} ${m[0]}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
