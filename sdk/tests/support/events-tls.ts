/**
 * An HTTPS webhook receiver for events tests, fronting a `MemoryEventInbox`.
 *
 * The draft makes `https` a MUST for callback URLs, so the conformant
 * fixture refuses plain-http receivers — which means the tests need a real
 * TLS endpoint. The certificate is minted per test run with the system
 * `openssl` (a throwaway self-signed cert for 127.0.0.1/localhost, never
 * checked in), and the fixture's delivery `fetch` trusts exactly that cert
 * via an undici `Agent` — nothing process-global is weakened.
 */

import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { MemoryEventInbox } from "../../src/events/memory-inbox.js";

export interface TestCertificate {
  cert: string;
  key: string;
}

let cached: TestCertificate | undefined;

export function mintTestCertificate(): TestCertificate {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-events-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" }
    );
    cached = {
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
      key: readFileSync(join(dir, "key.pem"), "utf8"),
    };
    return cached;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A `fetch` that trusts only the test certificate (for fixture deliveries). */
export function trustingFetch(certificate: TestCertificate): typeof fetch {
  const dispatcher = new Agent({ connect: { ca: certificate.cert } });
  return ((input: any, init?: any) =>
    undiciFetch(input, { ...init, dispatcher }) as unknown as Promise<Response>) as typeof fetch;
}

export interface HttpsInboxHandle {
  inbox: MemoryEventInbox;
  origin: string;
  /** Every request the receiver saw, status included. */
  requests: Array<{ path: string; status: number }>;
  close: () => Promise<void>;
}

/**
 * Serve `POST /i/{inboxId}/s/{slotId}` over HTTPS into a fresh
 * `MemoryEventInbox` whose callback URLs point at this server.
 */
export async function startHttpsInbox(options?: {
  clock?: { now(): number };
  maxUndispatched?: number;
}): Promise<HttpsInboxHandle> {
  const certificate = mintTestCertificate();
  const requests: HttpsInboxHandle["requests"] = [];
  let inbox!: MemoryEventInbox;
  const server = https.createServer(
    { cert: certificate.cert, key: certificate.key },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = req.url ?? "/";
        const match = /^\/i\/([a-z2-7]+)\/s\/([a-z2-7]+)$/.exec(path);
        const respond = (status: number, body?: unknown, headers?: Record<string, string>) => {
          requests.push({ path, status });
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(body === undefined ? "" : JSON.stringify(body));
        };
        if (req.method !== "POST" || !match || match[1] !== inbox.inboxId) {
          respond(404, { error: "not_found" });
          return;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        inbox
          .receive({
            slotId: match[2]!,
            headers,
            body: new Uint8Array(Buffer.concat(chunks)),
          })
          .then((result) => respond(result.status, result.body, result.headers))
          .catch(() => respond(500, { error: "internal" }));
      });
    }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `https://127.0.0.1:${port}`;
  inbox = new MemoryEventInbox({
    publicOrigin: origin,
    ...(options?.clock ? { clock: options.clock } : {}),
    ...(options?.maxUndispatched !== undefined
      ? { maxUndispatched: options.maxUndispatched }
      : {}),
  });
  return {
    inbox,
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
