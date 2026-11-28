/**
 * A full run against a real HTTP server that hands every SSE stream to
 * polling: it sends a priming event with an id and a `retry` time, closes the
 * connection, and replays the answer on a GET that carries `Last-Event-ID`
 * (2025-11-25 Transports, Sending Messages to the Server and Resumability and
 * Redelivery).
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  MCPConformanceTest,
  type MCPCheckId,
} from "../../src/mcp-conformance/index.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** One line per request: `POST <method>`, `GET [Last-Event-ID]`, `DELETE`. */
async function servePolling(seen: string[]): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      const lastEventId = req.headers["last-event-id"];
      seen.push(lastEventId ? "GET [Last-Event-ID]" : "GET");
      if (typeof lastEventId !== "string" || !lastEventId.startsWith("poll.")) {
        res.writeHead(405).end();
        return;
      }
      const answer = Buffer.from(lastEventId.slice(5), "base64").toString(
        "utf8"
      );
      res
        .writeHead(200, { "Content-Type": "text/event-stream" })
        .end(`id: 2\nevent: message\ndata: ${answer}\n\n`);
      return;
    }
    if (req.method !== "POST") {
      seen.push(req.method ?? "");
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push(`POST ${body.method}`);
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const message =
        body.method === "initialize"
          ? {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: body.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "polling-fixture", version: "1" },
              },
            }
          : body.method === "tools/list"
            ? { jsonrpc: "2.0", id: body.id, result: { tools: [] } }
            : {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32601, message: "Method not found" },
              };
      const id = Buffer.from(JSON.stringify(message), "utf8").toString(
        "base64"
      );
      res
        .writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "session-1",
        })
        .end(`id: poll.${id}\nretry: 20\ndata: \n\n`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${port}/mcp`;
}

const CHECKS: MCPCheckId[] = [
  "protocol-invalid-method-error",
  "server-sse-streams-functional",
];

describe("a 2025 server that hands its streams to polling", () => {
  it("is called back for every answer, and the checks grade those answers", async () => {
    const seen: string[] = [];
    const result = await new MCPConformanceTest({
      serverUrl: await servePolling(seen),
      protocolVersion: "2025-11-25",
      checkIds: CHECKS,
      // Advice sends its own requests; this test is about the checks.
      readinessIds: [],
      checkTimeout: 5_000,
    }).run();

    for (const id of CHECKS) {
      const check = result.checks.find((entry) => entry.id === id);
      expect([id, check?.status]).toEqual([id, "passed"]);
    }
    // Two handshakes, the probe and three tool lists: one call-back each.
    expect(seen.filter((line) => line === "GET [Last-Event-ID]")).toHaveLength(
      6
    );
  });
});
