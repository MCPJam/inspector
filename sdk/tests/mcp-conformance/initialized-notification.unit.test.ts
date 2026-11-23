/**
 * The `notifications/initialized` POST on the hand-built 2025-era sessions.
 *
 * "After successful initialization, the client MUST send an `initialized`
 * notification to indicate it is ready to begin normal operations." Several
 * checks open their own session by hand, because they have to send a request
 * the normal client would not. They used to send `initialize`, take the
 * session id and go straight to work, without ever saying "ready".
 *
 * Driven with a scripted server that logs every request in order.
 */

import { describe, expect, it } from "vitest";
import { runProtocolChecks } from "../../src/mcp-conformance/checks/protocol.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import { legacyInitialize } from "../../src/mcp-conformance/legacy-handshake.js";
import { collectRawReadiness } from "../../src/mcp-conformance/readiness.js";
import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import {
  lifecycleServerFetch,
  type LifecycleLog,
  type LifecycleServerOptions,
} from "../support/lifecycle-server.js";

type LegacyVersion = "2025-11-25" | "2025-06-18" | "2025-03-26";
const LEGACY_VERSIONS: LegacyVersion[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
const READY = "POST notifications/initialized";

function context(
  options: LifecycleServerOptions,
  log: LifecycleLog,
  extra: {
    protocolVersion?: LegacyVersion;
    seenHeaders?: Headers[];
    readinessIds?: string[];
  } = {}
): RawHttpCheckContext {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://lifecycle.example.test/mcp",
    protocolVersion: extra.protocolVersion ?? "2025-11-25",
    checkTimeout: 500,
    fetchFn: lifecycleServerFetch(options, log, extra.seenHeaders),
    ...(extra.readinessIds
      ? { readinessIds: extra.readinessIds as never }
      : {}),
  });
  return { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn };
}

const count = (log: LifecycleLog, line: string) =>
  log.filter((entry) => entry === line).length;

function byId(results: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = results.find((result) => result.id === id);
  if (!found) throw new Error(`check ${id} not in results`);
  return found;
}

describe("legacyInitialize completes the handshake", () => {
  it("sends initialized right after a good initialize, once", async () => {
    const log: LifecycleLog = [];
    const seenHeaders: Headers[] = [];
    const handshake = await legacyInitialize(context({}, log, { seenHeaders }));

    expect(log).toEqual(["POST initialize", READY]);
    expect(handshake.initialized?.response?.status).toBe(202);
    expect(handshake.initialized?.error).toBeUndefined();
    // On the session it just opened, with the version the server agreed to.
    expect(seenHeaders[1].get("mcp-session-id")).toBe("session-1");
    expect(seenHeaders[1].get("mcp-protocol-version")).toBe("2025-11-25");
  });

  it("sends it to a server that assigns no session id too", async () => {
    const log: LifecycleLog = [];
    const seenHeaders: Headers[] = [];
    const handshake = await legacyInitialize(
      context({ stateless: true }, log, { seenHeaders })
    );

    expect(log).toEqual(["POST initialize", READY]);
    expect(handshake.sessionId).toBeUndefined();
    expect(seenHeaders[1].has("mcp-session-id")).toBe(false);
  });

  it.each([
    ["refuses initialize with an HTTP 400", { initialize: "http-400" }],
    ["answers initialize with a JSON-RPC error", { initialize: "rpc-error" }],
  ] as Array<[string, LifecycleServerOptions]>)(
    "sends nothing when the server %s",
    async (_why, options) => {
      const log: LifecycleLog = [];
      const handshake = await legacyInitialize(context(options, log));

      // No successful initialization, so there is nothing to complete.
      expect(log).toEqual(["POST initialize"]);
      expect(handshake.initialized).toBeUndefined();
    }
  );

  it("records a notification that could not be delivered instead of throwing", async () => {
    const log: LifecycleLog = [];
    const handshake = await legacyInitialize(
      context({ initialized: "unreachable" }, log)
    );

    expect(handshake.initialized?.response).toBeUndefined();
    expect(handshake.initialized?.error).toBe("connection reset");
    // The handshake's own answer is still there for the caller to read.
    expect(handshake.sessionId).toBe("session-1");
  });
});

/** Each check here opens its own session and nothing else selected sends one. */
const ALONE: Array<[string, MCPCheckId, "protocol" | "transport"]> = [
  ["Invalid Method Error", "protocol-invalid-method-error", "protocol"],
  ["SSE Polling Session", "server-sse-polling-session", "transport"],
  ["Session Id Visible ASCII", "session-id-visible-ascii", "transport"],
  ["POST Response Content Type", "post-response-content-type", "transport"],
];

describe.each(LEGACY_VERSIONS)("a check run alone on %s", (protocolVersion) => {
  it.each(ALONE)(
    "%s says initialized before anything else",
    async (_title, id, family) => {
      const log: LifecycleLog = [];
      const ctx = context({}, log, { protocolVersion });
      const selected = new Set<MCPCheckId>([id]);
      const results =
        family === "protocol"
          ? await runProtocolChecks(ctx, selected)
          : await runTransportChecks(ctx, selected);

      expect(log.slice(0, 2)).toEqual(["POST initialize", READY]);
      expect(count(log, READY)).toBe(1);
      expect(results[0].status).toBe("passed");
    }
  );
});

describe("the session-termination advice", () => {
  it("says initialized before it ends the session", async () => {
    const log: LifecycleLog = [];
    await collectRawReadiness(
      context({}, log, { readinessIds: ["readiness-session-termination"] })
    );

    expect(log).toEqual(["POST initialize", READY, "DELETE"]);
  });
});

describe("the checks that use the session", () => {
  const USES_SESSION: MCPCheckId[] = [
    "server-accepts-multiple-post-streams",
    "server-sse-streams-functional",
    "notification-post-accepted",
    "get-stream-or-405",
  ];

  it("send initialized first, then their requests, and never a second one", async () => {
    const log: LifecycleLog = [];
    const results = await runTransportChecks(
      context({}, log),
      new Set(USES_SESSION)
    );

    expect(log.slice(0, 2)).toEqual(["POST initialize", READY]);
    // It used to go out after the three concurrent requests.
    expect(log.indexOf(READY)).toBeLessThan(log.indexOf("POST tools/list"));
    expect(count(log, READY)).toBe(1);
    for (const id of USES_SESSION) {
      expect([id, byId(results, id).status]).toEqual([id, "passed"]);
    }
  });

  it("are answered by a server that refuses requests before initialized", async () => {
    const log: LifecycleLog = [];
    const results = await runTransportChecks(
      context({ strict: true }, log),
      new Set(USES_SESSION)
    );

    for (const id of USES_SESSION) {
      expect([id, byId(results, id).status]).toEqual([id, "passed"]);
    }
  });
});

describe("Notification POST Accepted grades the handshake's notification", () => {
  const ID: MCPCheckId = "notification-post-accepted";
  const run = async (options: LifecycleServerOptions, log: LifecycleLog = []) =>
    byId(await runTransportChecks(context(options, log), new Set([ID])), ID);

  it("passes on 202 with no body, having sent it exactly once", async () => {
    const log: LifecycleLog = [];
    const check = await run({}, log);

    expect(check.status).toBe("passed");
    expect(check.details).toMatchObject({ status: 202 });
    expect(count(log, READY)).toBe(1);
  });

  it("fails a 202 that carries a body", async () => {
    const check = await run({ initialized: "accepted-with-body" });

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("included a body");
  });

  it("fails another status", async () => {
    const check = await run({ initialized: "ok-200" });

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("got HTTP 200");
  });

  it("could not run when the notification could not be delivered", async () => {
    const check = await run({ initialized: "unreachable" });

    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(check.error?.message).toBe(
      "Notification POST could not be delivered: connection reset"
    );
  });

  it("could not run when initialize answered a JSON-RPC error, and sends none", async () => {
    const log: LifecycleLog = [];
    const check = await run({ initialize: "rpc-error" }, log);

    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(check.error?.message).toBe(
      "Initialize did not succeed, so no initialized notification was sent"
    );
    expect(count(log, READY)).toBe(0);
  });
});
