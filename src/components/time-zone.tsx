"use client";
import * as React from "react";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";

/**
 * The active organization's IANA time zone (organizations.timezone), provided by AppShell / AdminShell so client
 * components format timestamps identically on the server render and on hydration (see src/lib/datetime.ts).
 */
const TimeZoneContext = React.createContext<string>(DEFAULT_TIME_ZONE);
export function TimeZoneProvider({ timeZone, children }: { timeZone: string | null | undefined; children: React.ReactNode }) {
  return <TimeZoneContext.Provider value={timeZone || DEFAULT_TIME_ZONE}>{children}</TimeZoneContext.Provider>;
}
export const useTimeZone = () => React.useContext(TimeZoneContext);

/**
 * Leaf `<time>` for text that is intentionally relative to the viewer's clock ("5 min ago"): the server and the
 * browser compute it at different instants, so a one-minute boundary between them is expected and suppressed here
 * (only on this leaf). Absolute timestamps must use the formatters in src/lib/datetime.ts instead.
 */
export function ViewerTime({ dateTime, className, title, children }: { dateTime: string; className?: string; title?: string; children: React.ReactNode }) {
  return <time dateTime={dateTime} className={className} title={title} suppressHydrationWarning>{children}</time>;
}
