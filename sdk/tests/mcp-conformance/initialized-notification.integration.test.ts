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
import { AUTHORIZATION_REQUIRED_MESSAGE } from "../../src/conformance-authorization.js";
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
  details: (id: MCPCheckId) => Record<string, unknown> | undefined;
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
    details: (id) => find(id)?.details as Record<string, unknown> | undefined,
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

describe("a server that answers initialize with a JSON-RPC error on HTTP 200", () => {
  it("gets one verdict from every check, and no request on a session", async () => {
    const ids: MCPCheckId[] = [
      "protocol-invalid-method-error",
      "server-sse-polling-session",
      "session-id-visible-ascii",
      "server-sse-streams-functional",
      "notification-post-accepted",
      "get-stream-or-405",
    ];
    const { served, status, message } = await run(
      { initialize: "rpc-error" },
      { checkIds: ids }
    );

    // The protocol check and the transport checks each asked once, and that
    // was all: no notification, no probe, no listing, no GET.
    expect(served.log).toEqual(["POST initialize", "POST initialize"]);
    // One reading of the same answer. SSE Polling Session used to say
    // "Server initialized successfully" next to a check saying it had not.
    for (const id of ids) {
      expect([id, status(id), message(id)]).toEqual([
        id,
        "skipped",
        "The server answered initialize with a JSON-RPC error (-32603: Internal error), so the handshake did not complete. This check sent nothing more and could not run.",
      ]);
    }
  });
});

describe("a server that asks for a login on initialize", () => {
  it("is still told to connect, and is not sent the probe", async () => {
    const { served, status, message, details } = await run(
      { initialize: "http-401" },
      { checkIds: ["protocol-invalid-method-error"] }
    );

    // The stop carries the 401 under `status`, the key the runner reads, so
    // the check keeps the "connect first" wording and the reconnect marker.
    expect(served.log).toEqual(["POST initialize"]);
    expect(status("protocol-invalid-method-error")).toBe("skipped");
    expect(message("protocol-invalid-method-error")).toBe(
      AUTHORIZATION_REQUIRED_MESSAGE
    );
    expect(details("protocol-invalid-method-error")).toMatchObject({
      status: 401,
    });
  });
});

describe("a server that does not speak the pinned version", () => {
  it("is not failed for refusing it: every check is a setup gap", async () => {
    const ids: MCPCheckId[] = [
      "protocol-invalid-method-error",
      "server-sse-polling-session",
      "server-sse-streams-functional",
      "get-stream-or-405",
    ];
    // What a 2026-only server answers a 2025 initialize.
    const { served, status, message, details } = await run(
      { refuseVersion: { status: 400, code: -32022, supported: ["2026-07-28"] } },
      { checkIds: ids }
    );

    expect(served.log).toEqual(["POST initialize", "POST initialize"]);
    for (const id of ids) {
      expect([id, status(id), message(id)]).toEqual([
        id,
        "skipped",
        "The server does not support protocol version 2025-11-25, which this run uses, so nothing could be checked on it. Run it on 2026-07-28 instead.",
      ]);
      // The marker that keeps it out of the score and offers the other version.
      expect(details(id)).toMatchObject({
        missingInput: "protocolVersion",
        offeredProtocolVersions: ["2026-07-28"],
      });
    }
  });
});

describe("a strict server the notification never reaches", () => {
  it("is not sent the probes it would refuse", async () => {
    const { served, status, message } = await run(
      { strict: true, initialized: "unreachable" },
      {
        checkIds: [
          "protocol-invalid-method-error",
          "server-sse-streams-functional",
          "get-stream-or-405",
        ],
      }
    );

    // Sent anyway, the probe drew -32600 and Invalid Method Error failed the
    // server: "Expected JSON-RPC error code -32601 ... got -32600".
    for (const id of [
      "protocol-invalid-method-error",
      "server-sse-streams-functional",
      "get-stream-or-405",
    ] as MCPCheckId[]) {
      expect([id, status(id)]).toEqual([id, "skipped"]);
      expect(message(id)).toContain(
        "The initialized notification that ends the handshake could not be delivered"
      );
    }
    expect(served.log).not.toContain(
      "POST nonexistent/method_that_does_not_exist"
    );
    expect(served.log).not.toContain("POST tools/list");
    expect(served.log).not.toContain("GET");
  });
});

describe("a server that answers the notification with a body that is not JSON-RPC", () => {
  const origins = (details: Record<string, unknown> | undefined) =>
    ((details?.violations ?? []) as Array<{ origin: string }>).map(
      (violation) => violation.origin
    );

  it("is not failed by the wire check for a notification no selected check grades", async () => {
    const { served, status } = await run(
      { initialized: "ok-200-json" },
      {
        checkIds: ["protocol-invalid-method-error", "wire-schema-valid"],
        readinessIds: ["readiness-session-termination"],
      }
    );

    // Two sessions, two notifications. On main neither was sent, so the wire
    // check had nothing to list here; it still has nothing.
    expect(count(served.log, READY)).toBe(2);
    expect(status("wire-schema-valid")).toBe("passed");
  });

  it("is listed once when Notification POST Accepted is in the run", async () => {
    const { served, status, details } = await run(
      { initialized: "ok-200-json" },
      {
        checkIds: [
          "protocol-invalid-method-error",
          "notification-post-accepted",
          "wire-schema-valid",
        ],
        readinessIds: ["readiness-session-termination"],
      }
    );

    expect(count(served.log, READY)).toBe(3);
    expect(status("notification-post-accepted")).toBe("failed");
    expect(status("wire-schema-valid")).toBe("failed");
    // Three were sent; the report names the defect once.
    expect(origins(details("wire-schema-valid"))).toEqual([READY]);
  });
});
