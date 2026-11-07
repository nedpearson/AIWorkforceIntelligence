import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

function key(): Buffer {
  const k = process.env.VAULT_KEY;
  if (!k) throw new Error("VAULT_KEY not set");
  const b = Buffer.from(k, "base64");
  if (b.length !== 32) throw new Error("VAULT_KEY must be 32 bytes base64");
  return b;
}
/** AES-256-GCM. Output format: base64(iv).base64(tag).base64(ct) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
export function decrypt(enc: string): string {
  const [iv, tag, ct] = enc.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
export function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function hmacHash(s: string, salt = process.env.AUTH_SECRET ?? "salt"): string { return createHmac("sha256", salt).update(s).digest("hex").slice(0, 32); }
export function randomToken(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
