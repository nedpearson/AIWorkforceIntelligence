/**
 * Tiny HTTP stub that plays the role of a client's "target system API" for agent templates that need an
 * `http_bearer` credential (base URL + token). It records every request so a spec can prove the agent
 * really called out after approval, and always answers 200 JSON.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockHit = { method: string; url: string; authorization: string | null; body: string };

export async function startMockApi(): Promise<{ baseUrl: string; hits: MockHit[]; close: () => Promise<void> }> {
  const hits: MockHit[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization ?? null, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: `mock-${hits.length}`, batchId: `batch-${hits.length}`, items: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
}
