/**
 * Check 11 (`protocol-invalid-method-error`) and the HTTP status of the answer.
 *
 * 2026-07-28: "If the server does not implement the requested RPC method, it
 * MUST respond with `404 Not Found` and a JSON-RPC error with code `-32601`"
 * (basic/transports/streamable-http.mdx:271-273). The check compared the code
 * and never the status, so a server that sent `-32601` on HTTP 200 passed.
 *
 * The 2025 revisions name no status for an unknown method, so there the code
 * alone is graded, as before.
 */

import {
  invalidMethodStatusProblem,
  runProtocolChecks,
} from "../../src/mcp-conformance/checks/protocol.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const SERVER_URL = "http://127.0.0.1:9/mcp";
const SELECTED = new Set<MCPCheckId>(["protocol-invalid-method-error"]);
const METHOD_NOT_FOUND = { code: -32601, message: "Method not found" };

interface Answer {
  status: number;
  /** The JSON-RPC error to answer with. Omit for a body with no error. */
  error?: { code: number; message: string };
  /** Frame the answer as one SSE event instead of a JSON document. */
  sse?: boolean;
}

/** A server that answers the unknown method the given way. */
function serverAnswering(answer: Answer): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      id?: unknown;
      method?: string;
    };
    if (request.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (request.id === undefined) return new Response(null, { status: 202 });
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      ...(answer.error ? { error: answer.error } : { result: {} }),
    });
    return answer.sse
      ? new Response(`event: message\ndata: ${message}\n\n`, {
          status: answer.status,
          headers: { "content-type": "text/event-stream" },
        })
      : new Response(message, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
  }) as unknown as typeof fetch;
}

async function grade(protocolVersion: string, answer: Answer) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    protocolVersion,
    fetchFn: serverAnswering(answer),
  } as never);
  const results = await runProtocolChecks(
    { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
    SELECTED,
  );
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe("invalidMethodStatusProblem", () => {
  it("has nothing to say about 404 on 2026-07-28", () => {
    expect(invalidMethodStatusProblem("modern", 404)).toBeUndefined();
  });

  it.each([200, 202, 400, 405, 500])(
    "names HTTP %i as the problem on 2026-07-28",
    (status) => {
      expect(invalidMethodStatusProblem("modern", status)).toBe(
        `Expected HTTP 404 Not Found with the -32601 error for an unrecognized method (required on 2026-07-28), got HTTP ${status}`,
      );
    },
  );

  it.each([200, 400, 404, 500])(
    "has no rule about HTTP %i on the 2025 revisions",
    (status) => {
      expect(invalidMethodStatusProblem("legacy", status)).toBeUndefined();
    },
  );
});

describe("check 11 on 2026-07-28: the status is graded with the code", () => {
  it("passes -32601 on HTTP 404", async () => {
    const result = await grade("2026-07-28", {
      status: 404,
      error: METHOD_NOT_FOUND,
    });

    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({ status: 404, errorCode: -32601 });
  });

  it("fails -32601 on HTTP 200, and says which status it wanted", async () => {
    // The case in the card: the right code on the wrong status used to pass.
    const result = await grade("2026-07-28", {
      status: 200,
      error: METHOD_NOT_FOUND,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(
      "Expected HTTP 404 Not Found with the -32601 error for an unrecognized method (required on 2026-07-28), got HTTP 200",
    );
    expect(result.details).toEqual({
      status: 200,
      expectedStatus: 404,
      error: { ...METHOD_NOT_FOUND, data: undefined },
    });
  });

  it.each([400, 405, 500])("fails -32601 on HTTP %i", async (status) => {
    const result = await grade("2026-07-28", {
      status,
      error: METHOD_NOT_FOUND,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain(`got HTTP ${status}`);
  });

  it("reads the code off an SSE answer too, and still wants 404", async () => {
    const onStream = { error: METHOD_NOT_FOUND, sse: true };

    expect((await grade("2026-07-28", { status: 404, ...onStream })).status).toBe(
      "passed",
    );
    expect((await grade("2026-07-28", { status: 200, ...onStream })).status).toBe(
      "failed",
    );
  });
});

describe("check 11 on 2026-07-28: what it already failed is reported as before", () => {
  it.each([404, 200])(
    "names the code first when the code is wrong (HTTP %i)",
    async (status) => {
      const result = await grade("2026-07-28", {
        status,
        error: { code: -32600, message: "Invalid request" },
      });

      expect(result.status).toBe("failed");
      expect(result.error?.message).toBe(
        "Expected JSON-RPC error code -32601 (Method not found) for an unrecognized method, got -32600",
      );
    },
  );

  it("fails a 404 that carries no JSON-RPC error", async () => {
    // The status alone is not the answer: the spec asks for both.
    const result = await grade("2026-07-28", { status: 404 });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(
      "Server did not return a JSON-RPC error object for an invalid method",
    );
  });
});

describe("check 11 on the 2025 revisions: no status rule, so nothing moves", () => {
  it.each(["2025-03-26", "2025-06-18", "2025-11-25"])(
    "passes -32601 on HTTP 200 on %s",
    async (version) => {
      const result = await grade(version, {
        status: 200,
        error: METHOD_NOT_FOUND,
      });

      expect(result.status).toBe("passed");
    },
  );

  it.each([400, 404])(
    "passes -32601 on HTTP %i on 2025-11-25, as it did",
    async (status) => {
      const result = await grade("2025-11-25", {
        status,
        error: METHOD_NOT_FOUND,
      });

      expect(result.status).toBe("passed");
      expect(result.details).toMatchObject({ status });
    },
  );
});
