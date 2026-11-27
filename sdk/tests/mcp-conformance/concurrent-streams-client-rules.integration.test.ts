/**
 * "The client MAY remain connected to multiple SSE streams simultaneously",
 * tested on our own clients over a real socket.
 *
 * The rule binds the client, so it is no longer a check that grades servers
 * (Multiple POST Streams was removed). What is left to show is that MCPJam
 * itself can do what the rule permits: hold several streams open at once and
 * read each answer from its own stream.
 *
 * The server here opens an SSE stream for every gated request and writes
 * nothing on any of them until three are open. Then it answers them in reverse
 * order. A client that sends one request at a time, or that expects answers in
 * the order it asked, does not get through.
 *
 * Two clients are driven: the conformance suite's own probe, and the MCPJam
 * client (`MCPClientManager`) that every other part of the product uses.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  MCPConformanceTest,
  type MCPCheckId,
} from "../../src/mcp-conformance/index.js";

const SESSION_ID = "session-three-streams";
const SSE: MCPCheckId = "server-sse-streams-functional";
const REMOVED = "server-accepts-multiple-post-streams";

interface Seen {
  httpMethod: string;
  rpcMethod?: string;
  id?: unknown;
  sessionId?: string;
  accept?: string;
  protocolVersion?: string;
}

interface Served {
  url: string;
  seen: Seen[];
  /** The most SSE streams that were open at the same time. */
  peakOpenStreams: () => number;
  /** Request ids in the order their answers were written. */
  answeredOrder: unknown[];
  close: () => Promise<void>;
}

/**
 * A 2025-11-25 server with one tool. Requests for `gate` are answered on SSE
 * streams that all stay silent until three are open.
 */
async function serve(gate: "tools/list" | "tools/call"): Promise<Served> {
  const seen: Seen[] = [];
  const answeredOrder: unknown[] = [];
  const open: Array<{
    res: http.ServerResponse;
    id: unknown;
    params?: Record<string, unknown>;
  }> = [];
  let peak = 0;

  const tools = [
    {
      name: "echo",
      description: "Echoes a number.",
      inputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
    },
  ];
  const answerFor = (rpcMethod: string, params?: Record<string, unknown>) =>
    rpcMethod === "tools/call"
      ? {
          content: [
            {
              type: "text",
              text: `echo ${String((params?.arguments as { n?: number })?.n)}`,
            },
          ],
        }
      : { tools };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const entry: Seen = {
        httpMethod: req.method ?? "",
        sessionId: req.headers["mcp-session-id"] as string | undefined,
        accept: req.headers.accept,
        protocolVersion: req.headers["mcp-protocol-version"] as
          | string
          | undefined,
      };
      seen.push(entry);
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: unknown;
        method: string;
        params?: Record<string, unknown>;
      };
      entry.rpcMethod = message.method;
      entry.id = message.id;
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const replyJson = (result: unknown, headers = {}) => {
        res.writeHead(200, {
          "content-type": "application/json",
          ...headers,
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method === "initialize") {
        replyJson(
          {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "three-streams", version: "1.0.0" },
          },
          { "mcp-session-id": SESSION_ID },
        );
        return;
      }
      if (message.method !== gate) {
        replyJson(answerFor(message.method, message.params));
        return;
      }

      // Open the stream and say nothing on it yet.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(": open\n\n");
      open.push({ res, id: message.id, params: message.params });
      peak = Math.max(peak, open.length);
      if (open.length < 3) return;
      // Three are open: answer the last one first.
      for (const stream of open.splice(0).reverse()) {
        answeredOrder.push(stream.id);
        stream.res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: stream.id,
            result: answerFor(gate, stream.params),
          })}\n\n`,
        );
        stream.res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seen,
    peakOpenStreams: () => peak,
    answeredOrder,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of open) stream.res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => {});
  }
});

describe("the conformance probe", () => {
  it("holds three streams open at once and reads each answer from its own", async () => {
    const served = await serve("tools/list");
    cleanups.push(served.close);

    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2025-11-25",
      checkTimeout: 5_000,
      checkIds: [SSE],
      readinessIds: [],
    }).run();

    expect(served.peakOpenStreams()).toBe(3);
    const probes = served.seen.filter(
      (request) => request.rpcMethod === "tools/list",
    );
    expect(probes).toHaveLength(3);
    // The client MUSTs each of them keeps while the three are in flight.
    for (const probe of probes) {
      expect(probe.httpMethod).toBe("POST");
      expect(probe.accept).toContain("application/json");
      expect(probe.accept).toContain("text/event-stream");
      expect(probe.sessionId).toBe(SESSION_ID);
      expect(probe.protocolVersion).toBe("2025-11-25");
    }
    expect(new Set(probes.map((probe) => probe.id)).size).toBe(3);

    const sse = result.checks.find((check) => check.id === SSE);
    expect(sse?.status).toBe("passed");
    expect(sse?.details).toMatchObject({ sseStreamCount: 3 });
  });

  it("no longer grades the server on accepting them", async () => {
    // An old pick of the removed check still runs, next to another check, and
    // reports nothing under the removed id.
    const served = await serve("tools/list");
    cleanups.push(served.close);

    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2025-11-25",
      checkTimeout: 5_000,
      checkIds: [REMOVED, SSE],
      readinessIds: [],
    }).run();

    expect(result.checks.map((check) => check.id)).toEqual([SSE]);
    expect(result.checks[0]?.status).toBe("passed");
  });
});

describe("the MCPJam client", () => {
  it("keeps three calls open at once and matches each answer to its call", async () => {
    const served = await serve("tools/call");
    cleanups.push(served.close);
    const manager = new MCPClientManager();
    cleanups.push(() => manager.disconnectAllServers());
    await manager.connectToServer("three", {
      url: served.url,
      mcpProtocolVersion: "2025-11-25",
      timeout: 10_000,
    });

    const results = await Promise.all(
      [1, 2, 3].map((n) => manager.executeTool("three", "echo", { n })),
    );

    // Each call got its own answer, though the server answered them backwards.
    expect(
      results.map(
        (result) =>
          (result as { content: Array<{ text: string }> }).content[0]?.text,
      ),
    ).toEqual(["echo 1", "echo 2", "echo 3"]);
    expect(served.peakOpenStreams()).toBe(3);

    const calls = served.seen.filter(
      (request) => request.rpcMethod === "tools/call",
    );
    expect(calls).toHaveLength(3);
    expect(served.answeredOrder).toEqual(
      calls.map((call) => call.id).reverse(),
    );
    for (const call of calls) {
      expect(call.httpMethod).toBe("POST");
      expect(call.accept).toContain("application/json");
      expect(call.accept).toContain("text/event-stream");
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.protocolVersion).toBe("2025-11-25");
    }
    expect(new Set(calls.map((call) => call.id)).size).toBe(3);
  });
});
