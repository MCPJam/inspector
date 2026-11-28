/**
 * An `initialize` the server refuses because it does not speak the version the
 * run is pinned to.
 *
 * The server is allowed to refuse it, and the run chose the version, so no
 * check should cost the server points for it: each one could not run, as a
 * setup gap, the same as when the client connection is refused for the pin.
 *
 * Driven with a scripted server that logs every request in order.
 */

import { describe, expect, it } from "vitest";
import { computeConformanceScore } from "../../src/conformance-score.js";
import { runProtocolChecks } from "../../src/mcp-conformance/checks/protocol.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import { legacyInitialize } from "../../src/mcp-conformance/legacy-handshake.js";
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

const PINNED = "2025-11-25";

function context(
  options: LifecycleServerOptions,
  log: LifecycleLog
): RawHttpCheckContext {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://lifecycle.example.test/mcp",
    protocolVersion: PINNED,
    checkTimeout: 500,
    fetchFn: lifecycleServerFetch(options, log),
  });
  return { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn };
}

function byId(results: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = results.find((result) => result.id === id);
  if (!found) throw new Error(`check ${id} not in results`);
  return found;
}

/** A 2026-only server: HTTP 400 and the 2026 code. */
const ONLY_2026: LifecycleServerOptions = {
  refuseVersion: { status: 400, code: -32022, supported: ["2026-07-28"] },
};
const RUN_ON_2026 = `The server does not support protocol version ${PINNED}, which this run uses, so nothing could be checked on it. Run it on 2026-07-28 instead.`;

describe("legacyInitialize on a refused version", () => {
  it("stops as pin-refused, as a setup gap, and names the version to use", async () => {
    const log: LifecycleLog = [];
    const handshake = await legacyInitialize(context(ONLY_2026, log));

    expect(log).toEqual(["POST initialize"]);
    expect(handshake.stop).toEqual({
      kind: "pin-refused",
      message: RUN_ON_2026,
      details: {
        status: 400,
        error: { code: -32022, message: "Unsupported protocol version" },
        requestedProtocolVersion: PINNED,
        offeredProtocolVersions: ["2026-07-28"],
        missingInput: "protocolVersion",
        missingInputMessage: RUN_ON_2026,
      },
    });
  });

  it("reads the 2025 shape too: -32602 with supported and requested, on HTTP 200", async () => {
    const handshake = await legacyInitialize(
      context(
        {
          refuseVersion: {
            status: 200,
            code: -32602,
            supported: ["2025-03-26", "2025-06-18"],
          },
        },
        []
      )
    );

    expect(handshake.stop?.kind).toBe("pin-refused");
    expect(handshake.stop?.message).toBe(
      `The server does not support protocol version ${PINNED}, which this run uses, so nothing could be checked on it. Run it on one of 2025-03-26, 2025-06-18 instead.`
    );
    expect(handshake.stop?.details).toMatchObject({
      missingInput: "protocolVersion",
    });
  });

  it("is not a setup gap when the server offers only versions MCPJam does not speak", async () => {
    const handshake = await legacyInitialize(
      context(
        { refuseVersion: { status: 400, code: -32022, supported: ["2099-01-01"] } },
        []
      )
    );

    // No choice of version gets around that, so it stays a plain could-not-run.
    expect(handshake.stop?.kind).toBe("pin-refused");
    expect(handshake.stop?.message).toContain(
      "It offers only 2099-01-01, which MCPJam does not support."
    );
    expect(handshake.stop?.details).not.toHaveProperty("missingInput");
  });

  it("leaves any other refusal as a plain one", async () => {
    // -32603 says nothing about the version.
    const handshake = await legacyInitialize(
      context({ initialize: "rpc-error" }, [])
    );

    expect(handshake.stop?.kind).toBe("refused");
    expect(handshake.stop?.details).not.toHaveProperty("missingInput");
  });

  it("reads the 2025 shape only on -32602, not on an internal error that carries it", async () => {
    const handshake = await legacyInitialize(
      context(
        {
          refuseVersion: {
            status: 500,
            code: -32603,
            supported: ["2026-07-28"],
          },
        },
        []
      )
    );

    expect(handshake.stop?.kind).toBe("refused");
    expect(handshake.stop?.details).not.toHaveProperty("missingInput");
  });
});

describe("the checks on a server that refuses the pinned version", () => {
  const TRANSPORT: MCPCheckId[] = [
    "server-sse-polling-session",
    "session-id-visible-ascii",
    "server-sse-streams-functional",
    "notification-post-accepted",
    "get-stream-or-405",
  ];

  it("Invalid Method Error could not run, as a setup gap, and sends no probe", async () => {
    const log: LifecycleLog = [];
    const [check] = await runProtocolChecks(
      context(ONLY_2026, log),
      new Set<MCPCheckId>(["protocol-invalid-method-error"])
    );

    expect(log).toEqual(["POST initialize"]);
    expect([check.status, check.skipReason, check.error?.message]).toEqual([
      "skipped",
      "could-not-run",
      RUN_ON_2026,
    ]);
    expect(check.details).toMatchObject({ missingInput: "protocolVersion" });
  });

  it("no transport check fails or is blocked for it", async () => {
    const log: LifecycleLog = [];
    const results = await runTransportChecks(
      context(ONLY_2026, log),
      new Set<MCPCheckId>([...TRANSPORT, "post-response-content-type"])
    );

    expect(log).toEqual(["POST initialize"]);
    // On an HTTP 400 SSE Polling Session used to fail the server and block the
    // rest. A refused version is not a failed initialize.
    for (const id of TRANSPORT) {
      const check = byId(results, id);
      expect([id, check.status, check.skipReason, check.error?.message]).toEqual(
        [id, "skipped", "could-not-run", RUN_ON_2026]
      );
      expect(check.details).toMatchObject({ missingInput: "protocolVersion" });
    }
    // The refusal is still an MCP answer, and its framing is graded.
    expect(byId(results, "post-response-content-type").status).toBe("passed");
  });

  it("costs no points and leaves the run incomplete", async () => {
    const ctx = context(ONLY_2026, []);
    const results = [
      ...(await runProtocolChecks(
        ctx,
        new Set<MCPCheckId>(["protocol-invalid-method-error"])
      )),
      ...(await runTransportChecks(ctx, new Set(TRANSPORT))),
    ];
    const score = computeConformanceScore(results);

    expect(score.applicable).toBe(0);
    expect(score.outcome).toBe("incomplete");
  });

  it("a plain HTTP 400 on initialize still fails SSE Polling Session", async () => {
    const results = await runTransportChecks(
      context({ initialize: "http-400" }, []),
      new Set(TRANSPORT)
    );

    expect(byId(results, "server-sse-polling-session").status).toBe("failed");
  });
});
