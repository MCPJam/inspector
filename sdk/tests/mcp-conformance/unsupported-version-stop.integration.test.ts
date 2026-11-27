/**
 * A full run against a real HTTP server that answers `initialize` with a
 * protocol version MCPJam does not support.
 *
 * The server counts what reaches it. After such an answer a client should
 * disconnect, so nothing but `initialize` and the DELETE that ends the session
 * may arrive, and the checks that needed more report that they could not run.
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";

const UNSUPPORTED = "2099-01-01";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * A 2025-era server that answers every `initialize` with `answeredVersion` and
 * is otherwise correct. `seen` gets one line per request.
 */
async function serveLegacy(options: {
  answeredVersion: string;
  seen: string[];
}): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      options.seen.push(req.method ?? "");
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      options.seen.push(`POST ${body.method}`);
      const reply = (payload: Record<string, unknown>) =>
        res
          .writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "session-1",
          })
          .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));

      switch (body.method) {
        case "initialize":
          return reply({
            result: {
              protocolVersion: options.answeredVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "version-fixture", version: "1" },
            },
          });
        case "notifications/initialized":
          return res.writeHead(202).end();
        case "tools/list":
          return reply({ result: { tools: [] } });
        default:
          return reply({
            error: { code: -32601, message: "Method not found" },
          });
      }
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

const NEEDS_SESSION: MCPCheckId[] = [
  "protocol-invalid-method-error",
  "server-sse-streams-functional",
  "notification-post-accepted",
  "get-stream-or-405",
];

async function run(serverUrl: string): Promise<MCPCheckResult[]> {
  const result = await new MCPConformanceTest({
    serverUrl,
    protocolVersion: "2025-11-25",
    checkIds: NEEDS_SESSION,
    // Advice sends its own requests; this test is about the checks.
    readinessIds: [],
    checkTimeout: 5_000,
  }).run();
  return result.checks;
}

describe("a server that answers initialize with an unsupported version", () => {
  it("receives nothing after initialize but the DELETE that ends the session", async () => {
    const seen: string[] = [];
    const checks = await run(
      await serveLegacy({ answeredVersion: UNSUPPORTED, seen })
    );

    // One handshake for the protocol check and one for the transport checks.
    expect([...seen].sort()).toEqual([
      "DELETE",
      "POST initialize",
      "POST initialize",
    ]);
    for (const id of NEEDS_SESSION) {
      const check = checks.find((entry) => entry.id === id);
      expect([id, check?.status, check?.skipReason]).toEqual([
        id,
        "skipped",
        "could-not-run",
      ]);
      expect(check?.error?.message).toContain(
        `protocol version "${UNSUPPORTED}", which MCPJam does not support`
      );
    }
  });

  it("is probed as before when the version is one MCPJam supports", async () => {
    const seen: string[] = [];
    const checks = await run(
      await serveLegacy({ answeredVersion: "2025-11-25", seen })
    );

    expect(seen).toContain("POST nonexistent/method_that_does_not_exist");
    expect(seen).toContain("POST notifications/initialized");
    expect(seen).toContain("GET");
    for (const id of NEEDS_SESSION) {
      const check = checks.find((entry) => entry.id === id);
      expect([id, check?.skipReason]).not.toEqual([id, "could-not-run"]);
    }
  });
});

describe("a server that answers initialize with another version it supports", () => {
  it("receives nothing after initialize but the DELETE, and no check blames it", async () => {
    const seen: string[] = [];
    // The run is pinned to 2025-11-25 and the server only speaks 2025-06-18.
    const checks = await run(
      await serveLegacy({ answeredVersion: "2025-06-18", seen })
    );

    expect([...seen].sort()).toEqual([
      "DELETE",
      "POST initialize",
      "POST initialize",
    ]);
    for (const id of NEEDS_SESSION) {
      const check = checks.find((entry) => entry.id === id);
      expect([id, check?.status, check?.skipReason]).toEqual([
        id,
        "skipped",
        "could-not-run",
      ]);
      expect(check?.error?.message).toContain(
        "The server does not support protocol version 2025-11-25, which this run uses: it answered initialize with 2025-06-18."
      );
    }
  });
});
