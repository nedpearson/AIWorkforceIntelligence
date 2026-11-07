/**
 * Minimal, dependency-free PDF text extraction (server-side; uses node:zlib).
 *
 * Supports text-based PDFs (as produced by accounting systems, PDFKit, Word "Save as PDF" with standard fonts):
 * FlateDecode content streams, literal `( )` and hex `< >` strings shown with Tj / TJ / ' / ", line breaks from
 * Td / TD / T* / Tm, and ToUnicode CMaps (bfchar / bfrange) when a font provides one.
 *
 * Not supported (reported honestly in `warnings`): scanned/image-only PDFs (no OCR), encrypted PDFs,
 * object streams that hide content streams, and exotic encodings without a ToUnicode map.
 */
import { inflateSync } from "node:zlib";

export type PdfTextResult = { text: string; pages: number; warnings: string[] };

export function extractPdfText(buf: Buffer): PdfTextResult {
  const warnings: string[] = [];
  const head = buf.subarray(0, 1024).toString("latin1");
  if (!head.startsWith("%PDF-")) return { text: "", pages: 0, warnings: ["Not a PDF file (missing %PDF- header)."] };
  const raw = buf.toString("latin1");
  if (/\/Encrypt\s/.test(raw)) warnings.push("PDF is encrypted — text may not be extractable.");
  const pages = (raw.match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length;

  // collect all streams (decoded)
  const streams: { dict: string; data: string }[] = [];
  const re = /(<<(?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*>>)\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const lenMatch = m[1].match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    let end = lenMatch ? start + Number(lenMatch[1]) : -1;
    if (end < 0 || raw.slice(end, end + 30).indexOf("endstream") < 0) end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const bytes = buf.subarray(start, end);
    let data: string | null = null;
    if (/\/FlateDecode/.test(m[1])) { try { data = inflateSync(bytes).toString("latin1"); } catch { try { data = inflateSync(bytes.subarray(0, bytes.length - 1)).toString("latin1"); } catch { data = null; } } }
    else if (!/\/Filter/.test(m[1])) data = bytes.toString("latin1");
    if (data != null) streams.push({ dict: m[1], data });
    re.lastIndex = end;
  }
  if (/\/ObjStm/.test(raw) && !streams.some((s) => /BT[\s\S]*?ET/.test(s.data))) warnings.push("PDF uses compressed object streams; some text may be missing.");

  // ToUnicode CMaps (merged; good enough for single-font invoices)
  const cmap = new Map<string, string>();
  for (const s of streams) {
    if (!/begincmap/.test(s.data)) continue;
    for (const b of s.data.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) cmap.set(p[1].toLowerCase(), hexToUtf16(p[2]));
    for (const b of b2(s.data)) {
      const lo = parseInt(b[1], 16), hi = parseInt(b[2], 16), width = b[1].length;
      if (b[3]) { let dst = parseInt(b[3], 16); for (let c = lo; c <= hi && c - lo < 5000; c++, dst++) cmap.set(c.toString(16).padStart(width, "0"), String.fromCodePoint(dst)); }
    }
  }

  const out: string[] = [];
  for (const s of streams) {
    if (/begincmap/.test(s.data) || /\/Subtype\s*\/Image/.test(s.dict) || !/\bBT\b/.test(s.data)) continue;
    out.push(textFromContent(s.data, cmap));
  }
  const text = out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) warnings.push(pages ? "No extractable text — this looks like a scanned/image PDF. OCR is not available; paste the text instead." : "No text found in PDF.");
  return { text, pages, warnings };
}

function* b2(data: string) {
  for (const b of data.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) yield p;
}
function hexToUtf16(h: string): string {
  let s = ""; for (let i = 0; i + 3 < h.length + 1 && i < h.length; i += 4) { const c = parseInt(h.slice(i, i + 4).padEnd(4, "0"), 16); if (c) s += String.fromCharCode(c); }
  return s;
}

function decodeLiteral(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") { out += c; continue; }
    const n = s[++i];
    if (n === "n") out += "\n"; else if (n === "r") out += "\r"; else if (n === "t") out += "\t"; else if (n === "b" || n === "f") out += "";
    else if (n === "(" || n === ")" || n === "\\") out += n;
    else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) o += s[++i]; out += String.fromCharCode(parseInt(o, 8)); }
    else if (n === "\n" || n === "\r") { /* line continuation */ }
    else out += n ?? "";
  }
  return out;
}

const WIN_ANSI: Record<number, string> = { 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x80: "€", 0x99: "™", 0xa0: " " };
function decodeBytes(bytes: string, cmap: Map<string, string>, hex: boolean): string {
  if (cmap.size) {
    const h = hex ? bytes.toLowerCase() : [...bytes].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    for (const w of [4, 2]) {
      if (h.length % w) continue;
      let s = ""; let all = true;
      for (let i = 0; i < h.length; i += w) { const v = cmap.get(h.slice(i, i + w)); if (v == null) { all = false; break; } s += v; }
      if (all) return s;
    }
  }
  const str = hex ? (bytes.replace(/\s+/g, "").match(/../g) ?? []).map((x) => String.fromCharCode(parseInt(x, 16))).join("") : bytes;
  return [...str].map((c) => { const k = c.charCodeAt(0); return WIN_ANSI[k] ?? (k < 32 && k !== 10 ? "" : c); }).join("");
}

/** Walk a content stream and emit text, breaking lines on text-positioning operators. */
function textFromContent(data: string, cmap: Map<string, string>): string {
  let out = ""; let i = 0; const n = data.length;
  const operands: string[] = [];
  let lastY: number | null = null;
  const emitBreak = () => { if (out && !out.endsWith("\n")) out += "\n"; };
  while (i < n) {
    const c = data[i];
    if (c === "(") { // literal string with nesting
      let depth = 1, j = i + 1, buf = "";
      while (j < n && depth) { const ch = data[j]; if (ch === "\\") { buf += ch + (data[j + 1] ?? ""); j += 2; continue; } if (ch === "(") depth++; else if (ch === ")") { depth--; if (!depth) break; } buf += ch; j++; }
      operands.push("S" + decodeBytes(decodeLiteral(buf), cmap, false)); i = j + 1; continue;
    }
    if (c === "<" && data[i + 1] !== "<") { const j = data.indexOf(">", i); operands.push("S" + decodeBytes(data.slice(i + 1, j), cmap, true)); i = j + 1; continue; }
    if (c === "[") { operands.push("["); i++; continue; }
    if (c === "]") { // collapse array
      const parts: string[] = []; while (operands.length && operands[operands.length - 1] !== "[") parts.unshift(operands.pop()!); operands.pop();
      let s = ""; for (const p of parts) { if (p.startsWith("S")) s += p.slice(1); else if (Number(p) < -180) s += " "; }
      operands.push("S" + s); i++; continue;
    }
    if (c === "%") { while (i < n && data[i] !== "\n" && data[i] !== "\r") i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    // token
    let j = i; while (j < n && !/[\s()<>[\]/%]/.test(data[j])) j++;
    if (j === i) { // name like /F1
      if (c === "/") { j = i + 1; while (j < n && !/[\s()<>[\]/%]/.test(data[j])) j++; operands.push("N" + data.slice(i, j)); i = j; continue; }
      i++; continue;
    }
    const tok = data.slice(i, j); i = j;
    if (/^[-+]?\d*\.?\d+$/.test(tok)) { operands.push(tok); continue; }
    switch (tok) {
      case "Tj": case "'": case '"': { if (tok !== "Tj") emitBreak(); const s = operands.filter((o) => o.startsWith("S")).pop(); if (s) out += s.slice(1); break; }
      case "TJ": { const s = operands.filter((o) => o.startsWith("S")).pop(); if (s) out += s.slice(1); break; }
      case "Td": case "TD": { const ty = Number(operands[operands.length - 1]); const tx = Number(operands[operands.length - 2]); if (ty) emitBreak(); else if (tx > 0 && out && !out.endsWith(" ") && !out.endsWith("\n")) out += "  "; break; }
      case "Tm": { const y = Number(operands[operands.length - 1]); if (lastY == null || Math.abs(y - lastY) > 0.5) emitBreak(); else if (out && !out.endsWith(" ")) out += "  "; lastY = y; break; }
      case "T*": emitBreak(); break;
      case "ET": break;
      case "BT": break;
      default: break;
    }
    operands.length = 0;
  }
  return out;
}
