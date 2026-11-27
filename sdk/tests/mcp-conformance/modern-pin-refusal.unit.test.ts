/**
 * A 2026-era pinned run with no client check, against a server that does not
 * speak the pin.
 *
 * Such a run skips the client connect, and 2026 has no handshake, so the
 * runner asks once with `server/discover`. A refusal there stops the run as the
 * client path does: every selected check could not run, as a setup gap, and no
 * raw probe goes out to draw the same refusal and grade it.
 */

import { describe, expect, it } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/runner.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";

const PINNED = "2026-07-28";
const CHECK_IDS: MCPCheckId[] = [
  "protocol-invalid-method-error",
  "modern-server-discover",
  "modern-method-header-mismatch",
];

/** Answers every POST the same way and logs each JSON-RPC method sent. */
function refusingFetch(
  status: number,
  error: { code: number; message: string; data?: unknown },
  log: string[]
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: unknown;
      method?: string;
    };
    log.push(body.method ?? "?");
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
}

function run(fetchFn: typeof fetch, checkIds: MCPCheckId[] = CHECK_IDS) {
  return new MCPConformanceTest({
    serverUrl: "https://refusing.example.test/mcp",
    protocolVersion: PINNED,
    checkIds,
    checkTimeout: 500,
    fetchFn,
    __suppressTelemetry: true,
  }).run();
}

describe("a raw-only 2026 pin the server refuses", () => {
  it("stops on the 2026 refusal (-32022) after one server/discover", async () => {
    const log: string[] = [];
    const result = await run(
      refusingFetch(
        400,
        {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: ["2025-11-25"], requested: PINNED },
        },
        log
      )
    );

    const message = `The server does not support protocol version ${PINNED}, which this run uses, so nothing could be checked on it. Run it on 2025-11-25 instead.`;
    expect(log).toEqual(["server/discover"]);
    expect(result.outcome).toBe("incomplete");
    expect(result.checks.map((check) => check.id).sort()).toEqual(
      [...CHECK_IDS].sort()
    );
    for (const check of result.checks) {
      expect(check.status).toBe("skipped");
      expect(check.skipReason).toBe("could-not-run");
      expect(check.error?.message ?? check.details?.missingInputMessage).toBe(
        message
      );
      expect(check.details).toMatchObject({
        status: 400,
        error: { code: -32022, message: "Unsupported protocol version" },
        requestedProtocolVersion: PINNED,
        offeredProtocolVersions: ["2025-11-25"],
        missingInput: "protocolVersion",
      });
    }
  });

  it("stops on a 2025 server's 400 + -32000 and names the versions it lists", async () => {
    const log: string[] = [];
    const result = await run(
      refusingFetch(
        400,
        {
          code: -32000,
          message: `Bad Request: Unsupported protocol version: ${PINNED} (supported versions: 2025-11-25, 2025-06-18)`,
        },
        log
      )
    );

    expect(log).toEqual(["server/discover"]);
    expect(result.outcome).toBe("incomplete");
    for (const check of result.checks) {
      expect(check.skipReason).toBe("could-not-run");
      expect(check.details).toMatchObject({
        status: 400,
        offeredProtocolVersions: ["2025-11-25", "2025-06-18"],
        missingInput: "protocolVersion",
      });
    }
  });

  it("stops on a stateful 2025 server's 400 + -32000 that names no version", async () => {
    const log: string[] = [];
    const result = await run(
      refusingFetch(
        400,
        { code: -32000, message: "Bad Request: Server not initialized" },
        log
      )
    );

    expect(log).toEqual(["server/discover"]);
    for (const check of result.checks) {
      expect(check.skipReason).toBe("could-not-run");
      expect(check.details).toMatchObject({
        offeredProtocolVersions: [],
        missingInput: "protocolVersion",
        missingInputMessage: `The server does not support protocol version ${PINNED}, which this run uses, so nothing could be checked on it. Run it on a version the server supports instead.`,
      });
    }
  });

  it("keeps a legacy-only check not-applicable, as on any 2026 run", async () => {
    const result = await run(
      refusingFetch(
        400,
        {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: ["2025-11-25"] },
        },
        []
      ),
      ["protocol-invalid-method-error", "server-sse-polling-session"]
    );

    const polling = result.checks.find(
      (check) => check.id === "server-sse-polling-session"
    );
    expect(polling?.skipReason).toBe("not-applicable");
    const invalidMethod = result.checks.find(
      (check) => check.id === "protocol-invalid-method-error"
    );
    expect(invalidMethod?.skipReason).toBe("could-not-run");
  });
});

describe("a raw-only 2026 pin the server does not refuse", () => {
  it("runs the checks when the error is not a version refusal", async () => {
    const log: string[] = [];
    // 404 with -32601: what a 2026-07-28 server MUST answer an unknown method.
    const result = await run(
      refusingFetch(
        404,
        { code: -32601, message: "Method not found" },
        log
      ),
      ["protocol-invalid-method-error"]
    );

    // The gate first, then the check's own probe (and the run's advice).
    expect(log[0]).toBe("server/discover");
    expect(log).toContain("nonexistent/method_that_does_not_exist");
    expect(result.checks[0]?.status).toBe("passed");
  });

  it("asks server/discover once: Server Discover grades the gate's answer", async () => {
    const log: string[] = [];
    // No advice: its own probes are not what this counts.
    const result = await new MCPConformanceTest({
      serverUrl: "https://refusing.example.test/mcp",
      protocolVersion: PINNED,
      checkIds: ["modern-server-discover"],
      readinessIds: [],
      checkTimeout: 500,
      fetchFn: refusingFetch(
        200,
        { code: -32601, message: "Method not found" },
        log
      ),
      __suppressTelemetry: true,
    }).run();

    expect(log).toEqual(["server/discover"]);
    expect(result.checks[0]?.status).toBe("failed");
  });

  it("runs the checks when the gate itself could not reach the server", async () => {
    let calls = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return refusingFetch(404, { code: -32601, message: "Method not found" }, [])(
        input,
        init
      );
    }) as typeof fetch;

    const result = await run(flaky, ["protocol-invalid-method-error"]);

    expect(calls).toBeGreaterThan(1);
    expect(result.checks[0]?.status).toBe("passed");
  });
});
