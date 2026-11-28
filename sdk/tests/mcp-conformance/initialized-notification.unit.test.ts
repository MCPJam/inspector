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
import {
  collectRawAdvice,
  collectRawReadiness,
} from "../../src/mcp-conformance/readiness.js";
import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import { WireObservationRecorder } from "../../src/mcp-conformance/wire-observations.js";
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
const REFUSED_HTTP =
  "The server answered initialize with a JSON-RPC error (-32600: Invalid Request), so the handshake did not complete. This check sent nothing more and could not run.";
const REFUSED_RPC =
  "The server answered initialize with a JSON-RPC error (-32603: Internal error), so the handshake did not complete. This check sent nothing more and could not run.";
const UNDELIVERED =
  "The initialized notification that ends the handshake could not be delivered (connection reset). This check sent nothing more and could not run.";

function context(
  options: LifecycleServerOptions,
  log: LifecycleLog,
  extra: {
    protocolVersion?: LegacyVersion;
    seenHeaders?: Headers[];
    readinessIds?: string[];
    recorder?: WireObservationRecorder;
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
  return {
    config,
    serverUrl: config.serverUrl,
    fetchFn: config.fetchFn,
    ...(extra.recorder ? { recorder: extra.recorder } : {}),
  };
}

const couldNotRun = (check: MCPCheckResult) => [
  check.status,
  check.skipReason,
  check.error?.message,
];

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
    // Ready: no stop, and the server's answer to the notification is there.
    expect(handshake.stop).toBeUndefined();
    expect(handshake.initialized?.response.status).toBe(202);
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
    [
      "refuses initialize with an HTTP 400",
      { initialize: "http-400" },
      REFUSED_HTTP,
      { status: 400, error: { code: -32600, message: "Invalid Request" } },
    ],
    [
      "answers initialize with a bare HTTP 500",
      { initialize: "http-500-bare" },
      "The server answered initialize with HTTP 500, so the handshake did not complete. This check sent nothing more and could not run.",
      { status: 500 },
    ],
    [
      "answers initialize with a JSON-RPC error on HTTP 200",
      { initialize: "rpc-error" },
      REFUSED_RPC,
      { status: 200, error: { code: -32603, message: "Internal error" } },
    ],
  ] as Array<[string, LifecycleServerOptions, string, object]>)(
    "stops as refused, and sends nothing, when the server %s",
    async (_why, options, message, details) => {
      const log: LifecycleLog = [];
      const handshake = await legacyInitialize(context(options, log));

      // No successful initialization, so there is nothing to complete.
      expect(log).toEqual(["POST initialize"]);
      expect(handshake.initialized).toBeUndefined();
      expect(handshake.stop).toEqual({ kind: "refused", message, details });
    }
  );

  it("stops as undelivered when the notification does not reach the server", async () => {
    const log: LifecycleLog = [];
    const handshake = await legacyInitialize(
      context({ initialized: "unreachable" }, log)
    );

    // Recorded, not thrown, and the handshake's own answer is still there.
    expect(handshake.initialized).toMatchObject({ error: "connection reset" });
    expect(handshake.sessionId).toBe("session-1");
    expect(handshake.stop).toEqual({
      kind: "undelivered",
      message: UNDELIVERED,
      details: { initializedError: "connection reset" },
    });
  });

  it("does not stop on a notification the server answered badly", async () => {
    // The server got it. What it answered is Notification POST Accepted's to
    // grade, not a reason to send nothing else.
    const handshake = await legacyInitialize(
      context({ initialized: "ok-200" }, [])
    );

    expect(handshake.stop).toBeUndefined();
    expect(handshake.initialized?.response.status).toBe(200);
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

  it.each(LEGACY_VERSIONS)(
    "could not verify acceptance after an HTTP 400 refusal on %s",
    async (protocolVersion) => {
      const log: LifecycleLog = [];
      const ctx = context({ initialized: "http-400" }, log, { protocolVersion });
      const check = byId(await runTransportChecks(ctx, new Set([ID])), ID);

      expect(check).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
        details: { status: 400 },
        error: { message: expect.stringContaining("got HTTP 400") },
      });
      expect(count(log, READY)).toBe(1);
    }
  );

  it("could not verify acceptance after an HTTP 503 refusal", async () => {
    const check = await run({ initialized: "http-503" });

    expect(check).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
      details: { status: 503 },
    });
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

    expect(couldNotRun(check)).toEqual(["skipped", "could-not-run", UNDELIVERED]);
  });

  it("could not run when initialize answered a JSON-RPC error, and sends none", async () => {
    const log: LifecycleLog = [];
    const check = await run({ initialize: "rpc-error" }, log);

    expect(couldNotRun(check)).toEqual(["skipped", "could-not-run", REFUSED_RPC]);
    expect(count(log, READY)).toBe(0);
  });
});

const TRANSPORT: MCPCheckId[] = [
  "server-sse-polling-session",
  "post-response-content-type",
  "session-id-visible-ascii",
  "server-sse-streams-functional",
  "notification-post-accepted",
  "get-stream-or-405",
];
/** The transport checks that send requests on the session. */
const ON_SESSION = TRANSPORT.slice(3);
const INVALID_METHOD: MCPCheckId = "protocol-invalid-method-error";

describe("a run gives one verdict on a refused initialize", () => {
  // HTTP 200 with a JSON-RPC error: the status says yes, the body says no.
  const refusing: LifecycleServerOptions = { initialize: "rpc-error" };

  it("the transport checks all say it failed, and send nothing on a session", async () => {
    const log: LifecycleLog = [];
    const results = await runTransportChecks(
      context(refusing, log),
      new Set(TRANSPORT)
    );

    expect(log).toEqual(["POST initialize"]);
    // It used to read "Server initialized successfully without an
    // mcp-session-id header" here while Notification POST Accepted, in the
    // same run, said initialize did not succeed.
    for (const id of [
      "server-sse-polling-session",
      "session-id-visible-ascii",
      ...ON_SESSION,
    ] as MCPCheckId[]) {
      expect([id, ...couldNotRun(byId(results, id))]).toEqual([
        id,
        "skipped",
        "could-not-run",
        REFUSED_RPC,
      ]);
    }
    // The answer itself is still an MCP answer, and its framing is graded.
    expect(byId(results, "post-response-content-type").status).toBe("passed");
  });

  it("Invalid Method Error does not send its probe", async () => {
    const log: LifecycleLog = [];
    const results = await runProtocolChecks(
      context(refusing, log),
      new Set([INVALID_METHOD])
    );

    expect(log).toEqual(["POST initialize"]);
    expect(couldNotRun(results[0])).toEqual([
      "skipped",
      "could-not-run",
      REFUSED_RPC,
    ]);
    expect(results[0].details).toEqual({
      status: 200,
      error: { code: -32603, message: "Internal error" },
    });
  });

  it("Invalid Method Error does not send it after an HTTP 400 either", async () => {
    const log: LifecycleLog = [];
    const results = await runProtocolChecks(
      context({ initialize: "http-400" }, log),
      new Set([INVALID_METHOD])
    );

    expect(log).toEqual(["POST initialize"]);
    expect(couldNotRun(results[0])).toEqual([
      "skipped",
      "could-not-run",
      REFUSED_HTTP,
    ]);
  });

  it("an HTTP 400 still fails SSE Polling Session and blocks the rest, as before", async () => {
    const log: LifecycleLog = [];
    const results = await runTransportChecks(
      context({ initialize: "http-400" }, log),
      new Set(TRANSPORT)
    );

    expect(log).toEqual(["POST initialize"]);
    expect(byId(results, "server-sse-polling-session").status).toBe("failed");
    for (const id of ON_SESSION) {
      expect([id, byId(results, id).status]).toEqual([id, "skipped"]);
    }
  });
});

describe("a notification that could not be delivered stops the probes", () => {
  // Strict, so a probe sent anyway would be refused with -32600 and the check
  // behind it would blame the server for it.
  const lost: LifecycleServerOptions = {
    strict: true,
    initialized: "unreachable",
  };

  it("Invalid Method Error does not send its probe", async () => {
    const log: LifecycleLog = [];
    const results = await runProtocolChecks(
      context(lost, log),
      new Set([INVALID_METHOD])
    );

    expect(log).toEqual(["POST initialize", READY]);
    expect(couldNotRun(results[0])).toEqual([
      "skipped",
      "could-not-run",
      UNDELIVERED,
    ]);
  });

  it("the transport checks send nothing on the session but its DELETE", async () => {
    const log: LifecycleLog = [];
    const results = await runTransportChecks(
      context(lost, log),
      new Set(TRANSPORT)
    );

    expect(log).toEqual(["POST initialize", READY, "DELETE"]);
    for (const id of ON_SESSION) {
      expect([id, ...couldNotRun(byId(results, id))]).toEqual([
        id,
        "skipped",
        "could-not-run",
        UNDELIVERED,
      ]);
    }
    // The checks that read the initialize answer itself are still graded.
    for (const id of TRANSPORT.slice(0, 3)) {
      expect([id, byId(results, id).status]).toEqual([id, "passed"]);
    }
  });

  it("the session-termination advice closes the session and advises nothing", async () => {
    const log: LifecycleLog = [];
    const advice = await collectRawAdvice(
      context(lost, log, { readinessIds: ["readiness-session-termination"] })
    );

    expect(log).toEqual(["POST initialize", READY, "DELETE"]);
    expect(advice).toEqual([]);
  });
});

describe("the notification enters the wire record once", () => {
  // The server answers the notification with a body that is not JSON-RPC, so
  // every recorded copy is one more schema violation in the report.
  const chatty: LifecycleServerOptions = { initialized: "ok-200-json" };
  const recorded = (recorder: WireObservationRecorder) =>
    recorder.observations.filter((entry) => entry.origin === READY).length;

  it("not from Invalid Method Error or the advice", async () => {
    const recorder = new WireObservationRecorder();
    const log: LifecycleLog = [];
    const ctx = context(chatty, log, {
      recorder,
      readinessIds: ["readiness-session-termination"],
    });
    await runProtocolChecks(ctx, new Set([INVALID_METHOD]));
    await collectRawAdvice(ctx);

    // Both sent it, and neither is the check that grades it.
    expect(count(log, READY)).toBe(2);
    expect(recorded(recorder)).toBe(0);
  });

  it("not from the transport checks when Notification POST Accepted is not selected", async () => {
    const recorder = new WireObservationRecorder();
    await runTransportChecks(
      context(chatty, [], { recorder }),
      new Set<MCPCheckId>(["get-stream-or-405"])
    );

    expect(recorded(recorder)).toBe(0);
  });

  it("once, from the session Notification POST Accepted grades", async () => {
    const recorder = new WireObservationRecorder();
    const ctx = context(chatty, [], { recorder });
    await runProtocolChecks(ctx, new Set([INVALID_METHOD]));
    const results = await runTransportChecks(
      ctx,
      new Set<MCPCheckId>(["notification-post-accepted"])
    );

    expect(byId(results, "notification-post-accepted").status).toBe("failed");
    expect(recorded(recorder)).toBe(1);
  });
});
