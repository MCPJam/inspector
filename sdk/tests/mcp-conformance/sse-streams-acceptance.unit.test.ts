/**
 * Functional SSE Streams grades the streams the server sent back, not whether
 * it accepted all three concurrent POSTs.
 *
 * Nothing in the spec makes a server accept concurrent POSTs: "The client MAY
 * remain connected to multiple SSE streams simultaneously" (2025
 * `basic/transports.mdx`) is a client MAY, which is why Multiple POST Streams
 * was removed. A refused POST therefore costs the server nothing here; a
 * stream it did open must still be readable and, as "The SSE stream SHOULD
 * eventually include a JSON-RPC response for the JSON-RPC request sent in the
 * POST body" asks, carry the response to its own request. Any other event
 * is not enough.
 */

import { describe, expect, it } from "vitest";
import { decideConformanceOutcome } from "../../src/conformance-outcome.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import type {
  MCPCheckId,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const SSE: MCPCheckId = "server-sse-streams-functional";

type Answer =
  | "sse"
  | "json"
  | "broken-sse"
  | "429"
  | "throw"
  // A stream that carries only a notification, never the response.
  | "no-answer"
  // A stream that carries the response to some other request's id.
  | "wrong-id"
  // A notification first, then the response to this request.
  | "notice-then-answer"
  // The response is a JSON-RPC error, which is still the response.
  | "error-answer";

function json(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(chunks: Array<string | Error>) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          if (chunk instanceof Error) {
            controller.error(chunk);
            return;
          }
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

/**
 * A 2025 server that declares tools and answers the three concurrent
 * `tools/list` POSTs in the order given by `answers`.
 */
function server(answers: Answer[]) {
  let next = 0;
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method !== "POST") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
    };
    if (body.method === "initialize") {
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "acceptance", version: "1.0.0" },
          },
        },
        200,
        { "mcp-session-id": "session-1" }
      );
    }
    if (body.method !== "tools/list") {
      return new Response(null, { status: 202 });
    }
    const answer = answers[next++] ?? "sse";
    const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}\n\n`;
    const notice = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`;
    switch (answer) {
      case "sse":
        return sse([frame]);
      case "no-answer":
        return sse([notice]);
      case "wrong-id":
        return sse([
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { tools: [] } })}\n\n`,
        ]);
      case "notice-then-answer":
        return sse([notice, frame]);
      case "error-answer":
        return sse([
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Internal error" } })}\n\n`,
        ]);
      case "broken-sse":
        return sse([new Error("stream boom")]);
      case "json":
        return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      case "429":
        return json(
          {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "Too many requests" },
          },
          429
        );
      case "throw":
        throw new Error("connection reset");
    }
  }) as typeof fetch;
}

async function run(answers: Answer[]) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://acceptance.example.test/mcp",
    protocolVersion: "2025-11-25",
    checkTimeout: 500,
    fetchFn: server(answers),
  });
  const ctx: RawHttpCheckContext = {
    config,
    serverUrl: config.serverUrl,
    fetchFn: config.fetchFn,
  };
  const results = await runTransportChecks(ctx, new Set([SSE]));
  const result = results.find((entry) => entry.id === SSE);
  if (!result) throw new Error(`${SSE} not in results`);
  return result;
}

describe("Functional SSE Streams grades only the streams that came back", () => {
  it("passes when two streams are readable and the third POST is refused", async () => {
    const result = await run(["sse", "sse", "429"]);

    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({
      eventCounts: [1, 1],
      sseStreamCount: 2,
      statuses: [200, 200, 429],
    });
  });

  it("passes when two streams are readable and the third request errors", async () => {
    const result = await run(["sse", "throw", "sse"]);

    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({ eventCounts: [1, 1] });
  });

  it("still fails a stream that came back unreadable, whatever happened to the others", async () => {
    const result = await run(["sse", "broken-sse", "429"]);

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain(
      "ended without the JSON-RPC response to its request"
    );
    expect(result.details).toMatchObject({
      // The probe varies with the declared capabilities; a failure names it.
      probeMethod: "tools/list",
      eventCounts: [1, 0],
      unansweredStreams: [1],
      readErrors: [undefined, expect.stringContaining("stream boom")],
    });
  });

  it("is not applicable when the server turns every POST down, and the run can still pass", async () => {
    const result = await run(["429", "429", "429"]);

    // A refusal is an answer: the server chose not to take concurrent
    // requests, which it may, so there is no stream behavior to grade.
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("not-applicable");
    expect(result.error?.message).toContain(
      "The server turned down all three concurrent requests (HTTP 429, 429, 429)"
    );
    expect(result.details).toMatchObject({
      probeMethod: "tools/list",
      statuses: [429, 429, 429],
    });
    expect(decideConformanceOutcome([result]).outcome).not.toBe("incomplete");
  });

  it("could not run when every request errored before an answer", async () => {
    const result = await run(["throw", "throw", "throw"]);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("could-not-run");
    expect(result.error?.message).toContain(
      "None of the three concurrent requests was accepted"
    );
    expect(result.details).toMatchObject({ probeMethod: "tools/list" });
  });

  it("could not run when a request errored and the rest were turned down", async () => {
    // Whether the errored request would have streamed is unknown.
    const result = await run(["429", "throw", "429"]);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("could-not-run");
    expect(result.details).toMatchObject({
      probeMethod: "tools/list",
      statuses: [429, null, 429],
    });
  });

  it("judges the JSON answers it got when another POST was refused", async () => {
    const result = await run(["json", "429", "json"]);

    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({ probeMethod: "tools/list" });
  });
});

describe("Functional SSE Streams needs each stream to carry its own response", () => {
  it("fails a readable stream that never sends the response", async () => {
    // A complete event arrived, but it is a notification, not the answer.
    const result = await run(["sse", "no-answer", "sse"]);

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(
      "One or more concurrent SSE streams ended without the JSON-RPC response to its request"
    );
    expect(result.details).toMatchObject({
      eventCounts: [1, 1, 1],
      unansweredStreams: [1],
    });
  });

  it("fails a stream that carries the response to another request", async () => {
    const result = await run(["sse", "sse", "wrong-id"]);

    expect(result.status).toBe("failed");
    expect(result.details).toMatchObject({ unansweredStreams: [2] });
  });

  it("passes a stream that sends a notification before its response", async () => {
    const result = await run(["notice-then-answer", "sse", "sse"]);

    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({ eventCounts: [2, 1, 1] });
  });

  it("counts a JSON-RPC error on the stream as its response", async () => {
    const result = await run(["error-answer", "sse", "sse"]);

    expect(result.status).toBe("passed");
  });
});
