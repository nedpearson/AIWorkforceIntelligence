import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import { extractText, ExtractError, parseCsv, csvToText, htmlToText, jsonToText, guessCategory, MAX_UPLOAD_BYTES } from "@/engine/brain/extract";

const enc = (s: string) => new TextEncoder().encode(s);
async function makePdf(lines: string[]): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: "LETTER" }); const parts: Buffer[] = [];
  doc.on("data", (b: Buffer) => parts.push(b));
  const done = new Promise<void>((r) => doc.on("end", () => r()));
  lines.forEach((l, i) => { if (i === 2) doc.addPage(); doc.text(l); });
  doc.end(); await done;
  return new Uint8Array(Buffer.concat(parts));
}
async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("brain text extraction", () => {
  it("txt and markdown", async () => {
    const t = await extractText({ name: "notes.txt", bytes: enc("﻿Payment runs happen every Tuesday and Friday.") });
    expect(t.format).toBe("text"); expect(t.text).toMatch(/^Payment runs/); expect(t.title).toBe("notes");
    const m = await extractText({ name: "ap_policy.md", bytes: enc("# AP\nInvoices over $5,000 require controller approval.") });
    expect(m.format).toBe("markdown"); expect(m.title).toBe("ap policy"); expect(m.text).toContain("$5,000");
  });
  it("csv → readable row text with quoted fields", async () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    const r = await extractText({ name: "vendors.csv", bytes: enc("Vendor,Terms,GL\nBayou Steel,Net 45,5010\r\nDelta Pipe,\"2/10, Net 30\",5020\n") });
    expect(r.format).toBe("csv");
    expect(r.text).toContain("Columns: Vendor, Terms, GL.");
    expect(r.text).toContain("Row 2: Vendor: Delta Pipe; Terms: 2/10, Net 30; GL: 5020.");
    expect(csvToText("", "x").rows).toBe(0);
  });
  it("html strips tags, scripts and decodes entities", async () => {
    const r = await extractText({ name: "sla.html", bytes: enc("<html><head><title>Service SLA</title><style>p{}</style></head><body><h1>Response</h1><script>alert(1)</script><p>Emails &amp; tickets: 4&nbsp;hours.</p><ul><li>Phones</li></ul></body></html>") });
    expect(r.format).toBe("html"); expect(r.title).toBe("Service SLA");
    expect(r.text).toContain("# Response"); expect(r.text).toContain("Emails & tickets: 4 hours."); expect(r.text).not.toContain("alert"); expect(r.text).toContain("- Phones");
    expect(htmlToText("<p>a</p><p>b</p>").text).toBe("a\nb");
  });
  it("json flattens to key paths", async () => {
    expect(jsonToText('{"vendor":{"name":"Bayou","terms":"Net 45"},"tags":["steel","rebar"]}')).toBe("vendor.name: Bayou\nvendor.terms: Net 45\ntags: steel, rebar");
    const r = await extractText({ name: "cfg.json", bytes: enc('{"policy":{"threshold":5000,"approver":"controller"}}') });
    expect(r.text).toContain("policy.threshold: 5000");
    await expect(extractText({ name: "bad.json", bytes: enc("{nope") })).rejects.toMatchObject({ code: "parse_failed" });
  });
  it("docx via mammoth", async () => {
    const r = await extractText({ name: "Travel Policy.docx", bytes: await makeDocx(["Travel and Expense Policy", "Hotel limit is $185 per night."]) });
    expect(r.format).toBe("docx"); expect(r.text).toContain("Hotel limit is $185 per night."); expect(r.title).toBe("Travel Policy");
  });
  it("pdf via unpdf (multi-page)", async () => {
    const r = await extractText({ name: "pricing.pdf", bytes: await makePdf(["Contractor Pricing Sheet", "Tier 2 receives 12% off list.", "Quotes are valid for 14 days."]) });
    expect(r.format).toBe("pdf"); expect(r.text).toContain("12% off list"); expect(r.text).toContain("valid for 14 days");
  });
  it("rejects unsupported types, mismatched content, oversize and empty files with clear messages", async () => {
    await expect(extractText({ name: "sheet.xlsx", bytes: enc("PK...") })).rejects.toThrow(/not a supported file type \(\.xlsx\)/);
    await expect(extractText({ name: "fake.pdf", bytes: enc("not really a pdf at all") })).rejects.toBeInstanceOf(ExtractError);
    await expect(extractText({ name: "big.txt", bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) })).rejects.toThrow(/limit is 10 MB/);
    await expect(extractText({ name: "empty.txt", bytes: enc("   ") })).rejects.toMatchObject({ code: "empty" });
  });
  it("guesses categories from titles", () => {
    expect(guessCategory("Approved Vendor List")).toBe("vendor"); expect(guessCategory("Travel & Expense Policy")).toBe("policy"); expect(guessCategory("Company Glossary")).toBe("terminology"); expect(guessCategory("Random")).toBe("general");
  });
});
