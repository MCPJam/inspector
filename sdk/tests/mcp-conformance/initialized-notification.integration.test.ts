/**
 * Full runs against a real HTTP server that keeps to the lifecycle strictly:
 * until `notifications/initialized` arrives on a session, it answers every
 * request but `ping` with HTTP 400. SDK-built servers behave this way.
 *
 * A probe that skips the notification gets that 400, and the check behind it
 * blames the server for an answer MCPJam caused. The server logs each request,
 * so the assertions are about what reached it, and in what order.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPConformanceConfig,
} from "../../src/mcp-conformance/index.js";
import {
  serveLifecycle,
  type ServedLifecycle,
} from "../support/lifecycle-http.js";
import type { LifecycleServerOptions } from "../support/lifecycle-server.js";

const READY = "POST notifications/initialized";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function run(
  options: LifecycleServerOptions,
  config: Partial<MCPConformanceConfig> & { checkIds: MCPCheckId[] }
): Promise<{
  served: ServedLifecycle;
  status: (id: MCPCheckId) => string | undefined;
  message: (id: MCPCheckId) => string | undefined;
}> {
  const served = await serveLifecycle(options);
  cleanups.push(served.close);
  const result = await new MCPConformanceTest({
    serverUrl: served.url,
    protocolVersion: "2025-11-25",
    checkTimeout: 5_000,
    // Advice opens sessions of its own; each test says when it wants it.
    readinessIds: [],
    ...config,
  }).run();
  const find = (id: MCPCheckId) =>
    result.checks.find((check) => check.id === id);
  return {
    served,
    status: (id) => find(id)?.status,
    message: (id) => find(id)?.error?.message,
  };
}

const count = (log: string[], line: string) =>
  log.filter((entry) => entry === line).length;

describe("a server that refuses requests before the initialized notification", () => {
  it("answers the invalid-method probe, so the check grades the server", async () => {
    const { served, status, message } = await run(
      { strict: true },
      { checkIds: ["protocol-invalid-method-error"] }
    );

    expect(served.log).toEqual([
      "POST initialize",
      READY,
      "POST nonexistent/method_that_does_not_exist",
    ]);
    // Without the notification the probe is refused with -32600, and the check
    // fails the server: "Expected JSON-RPC error code -32601".
    expect([
      status("protocol-invalid-method-error"),
      message("protocol-invalid-method-error"),
    ]).toEqual(["passed", undefined]);
  });

  it("accepts the concurrent requests and the GET that follow the handshake", async () => {
    const ids: MCPCheckId[] = [
      "server-accepts-multiple-post-streams",
      "server-sse-streams-functional",
      "notification-post-accepted",
      "get-stream-or-405",
    ];
    const { served, status } = await run(
      { strict: true, sse: true },
      { checkIds: ids }
    );

    for (const id of ids) expect([id, status(id)]).toEqual([id, "passed"]);
    // One session, one notification, sent before the first request on it.
    expect(count(served.log, "POST initialize")).toBe(1);
    expect(count(served.log, READY)).toBe(1);
    expect(served.log.indexOf(READY)).toBe(1);
  });

  it("gets the notification on every session a run opens", async () => {
    const { served } = await run(
      { strict: true },
      {
        checkIds: [
          "protocol-invalid-method-error",
          "server-sse-polling-session",
        ],
        readinessIds: ["readiness-session-termination"],
      }
    );

    // The protocol check, the transport checks and the advice each open one.
    expect(count(served.log, "POST initialize")).toBe(3);
    expect(count(served.log, READY)).toBe(3);
  });
});

describe("a server that does not take the notification", () => {
  it("fails Notification POST Accepted and nothing else", async () => {
    const { status, message } = await run(
      { initialized: "ok-200" },
      {
        checkIds: [
          "protocol-invalid-method-error",
          "notification-post-accepted",
          "get-stream-or-405",
        ],
      }
    );

    expect(status("notification-post-accepted")).toBe("failed");
    expect(message("notification-post-accepted")).toContain("got HTTP 200");
    // The other probes still ran: the handshake's notification is graded by
    // its own check, not turned into a reason to stop.
    expect(status("protocol-invalid-method-error")).toBe("passed");
    expect(status("get-stream-or-405")).toBe("passed");
  });
});
