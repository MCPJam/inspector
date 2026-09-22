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
      Number((check.details as { succeededResponses?: number })
        ?.succeededResponses)
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

describe("modern-logs-require-log-level", () => {
  it("fails a server that logs on a request carrying no log level", async () => {
    const serverUrl = await serve(createLoggingFixtureHandler());
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-logs-require-log-level"],
      // The fixture emits every severity when the request carries no level —
      // exactly the behavior the modern revision forbids.
      logProbe: { toolName: EMIT_LOG_TOOL_NAME },
      checkTimeout: 10_000,
    }).run();

    const check = byId(result.checks, "modern-logs-require-log-level");
    expect(check.status).toBe("failed");
    expect(check.details).toMatchObject({ probedTool: EMIT_LOG_TOOL_NAME });
    expect(check.error?.message).toMatch(/no modern log level/);
    expect(result.passed).toBe(false);
  });

  // Note this fixture EMITS logs unprompted — `logProbe` is the only thing
  // that would have caught it. The unprobed run must therefore not report a
  // pass: the same silence it would read as conformance is produced here by a
  // server that violates the MUST, and only the probe tells them apart.
  it("cannot run without a logProbe: silence proves nothing", async () => {
    const serverUrl = await serve(createLoggingFixtureHandler());
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: ["modern-logs-require-log-level"],
      checkTimeout: 10_000,
    }).run();

    const check = byId(result.checks, "modern-logs-require-log-level");
    expect(check.status).toBe("skipped");
    // `could-not-run`, never `not-applicable`: the requirement applies to every
    // modern server, so the check must stay in the denominator and drag the
    // run to `incomplete` rather than quietly leaving the sample.
    expect(check.skipReason).toBe("could-not-run");
    expect(check.details).toMatchObject({ logNotificationCount: 0 });
    expect(String(check.error?.message)).toMatch(/No logProbe configured/);
    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
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
