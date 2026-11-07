/** Brain upload hardening (SEC-007): filename sanitisation, text sniffing, zip-bomb guard, per-org quota. */
import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { inArray } from "drizzle-orm";
import { db, schema, pg } from "@/db/client";
import { extractText, ExtractError, sanitizeFilename, looksLikeText, inspectZip, DOCX_LIMITS } from "@/engine/brain/extract";
import { assertBrainQuota, brainQuotaBytes, brainStorageUsed, BrainQuotaError, DEFAULT_BRAIN_QUOTA_BYTES } from "@/engine/brain/quota";
import { randomToken } from "@/lib/crypto";

const enc = (s: string) => new TextEncoder().encode(s);
const docxXml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
async function zip(files: Record<string, string | Uint8Array>, opts: { compression?: "DEFLATE" | "STORE" } = {}) {
  const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v);
  return new Uint8Array(await z.generateAsync({ type: "uint8array", compression: opts.compression ?? "DEFLATE", compressionOptions: { level: 9 } }));
}
const orgs: string[] = [];
afterAll(async () => { if (orgs.length) await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgs)); await pg.end({ timeout: 5 }); });

describe("filenames", () => {
  it("strips paths, control and bidi characters, reserved characters and leading dots; caps length; keeps extension", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\x\\Policy.docx")).toBe("Policy.docx");
    expect(sanitizeFilename("in\u202Eexe.txt")).toBe("inexe.txt");
    expect(sanitizeFilename("a<b>:c|d?.md")).toBe("a_b__c_d_.md");
    expect(sanitizeFilename(".hidden.txt")).toBe("hidden.txt");
    expect(sanitizeFilename("\u0000\u0001")).toBe("upload");
    const long = sanitizeFilename("x".repeat(400) + ".pdf");
    expect(long.length).toBe(150); expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("content sniffing", () => {
  it("text formats must be UTF-8 text without NUL bytes", async () => {
    expect(looksLikeText(enc("hello world"))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x4d, 0x5a, 0x00, 0x90]))).toBe(false); // PE header renamed .txt
    expect(looksLikeText(new Uint8Array([0xc3, 0x28]))).toBe(false); // invalid UTF-8
    await expect(extractText({ name: "notes.txt", bytes: new Uint8Array([0x4d, 0x5a, 0x00, 0x90, ...enc("a".repeat(50))]) })).rejects.toBeInstanceOf(ExtractError);
    await expect(extractText({ name: "notes.md", bytes: enc("# fine\nThis markdown file has enough plain text in it.") })).resolves.toMatchObject({ format: "markdown" });
  });
  it("binary formats must match their magic bytes (pdf / docx)", async () => {
    await expect(extractText({ name: "x.pdf", bytes: enc("not really a pdf, just text pretending") })).rejects.toThrow(/not a supported file type|do not match/);
    await expect(extractText({ name: "x.docx", bytes: enc("plain text with a docx name, long enough") })).rejects.toThrow(/do not match/);
  });
});

describe("docx zip-bomb guard", () => {
  it("accepts a normal Word document", async () => {
    const d = await zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": docxXml("<w:p><w:r><w:t>Hotel limit is $185 per night for all staff travel.</w:t></w:r></w:p>") });
    const z = inspectZip(d); expect(z.ok && z.hasDocumentXml).toBe(true);
    await expect(extractText({ name: "Policy.docx", bytes: d })).resolves.toMatchObject({ format: "docx" });
  });
  it("rejects a highly compressed entry (ratio) — 20 MB of zeros", async () => {
    const d = await zip({ "word/document.xml": docxXml(""), "word/media/bomb.bin": new Uint8Array(20 * 1024 * 1024) });
    expect(d.length).toBeLessThan(200_000);
    const z = inspectZip(d); expect(z.ok).toBe(false); if (!z.ok) expect(z.reason).toMatch(/zip bomb/);
    await expect(extractText({ name: "bomb.docx", bytes: d })).rejects.toThrow(/zip bomb/);
  });
  it("rejects archives whose declared total exceeds the limit, too many entries, or no word/document.xml", async () => {
    const big = new Uint8Array(1024 * 1024); for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24; // incompressible-ish
    expect(inspectZip(await zip({ "word/document.xml": docxXml(""), a: big, b: big }, { compression: "STORE" }), { ...DOCX_LIMITS, maxUncompressedBytes: 1.5 * 1024 * 1024 }).ok).toBe(false);
    const many: Record<string, string> = { "word/document.xml": docxXml("") }; for (let i = 0; i < 30; i++) many[`f${i}.xml`] = "<x/>";
    const zm = inspectZip(await zip(many), { ...DOCX_LIMITS, maxEntries: 10 }); expect(zm.ok).toBe(false);
    const notWord = await zip({ "hello.txt": "this is a zip file but not a word document at all" });
    await expect(extractText({ name: "fake.docx", bytes: notWord })).rejects.toThrow(/not a Word document/);
    expect(inspectZip(enc("PK\u0003\u0004 garbage without central directory")).ok).toBe(false);
  });
});

describe("per-org storage quota", () => {
  it("defaults to 50 MB, configurable, and refuses uploads past it", async () => {
    expect(brainQuotaBytes({})).toBe(DEFAULT_BRAIN_QUOTA_BYTES);
    expect(brainQuotaBytes({ BRAIN_ORG_QUOTA_BYTES: "1000" })).toBe(1000);
    const S = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x");
    const [o] = await db.insert(schema.organizations).values({ name: `Quota ${S}`, slug: `quota-${S}` }).returning(); orgs.push(o.id);
    await db.insert(schema.knowledgeDocuments).values({ orgId: o.id, title: "t", content: "x".repeat(800), contentHash: "h" + S });
    expect(await brainStorageUsed(o.id)).toBe(800);
    await expect(assertBrainQuota(o.id, 100, { BRAIN_ORG_QUOTA_BYTES: "1000" })).resolves.toBeUndefined();
    await expect(assertBrainQuota(o.id, 300, { BRAIN_ORG_QUOTA_BYTES: "1000" })).rejects.toBeInstanceOf(BrainQuotaError);
  });
});
