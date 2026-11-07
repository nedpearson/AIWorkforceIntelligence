/**
 * AI Brain — text extraction for uploaded knowledge files (server-only use; no `server-only` import so tests/scripts can load it).
 *
 *  extractText({ name, bytes, mimeType? }) → { title, text, format, mimeType, warnings }
 *
 * Supported: .txt .md .csv (→ readable row text) .html/.htm (tags stripped) .json (flattened key paths) .docx (mammoth) .pdf (unpdf).
 * Anything else is rejected with a clear message. Files over 10 MB are rejected before parsing.
 * Extracted text is UNTRUSTED data: it is stored as document content and only ever reaches a model through isolateUntrusted().
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = ["txt", "md", "markdown", "csv", "html", "htm", "json", "docx", "pdf"] as const;
export type ExtractFormat = "text" | "markdown" | "csv" | "html" | "json" | "docx" | "pdf";
export type ExtractResult = { title: string; text: string; format: ExtractFormat; mimeType: string; warnings: string[] };

export class ExtractError extends Error {
  constructor(message: string, public code: "too_large" | "unsupported" | "empty" | "parse_failed") { super(message); this.name = "ExtractError"; }
}

const MIME: Record<ExtractFormat, string> = {
  text: "text/plain", markdown: "text/markdown", csv: "text/csv", html: "text/html", json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf",
};

export function detectFormat(name: string, mimeType: string | undefined, bytes: Uint8Array): ExtractFormat | null {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04; // PK\3\4
  if (ext === "pdf" || mimeType === MIME.pdf) return isPdf ? "pdf" : null;
  if (ext === "docx" || mimeType === MIME.docx) return isZip ? "docx" : null;
  if (ext === "txt" || (!ext && mimeType === "text/plain")) return "text";
  if (ext === "md" || ext === "markdown" || mimeType === "text/markdown") return "markdown";
  if (ext === "csv" || mimeType === "text/csv") return "csv";
  if (ext === "html" || ext === "htm" || mimeType === "text/html") return "html";
  if (ext === "json" || mimeType === "application/json") return "json";
  return null;
}

// ------------------------------------------------------------------ upload hardening
/** Request-level cap for /api/brain/upload (checked from content-length before the multipart body is parsed). */
export const MAX_UPLOAD_REQUEST_BYTES = 25 * 1024 * 1024;
/** docx (zip) guards — the central directory is inspected before mammoth inflates anything. */
export const DOCX_LIMITS = { maxEntries: 2000, maxUncompressedBytes: 50 * 1024 * 1024, maxRatio: 100 } as const;

/** Strip directories, control/bidi characters and anything outside a conservative set; keep the extension. */
export function sanitizeFilename(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[<>:"|?*]/g, "_").replace(/^\.+/, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "upload";
  if (cleaned.length <= 150) return cleaned;
  const ext = cleaned.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? "";
  return cleaned.slice(0, 150 - ext.length) + ext;
}

/** Text formats must actually be text: no NUL bytes and valid UTF-8 (catches binaries renamed to .txt/.md). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  if (head.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

export type ZipInspection = { ok: true; entries: number; uncompressed: number; compressed: number; hasDocumentXml: boolean } | { ok: false; reason: string };
/**
 * Reads the zip End-Of-Central-Directory + central directory (no decompression) and rejects archives that declare
 * too many entries, too many uncompressed bytes, an extreme compression ratio, ZIP64 sizes or encryption.
 * Limitation: these are the sizes the archive DECLARES; a crafted file can under-declare. mammoth/jszip then inflates
 * fully in memory, bounded by the 10 MB compressed upload cap.
 */
export function inspectZip(bytes: Uint8Array, limits: { maxEntries: number; maxUncompressedBytes: number; maxRatio: number } = DOCX_LIMITS): ZipInspection {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return { ok: false, reason: "not a valid zip archive (no central directory)" };
  const entries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff) return { ok: false, reason: "ZIP64 archives are not accepted" };
  if (entries > limits.maxEntries) return { ok: false, reason: `archive has ${entries} entries (limit ${limits.maxEntries})` };
  if (cdOffset + cdSize > bytes.length) return { ok: false, reason: "corrupt zip central directory" };
  let p = cdOffset; let uncompressed = 0; let compressed = 0; let hasDocumentXml = false;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) return { ok: false, reason: "corrupt zip central directory" };
    const flags = dv.getUint16(p + 8, true);
    const csize = dv.getUint32(p + 20, true); const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true); const extraLen = dv.getUint16(p + 30, true); const commentLen = dv.getUint16(p + 32, true);
    if (flags & 0x1) return { ok: false, reason: "encrypted archives are not accepted" };
    if (csize === 0xffffffff || usize === 0xffffffff) return { ok: false, reason: "ZIP64 archives are not accepted" };
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === "word/document.xml") hasDocumentXml = true;
    if (usize > 1024 * 1024 && csize > 0 && usize / csize > limits.maxRatio) return { ok: false, reason: `entry "${name.slice(0, 60)}" expands ${Math.round(usize / csize)}× (limit ${limits.maxRatio}×) — possible zip bomb` };
    uncompressed += usize; compressed += csize;
    if (uncompressed > limits.maxUncompressedBytes) return { ok: false, reason: `archive expands to more than ${Math.round(limits.maxUncompressedBytes / 1048576)} MB — possible zip bomb` };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries, uncompressed, compressed, hasDocumentXml };
}

export const titleFromName = (name: string) => name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled document";

function decodeUtf8(bytes: Uint8Array): string {
  const s = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ------------------------------------------------------------------ CSV
/** RFC 4180-ish parser: quoted fields, escaped quotes, CRLF, embedded newlines. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let q = false;
  const delim = (input.split("\n")[0].match(/;/g)?.length ?? 0) > (input.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (q) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && input[i + 1] === "\n") i++; row.push(field); field = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else field += c;
  }
  row.push(field); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
/** CSV → retrieval-friendly text: one line per row with "Header: value" pairs, so every chunk is self-describing. */
export function csvToText(input: string, title: string): { text: string; rows: number } {
  const rows = parseCsv(input);
  if (!rows.length) return { text: "", rows: 0 };
  const header = rows[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const body = rows.slice(1);
  const lines = body.map((r, i) => `Row ${i + 1}: ${header.map((h, j) => `${h}: ${(r[j] ?? "").trim() || "—"}`).join("; ")}.`);
  return { text: `# ${title}\nTable with ${body.length} row${body.length === 1 ? "" : "s"}. Columns: ${header.join(", ")}.\n\n${lines.join("\n")}`, rows: body.length };
}

// ------------------------------------------------------------------ HTML
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™" };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export function htmlToText(html: string): { text: string; title: string | null } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  let s = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l: string, t: string) => `\n\n${"#".repeat(Number(l))} ${t.replace(/<[^>]+>/g, " ").trim()}\n`)
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre|header|footer|li)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s).split("\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/\s*\|\s*$/, "").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: s, title: title ? decodeEntities(title) : null };
}

// ------------------------------------------------------------------ JSON
export function jsonToText(raw: string): string {
  const data = JSON.parse(raw) as unknown;
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (out.length > 20000) return;
    if (Array.isArray(v)) { if (v.every((x) => x === null || typeof x !== "object")) { out.push(`${path || "items"}: ${v.map(String).join(", ")}`); return; } v.forEach((x, i) => walk(x, `${path}[${i + 1}]`)); return; }
    if (v && typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k); return; }
    out.push(`${path || "value"}: ${v === null ? "null" : String(v)}`);
  };
  walk(data, "");
  return out.join("\n");
}

// ------------------------------------------------------------------ entry point
export async function extractText(file: { name: string; bytes: Uint8Array; mimeType?: string }): Promise<ExtractResult> {
  const name = sanitizeFilename(file.name || "upload");
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ExtractError(`"${name}" is ${(file.bytes.byteLength / 1048576).toFixed(1)} MB — the limit is 10 MB per file.`, "too_large");
  const format = detectFormat(name, file.mimeType, file.bytes);
  if (!format) {
    const ext = name.match(/\.([a-z0-9]+)$/i)?.[1];
    throw new ExtractError(`"${name}" is not a supported file type${ext ? ` (.${ext.toLowerCase()})` : ""} or its contents do not match its extension. Supported: TXT, Markdown, CSV, HTML, JSON, Word (.docx) and PDF.`, "unsupported");
  }
  // Magic-byte / content sniffing beyond detectFormat(): text must be text; docx must be a sane Word archive.
  if (["text", "markdown", "csv", "html", "json"].includes(format) && !looksLikeText(file.bytes)) throw new ExtractError(`"${name}" does not contain plain UTF-8 text (it looks like a binary file renamed to .${name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "txt"}).`, "unsupported");
  if (format === "docx") {
    const z = inspectZip(file.bytes);
    if (!z.ok) throw new ExtractError(`"${name}" was rejected: ${z.reason}.`, "unsupported");
    if (!z.hasDocumentXml) throw new ExtractError(`"${name}" is a zip archive but not a Word document (no word/document.xml).`, "unsupported");
  }
  let title = titleFromName(name); let text = ""; const warnings: string[] = [];
  try {
    if (format === "text" || format === "markdown") text = decodeUtf8(file.bytes);
    else if (format === "csv") { const r = csvToText(decodeUtf8(file.bytes), title); text = r.text; if (r.rows > 5000) warnings.push(`Large table (${r.rows} rows) — consider splitting it for faster review.`); }
    else if (format === "html") { const r = htmlToText(decodeUtf8(file.bytes)); text = r.text; if (r.title) title = r.title; }
    else if (format === "json") text = jsonToText(decodeUtf8(file.bytes));
    else if (format === "docx") {
      const mammoth = await import("mammoth");
      const r = await (mammoth.default ?? mammoth).extractRawText({ buffer: Buffer.from(file.bytes) });
      text = r.value; for (const m of r.messages ?? []) if (m.type === "warning") warnings.push(m.message);
    } else if (format === "pdf") {
      const { getDocumentProxy, extractText: pdfText } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(file.bytes));
      const r = await pdfText(pdf, { mergePages: false });
      const pages = (Array.isArray(r.text) ? r.text : [r.text]).map((p) => p.replace(/[ \t]+/g, " ").trim());
      text = pages.filter(Boolean).join("\n\n");
      if (r.totalPages > 0 && pages.filter(Boolean).length < r.totalPages) warnings.push(`${r.totalPages - pages.filter(Boolean).length} of ${r.totalPages} PDF page(s) had no text layer (scanned images are not OCR'd).`);
    }
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError(`Could not read "${name}" as ${format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`, "parse_failed");
  }
  text = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (text.replace(/\s/g, "").length < 20) throw new ExtractError(`"${name}" has no extractable text${format === "pdf" ? " (it may be a scanned image — OCR is not supported)" : ""}.`, "empty");
  return { title: title.slice(0, 200), text, format, mimeType: MIME[format], warnings };
}

/** Best-effort category suggestion from the title (the uploader can change it before approval). */
export function guessCategory(title: string): "policy" | "procedure" | "pricing" | "vendor" | "customer" | "terminology" | "company" | "product" | "general" {
  const t = title.toLowerCase();
  if (/glossary|terminolog|definitions/.test(t)) return "terminology";
  if (/pric|rate card|quote/.test(t)) return "pricing";
  if (/vendor|supplier|purchase order|\bpo\b/.test(t)) return "vendor";
  if (/policy|policies|handbook|compliance/.test(t)) return "policy";
  if (/procedure|sop|onboarding|checklist|how to|process/.test(t)) return "procedure";
  if (/customer|sla|service level|support/.test(t)) return "customer";
  if (/product|catalog|spec/.test(t)) return "product";
  if (/overview|about us|company|mission/.test(t)) return "company";
  return "general";
}
