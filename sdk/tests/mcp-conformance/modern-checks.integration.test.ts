/**
 * Phase 7 §15.3 — per-check coverage for the modern MUST set against fixtures
 * that exercise each requirement for real.
 *
 * The dual-era fixture (see `era.integration.test.ts`) proves the whole modern
 * set passes on a conforming server. This file targets the checks whose
 * evidence needs a server that actually DOES the thing: the MRTR fixture
 * requests input (undeclared-capability -32021), the logging fixture emits log
 * records (level-gated logging), and the cache fixture advertises a real TTL.
 *
 * Every raw rejection is asserted as TWO separate facts — the HTTP status from
 * the capture and the in-band JSON-RPC code — because the SDK delivers a 400
 * carrying a well-formed JSON-RPC error body in-band, so a single "it failed"
 * assertion cannot tell a transport rejection from a protocol error.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";
import { scoreFromProtocolResult } from "../../src/conformance-score.js";
import { runConformance } from "../../src/conformance-run.js";
import { createMrtrFixtureHandler } from "../support/mrtr-fixture.js";
import {
  createLoggingFixtureHandler,
  EMIT_LOG_TOOL_NAME,
} from "../support/logging-fixture.js";
import {
  CACHE_FIXTURE_TTL_MS,
  createCacheFixtureHandler,
} from "../support/cache-fixture.js";

const MODERN = "2026-07-28" as const;

const closers: Array<() => Promise<void>> = [];

async function serve(handler: McpHttpHandler): Promise<string> {
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const { port } = httpServer.address() as AddressInfo;
  closers.push(
    () => new Promise<void>((resolve) => httpServer.close(() => resolve()))
  );
  return `http://127.0.0.1:${port}/mcp`;
}

function byId(checks: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = checks.find((check) => check.id === id);
  if (!found) {
    throw new Error(`check ${id} not found in results`);
  }
  return found;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * The gmail/drive/calendar shape from the 2026-08-26 sweep: an endpoint that
 * refuses every modern request without a token.
 *
 * Raw HTTP rather than a fixture handler, because the point is that NOTHING
 * gets far enough to be a session — a handler that negotiates and then refuses
 * would still be a completed exchange.
 */
async function serveUnauthorized(): Promise<string> {
  const httpServer = http.createServer((_req, res) => {
    res
      .writeHead(401, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const { port } = httpServer.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${port}/mcp`;
}

describe("modern-no-session-id", () => {
  it("passes on a server that completes exchanges and mints no session id", async () => {
    const serverUrl = await serve(createCacheFixtureHandler());
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-no-session-id"],
      checkTimeout: 10_000,
    }).run();

    const check = byId(result.checks, "modern-no-session-id");
    expect(check.status).toBe("passed");
    // The pass is only meaningful because a real exchange succeeded — that is
    // what makes the absent header a decision rather than an accident.
    expect(
      Number(
        (check.details as { succeededResponses?: number })?.succeededResponses
      )
    ).toBeGreaterThan(0);
  });

  it("cannot run when no exchange succeeded: a dead session mints nothing", async () => {
    const serverUrl = await serveUnauthorized();
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-no-session-id"],
      checkTimeout: 10_000,
    }).run();

    const check = byId(result.checks, "modern-no-session-id");
    // Previously `passed`. A server that 401s everything cannot mint a session
    // id whether or not it would, so the empty offender list was a fact about
    // our access — and the servers that answered nothing were the ones this
    // scored check flattered most.
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("could-not-run");
    expect(check.error?.message).toMatch(/never in a position to mint/);
    expect(check.details).toMatchObject({ succeededResponses: 0 });
    expect(result.outcome).toBe("incomplete");
  });
});

describe("modern-undeclared-capability-error", () => {
  it("skips (never fails) when no inputRequiredProbe names a tool that asks for input", async () => {
    const serverUrl = await serve(createMrtrFixtureHandler());
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-undeclared-capability-error"],
      checkTimeout: 10_000,
    }).run();

    const check = byId(result.checks, "modern-undeclared-capability-error");
    expect(check.status).toBe("skipped");
    expect(check.error?.message).toMatch(/inputRequiredProbe/);
  });

  it("proves the -32021 rejection when the probed tool needs an undeclared capability", async () => {
    const serverUrl = await serve(createMrtrFixtureHandler());
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-undeclared-capability-error"],
      inputRequiredProbe: {
        toolName: "confirm",
        arguments: { topic: "conformance" },
      },
      checkTimeout: 10_000,
    }).run();

    const check = byId(result.checks, "modern-undeclared-capability-error");
    expect(check.status).toBe("passed");
    // Two separate facts: the HTTP status AND the in-band JSON-RPC code.
    expect(check.details).toMatchObject({
      httpStatus: 400,
      jsonRpcCode: -32021,
      probedTool: "confirm",
    });
  });
});

const LOGGING_CHECKS = [
  "modern-logs-require-log-level",
  "modern-log-level-filtering",
] as const;

describe("modern logging conformance", () => {
  for (const protocolVersion of [MODERN, undefined]) {
    it(`uses per-request logging with ${
      protocolVersion ?? "auto-detected"
    } version`, async () => {
      const serverUrl = await serve(
        createLoggingFixtureHandler({ mode: "conforming" })
      );
      const calls: Array<{ method: string; level?: string }> = [];
      const fetchFn: typeof fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({
          method: body.method,
          level: body.params?._meta?.["io.modelcontextprotocol/logLevel"],
        });
        return fetch(input, init);
      };
      const result = await new MCPConformanceTest({
        serverUrl,
        protocolVersion,
        fetchFn,
        checkIds: ["logging-set-level", ...LOGGING_CHECKS],
        logProbe: { toolName: EMIT_LOG_TOOL_NAME },
        checkTimeout: 10_000,
      }).run();

      expect(result.protocolVersion).toBe(MODERN);
      expect(byId(result.checks, "logging-set-level")).toMatchObject({
        status: "skipped",
        skipReason: "not-applicable",
      });
      for (const id of LOGGING_CHECKS) {
        expect(byId(result.checks, id).status).toBe("passed");
      }
      expect(byId(result.checks, LOGGING_CHECKS[0]).details).toMatchObject({
        logNotificationCount: 0,
        logNotificationCountWithLevel: 4,
      });
      expect(byId(result.checks, LOGGING_CHECKS[1]).details).toMatchObject({
        requestedLogLevel: "warning",
        levels: ["warning", "error"],
      });
      expect(calls.filter((call) => call.method === "tools/call")).toEqual([
        { method: "tools/call", level: undefined },
        { method: "tools/call", level: "debug" },
        { method: "tools/call", level: "warning" },
      ]);
      expect(calls.some((call) => call.method === "logging/setLevel")).toBe(
        false
      );
      expect(result.profile?.pendingCheckIds).toEqual([
        "modern-log-level-filtering",
      ]);
      expect(result.passed).toBe(true);
    });
  }

  it("keeps logging/setLevel on legacy servers and skips both modern checks", async () => {
    const serverUrl = await serve(
      createLoggingFixtureHandler({ mode: "conforming" })
    );
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: "2025-11-25",
      checkIds: ["logging-set-level", ...LOGGING_CHECKS],
      logProbe: { toolName: EMIT_LOG_TOOL_NAME },
      checkTimeout: 10_000,
    }).run();
    expect(byId(result.checks, "logging-set-level").status).toBe("passed");
    for (const id of LOGGING_CHECKS) {
      expect(byId(result.checks, id)).toMatchObject({
        status: "skipped",
        skipReason: "not-applicable",
      });
    }
    expect(result.passed).toBe(true);
  });

  it("fails a server that logs on a request carrying no log level", async () => {
    const serverUrl = await serve(createLoggingFixtureHandler());
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: [LOGGING_CHECKS[0]],
      logProbe: { toolName: EMIT_LOG_TOOL_NAME },
      checkTimeout: 10_000,
    }).run();
    const check = byId(result.checks, LOGGING_CHECKS[0]);
    expect(check.status).toBe("failed");
    expect(check.details).toMatchObject({ probedTool: EMIT_LOG_TOOL_NAME });
    expect(check.error?.message).toMatch(/no modern log level/);
    expect(result.passed).toBe(false);
  });

  it("fails filtering when a server emits debug, info, or notice for warning", async () => {
    const serverUrl = await serve(
      createLoggingFixtureHandler({
        mode: "ignores-level",
        levels: ["debug", "info", "notice", "warning", "error"],
      })
    );
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: [LOGGING_CHECKS[1]],
      logProbe: { toolName: EMIT_LOG_TOOL_NAME },
      checkTimeout: 10_000,
    }).run();
    expect(byId(result.checks, LOGGING_CHECKS[1])).toMatchObject({
      status: "failed",
      details: { invalidOrLowerLevels: ["debug", "info", "notice"] },
    });
    // The new check reports its failure but is not promoted into the frozen score.
    expect(result.profile?.pendingCheckIds).toEqual([LOGGING_CHECKS[1]]);
    expect(scoreFromProtocolResult(result).pending).toBe(1);
  });

  it("fails a silent warning response even when the debug request produces logs", async () => {
    const serverUrl = await serve(
      createLoggingFixtureHandler({
        mode: "conforming",
        levels: ["debug", "info"],
      })
    );
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: [...LOGGING_CHECKS],
      logProbe: { toolName: EMIT_LOG_TOOL_NAME },
      checkTimeout: 10_000,
    }).run();
    expect(byId(result.checks, LOGGING_CHECKS[0]).status).toBe("passed");
    expect(byId(result.checks, LOGGING_CHECKS[1])).toMatchObject({
      status: "failed",
      error: { message: "the supplied tool produced no logs." },
    });
  });

  it("accepts warning and every higher severity", async () => {
    const levels = [
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ] as const;
    const serverUrl = await serve(
      createLoggingFixtureHandler({ mode: "conforming", levels })
    );
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: [LOGGING_CHECKS[1]],
      logProbe: { toolName: EMIT_LOG_TOOL_NAME },
      checkTimeout: 10_000,
    }).run();
    expect(byId(result.checks, LOGGING_CHECKS[1])).toMatchObject({
      status: "passed",
      details: { levels: [...levels] },
    });
  });

  for (const id of LOGGING_CHECKS) {
    it(`${id}: fails a supplied tool that produces no requested logs`, async () => {
      const serverUrl = await serve(
        createLoggingFixtureHandler({ mode: "silent" })
      );
      const result = await new MCPConformanceTest({
        serverUrl,
        protocolVersion: MODERN,
        checkIds: [id],
        logProbe: { toolName: EMIT_LOG_TOOL_NAME },
        checkTimeout: 10_000,
      }).run();
      const check = byId(result.checks, id);
      expect(check.status).toBe("failed");
      expect(check.skipReason).toBeUndefined();
      expect(check.error?.message).toBe("the supplied tool produced no logs.");
      expect(check.details).toMatchObject({ logNotificationCountWithLevel: 0 });
      if (id === LOGGING_CHECKS[0]) expect(result.outcome).toBe("failed");
    });

    it(`${id}: cannot run without a logProbe`, async () => {
      const serverUrl = await serve(createLoggingFixtureHandler());
      const calls: string[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        calls.push(JSON.parse(String(init?.body)).method);
        return fetch(input, init);
      };
      const result = await new MCPConformanceTest({
        serverUrl,
        protocolVersion: MODERN,
        checkIds: [id],
        fetchFn,
        checkTimeout: 10_000,
      }).run();
      const check = byId(result.checks, id);
      expect(check).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
      });
      expect(check.error?.message).toMatch(/No logProbe configured/);
      expect(calls).not.toContain("tools/call");
      if (id === LOGGING_CHECKS[0]) expect(result.outcome).toBe("incomplete");
    });
  }

  for (const { id, failAt } of [
    { id: LOGGING_CHECKS[0], failAt: "unrequested" },
    { id: LOGGING_CHECKS[0], failAt: "debug" },
    { id: LOGGING_CHECKS[1], failAt: "warning" },
  ] as const) {
    it(`${id}: reports a tool error at ${failAt} as could-not-run`, async () => {
      const serverUrl = await serve(
        createLoggingFixtureHandler({ mode: "tool-error", failAt })
      );
      const result = await new MCPConformanceTest({
        serverUrl,
        protocolVersion: MODERN,
        checkIds: [id],
        logProbe: { toolName: EMIT_LOG_TOOL_NAME },
        checkTimeout: 10_000,
      }).run();
      expect(byId(result.checks, id)).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
        details: { toolError: true },
      });
    });
  }

  it("passes the configured logProbe through runConformance", async () => {
    const serverUrl = await serve(
      createLoggingFixtureHandler({ mode: "conforming" })
    );
    const report = await runConformance({
      server: { url: serverUrl },
      suites: ["protocol"],
      protocolVersion: MODERN,
      protocol: {
        checkIds: ["logging-set-level", ...LOGGING_CHECKS],
        logProbe: { toolName: EMIT_LOG_TOOL_NAME },
        checkTimeout: 10_000,
      },
    });
    const cases = report.reports.protocol!.groups.flatMap(
      (group) => group.cases
    );
    for (const id of LOGGING_CHECKS) {
      expect(cases.find((test) => test.id === id)?.status).toBe("passed");
    }
    expect(cases.find((test) => test.id === LOGGING_CHECKS[1])?.pending).toBe(
      true
    );
    expect(report.outcome).toBe("passed");
  });
  it("reports the supplied silent tool failure through runConformance", async () => {
    const serverUrl = await serve(
      createLoggingFixtureHandler({ mode: "silent" })
    );
    const report = await runConformance({
      server: { url: serverUrl },
      suites: ["protocol"],
      protocolVersion: MODERN,
      protocol: {
        checkIds: [LOGGING_CHECKS[0]],
        logProbe: { toolName: EMIT_LOG_TOOL_NAME },
        checkTimeout: 10_000,
      },
    });
    const cases = report.reports.protocol!.groups.flatMap(
      (group) => group.cases
    );
    expect(cases.find((test) => test.id === LOGGING_CHECKS[0])).toMatchObject({
      status: "failed",
      error: "the supplied tool produced no logs.",
    });
    expect(report.outcome).toBe("failed");
  });
});

describe("modern-cacheable-result-hints", () => {
  it("passes on a server whose cacheable results carry ttlMs and cacheScope", async () => {
    const serverUrl = await serve(createCacheFixtureHandler());
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-cacheable-result-hints", "modern-result-type-present"],
      checkTimeout: 10_000,
    }).run();

    expect(byId(result.checks, "modern-cacheable-result-hints").status).toBe(
      "passed"
    );
    expect(
      byId(result.checks, "modern-cacheable-result-hints").details
    ).toMatchObject({
      cacheHints: {
        "tools/list": { ttlMs: CACHE_FIXTURE_TTL_MS, cacheScope: "public" },
      },
    });
    expect(byId(result.checks, "modern-result-type-present").status).toBe(
      "passed"
    );
  });

  it("reports a useful-TTL readiness warning without failing conformance", async () => {
    const serverUrl = await serve(createCacheFixtureHandler());
    const withTtl = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-cacheable-result-hints"],
      checkTimeout: 10_000,
    }).run();

    // A real TTL earns no advice; the zero-TTL dual-era fixture does (see
    // `era.integration.test.ts`). Either way the verdict is untouched.
    expect(
      withTtl.readiness.some((item) => item.id === "readiness-cache-ttl-useful")
    ).toBe(false);
    expect(withTtl.passed).toBe(true);
  });
});
