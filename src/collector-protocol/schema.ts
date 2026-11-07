/**
 * Collector <-> server wire protocol. Shared by the Next.js ingest routes and the standalone
 * desktop collector (collector/). Keep this file dependency-free except for zod so the collector
 * can import it directly (collector/tsconfig.json maps it in).
 *
 * PRIVACY CONTRACT: the protocol has no field that can carry window titles, URLs, keystrokes,
 * clipboard contents, screenshots or message bodies. `meta` is a flat map of numbers/strings/
 * booleans; keys that look like they could carry content are rejected at the schema level.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const MAX_EVENTS_PER_BATCH = 5000;

export const EVENT_TYPES = [
  "app_focus", "app_switch", "idle_start", "idle_end", "click_burst", "navigation", "data_entry",
  "copy_paste", "document_open", "document_save", "form_submit", "print", "email_compose", "handoff",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const PLATFORMS = ["windows", "macos", "linux", "simulated"] as const;

/** Meta keys that must never appear — they would imply content capture. Matched as substrings, case-insensitive. */
export const FORBIDDEN_META_KEY_FRAGMENTS = ["key", "text", "title", "url", "content", "clipboard", "password", "screenshot", "body", "message", "subject", "filename", "path"] as const;
/** Explicit allow-list exceptions to the fragment rule (counts only, never contents). */
export const ALLOWED_META_KEYS = new Set(["keysCount"]);

export function isForbiddenMetaKey(key: string): boolean {
  if (ALLOWED_META_KEYS.has(key)) return false;
  const k = key.toLowerCase();
  return FORBIDDEN_META_KEY_FRAGMENTS.some((f) => k.includes(f));
}

const metaValue = z.union([z.number().finite(), z.string().max(64), z.boolean()]);
export const MetaSchema = z.record(z.string().min(1).max(40), metaValue)
  .refine((m) => Object.keys(m).length <= 32, { message: "meta: too many keys (max 32)" })
  .refine((m) => !Object.keys(m).some(isForbiddenMetaKey), { message: "meta: key would carry content (keys/text/title/url/content/clipboard are forbidden; keysCount is the only allowed count)" });

export const CollectorConfigSchema = z.object({
  sampleIntervalMs: z.number().int().min(250).max(60_000).optional(),
  batchIntervalMs: z.number().int().min(5_000).max(600_000).optional(),
  idleThresholdSec: z.number().int().min(30).max(3600).optional(),
  schedule: z.object({ days: z.array(z.number().int().min(0).max(6)), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().optional() }).optional(),
  blockedApps: z.array(z.string().max(80)).max(200).optional(),
  titleMode: z.enum(["hash", "category", "none"]).optional(),
});
export type CollectorConfig = z.infer<typeof CollectorConfigSchema>;

export const EnrollRequest = z.object({
  enrollmentCode: z.string().min(8).max(128),
  platform: z.enum(PLATFORMS),
  hostname: z.string().min(1).max(255),
  version: z.string().min(1).max(32),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const NoticeSchema = z.object({ version: z.string(), text: z.string() });
export const EnrollResponse = z.object({
  collectorId: z.string().uuid(),
  token: z.string(),
  config: CollectorConfigSchema,
  notice: NoticeSchema,
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

export const WireEvent = z.object({
  ts: z.string().datetime({ offset: true }),
  type: z.enum(EVENT_TYPES),
  app: z.string().max(80),
  appCategory: z.string().max(40).optional(),
  titleCategory: z.string().max(40).optional(),
  titleHash: z.string().max(64).optional(),
  durationMs: z.number().int().min(0).max(24 * 3600 * 1000),
  meta: MetaSchema.optional(),
});
export type WireEvent = z.infer<typeof WireEvent>;

export const EventBatch = z.object({
  collectorId: z.string().uuid(),
  events: z.array(WireEvent).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type EventBatch = z.infer<typeof EventBatch>;

export const EventBatchResponse = z.object({
  accepted: z.number().int(),
  dropped: z.number().int(),
  reasons: z.record(z.string(), z.number().int()),
});
export type EventBatchResponse = z.infer<typeof EventBatchResponse>;

export const Heartbeat = z.object({
  collectorId: z.string().uuid(),
  version: z.string().min(1).max(32),
  status: z.enum(["running", "paused", "outside_schedule", "stopping"]),
  pausedUntil: z.string().datetime({ offset: true }).optional(),
  queueDepth: z.number().int().min(0).optional(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const ConsentAck = z.object({ collectorId: z.string().uuid(), noticeVersion: z.string().min(1).max(32) });
export type ConsentAck = z.infer<typeof ConsentAck>;

export const PauseRequest = z.object({ collectorId: z.string().uuid(), minutes: z.number().int().min(1).max(7 * 24 * 60).optional(), resume: z.boolean().optional() });
export type PauseRequest = z.infer<typeof PauseRequest>;

export const ConfigResponse = z.object({
  collectorId: z.string().uuid(),
  status: z.enum(["pending", "active", "paused", "revoked", "offline"]),
  pausedUntil: z.string().nullable(),
  config: CollectorConfigSchema,
  notice: NoticeSchema,
  consent: z.enum(["acknowledged", "withdrawn", "missing"]),
  /** Active campaign windows the collector should sample inside (server also enforces). */
  campaigns: z.array(z.object({ id: z.string().uuid(), startsAt: z.string().nullable(), endsAt: z.string().nullable(), schedule: CollectorConfigSchema.shape.schedule, titleMode: z.enum(["hash", "category", "none"]).optional() })),
});
export type ConfigResponse = z.infer<typeof ConfigResponse>;

/** Default list of apps the collector never samples. Matched case-insensitively as substrings of process/app name. */
export const DEFAULT_BLOCKED_APPS = [
  "1password", "bitwarden", "lastpass", "keepass", "dashlane", "keychain access",
  "quicken", "mint", "banking", "chase", "wells fargo", "bank of america", "capital one",
  "mychart", "health", "medical", "therapy", "betterhelp",
  "signal", "whatsapp", "telegram", "imessage", "messages",
];
export const DEFAULT_NOTICE_VERSION = "1";
export const DEFAULT_NOTICE_TEXT = `This computer runs the BridgeBox activity collector as part of a workplace process-improvement study authorized by your employer.

What it records: which application is in the foreground, a coarse category for the type of document (e.g. "invoice", "report"), how long you spend in each, and counts (not contents) of activity such as number of fields filled.

What it never records: keystrokes, clipboard contents, screenshots, web addresses, window titles, file names, message or email contents, or anything from apps on the blocked list (password managers, banking, health, personal messaging).

You can pause collection at any time from the collector or withdraw consent from the Trust & Privacy page. Data is kept only for your organization's retention period and is used to find repetitive work that could be automated, not to evaluate individuals.`;
