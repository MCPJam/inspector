import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";
import { createFixtureHandler } from "../support/dual-era-fixture.js";

/**
 * Exit gate for Phase 3 §11.5 (conformance era-awareness): pointing the
 * conformance suite at the modern (2026-07-28) dual-era fixture must produce
 * ZERO false failures and no crash, and a legacy run must behave exactly as
 * it did before era-awareness existed.
 *
 * The `serveFixtureOnPort` helper is vendored from
 * `mcp-client-manager-fixture.integration.test.ts` (not cross-imported): the
 * security host-header checks dial a real loopback socket, so the fixture
 * must be served over an actual port rather than driven in-process.
 */

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixtureOnPort(): Promise<ServedFixture> {
  const handler = createFixtureHandler();
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function byId(checks: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = checks.find((c) => c.id === id);
  if (!found) {
    throw new Error(`check ${id} not found in results`);
  }
  return found;
}

const ERA_SKIP = /Not applicable to the .* era/;

// Legacy-only checks — must be era-skipped on a modern run.
const LEGACY_ONLY: MCPCheckId[] = [
  "server-initialize",
  "ping",
  "server-sse-polling-session",
  "server-accepts-multiple-post-streams",
  "server-sse-streams-functional",
  "localhost-host-rebinding-rejected",
  "localhost-host-valid-accepted",
];

// Neutral checks that carry real surface on the modern fixture — must pass.
const MODERN_PASSING: MCPCheckId[] = [
  "capabilities-consistent",
  "tools-list",
  "tools-input-schemas-valid",
  "prompts-list",
  "resources-list",
  "protocol-invalid-method-error",
];

/**
 * Modern-only checks whose id is NOT `modern-`-prefixed. The SEP-2243
 * declaration check reads as one of the `tools-*` family in a report, but
 * `x-mcp-header` has no meaning before 2026-07-28, so it era-skips on legacy
 * exactly like the prefixed ones.
 */
const MODERN_ONLY_UNPREFIXED: MCPCheckId[] = [
  "tools-x-mcp-header-declarations-valid",
];

const isModernOnly = (id: MCPCheckId) =>
  id.startsWith("modern-") || MODERN_ONLY_UNPREFIXED.includes(id);

// Phase 7 §15.3 modern MUST checks the conforming beta.4 fixture satisfies.
const MODERN_MUST_PASSING: MCPCheckId[] = [
  "modern-client-handshake",
  "modern-server-discover",
  "modern-result-type-present",
  "modern-cacheable-result-hints",
  "modern-protocol-version-header-mismatch",
  "modern-method-header-mismatch",
  "modern-name-header-mismatch",
  "modern-unsupported-version-error",
  "modern-removed-methods-not-found",
  "modern-resource-not-found-invalid-params",
  "modern-logs-require-log-level",
  "modern-no-session-id",
];

// The two-fact rule: a raw rejection check must record the HTTP status AND the
// in-band JSON-RPC code separately, because the SDK delivers a 400 carrying a
// well-formed JSON-RPC error body IN-BAND — official-client evidence alone
// cannot tell those two facts apart.
const RAW_REJECTIONS: Array<{
  id: MCPCheckId;
  httpStatus: number;
  jsonRpcCode: number;
}> = [
  {
    id: "modern-protocol-version-header-mismatch",
    httpStatus: 400,
    jsonRpcCode: -32020,
  },
  { id: "modern-method-header-mismatch", httpStatus: 400, jsonRpcCode: -32020 },
  { id: "modern-name-header-mismatch", httpStatus: 400, jsonRpcCode: -32020 },
  {
    id: "modern-unsupported-version-error",
    httpStatus: 400,
    jsonRpcCode: -32022,
  },
  {
    // A missing resource is an ordinary in-band failure: HTTP 200 with -32602.
    // Asserting only "it errored" would hide a server that answered 400.
    id: "modern-resource-not-found-invalid-params",
    httpStatus: 200,
    jsonRpcCode: -32602,
  },
];

describe("MCP conformance × era-awareness against the dual-era fixture", () => {
  let served: ServedFixture;

  beforeEach(async () => {
    served = await serveFixtureOnPort();
  });

  afterEach(async () => {
    await served.close();
  });

  it("modern run: zero failures, legacy-only checks era-skipped, neutral checks pass", async () => {
    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2026-07-28",
      checkTimeout: 10_000,
    }).run();

    // Exit gate: no false failures, no crash.
    expect(result.checks.filter((c) => c.status === "failed")).toEqual([]);
    // NOT `passed`: three modern obligations cannot be exercised here — the
    // -32021 path needs an `inputRequiredProbe` this fixture does not
    // configure, a declared outputSchema can only be graded against a real
    // `tools/call` result and so needs a safe-to-execute fixture, and a
    // graceful subscription close is server-initiated and cannot be induced by
    // a client-side probe. All three report `could-not-run`, so the run is
    // honestly `incomplete` rather than green.
    expect(result.outcome).toBe("incomplete");
    expect(
      result.checks
        .filter((c) => c.skipReason === "could-not-run")
        .map((c) => c.id)
        .sort(),
    ).toEqual([
      "modern-subscription-graceful-close",
      "modern-tool-output-schema-conformant",
      "modern-undeclared-capability-error",
    ]);

    // Legacy-only checks appear (not filtered out) and are era-skipped.
    for (const id of LEGACY_ONLY) {
      const check = byId(result.checks, id);
      expect(check.status).toBe("skipped");
      expect(check.error?.message).toMatch(ERA_SKIP);
    }

    // Neutral checks with real surface pass on the modern era.
    for (const id of MODERN_PASSING) {
      expect(byId(result.checks, id).status).toBe("passed");
    }

    // The fixture's tools declare no `x-mcp-header` at all, so the SEP-2243
    // declaration check passes vacuously — which is the correct verdict.
    for (const id of MODERN_ONLY_UNPREFIXED) {
      expect([id, byId(result.checks, id).status]).toEqual([id, "passed"]);
    }

    // §15.3: the conforming modern fixture passes the modern MUST set.
    for (const id of MODERN_MUST_PASSING) {
      expect([id, byId(result.checks, id).status]).toEqual([id, "passed"]);
    }

    // Raw rejections record HTTP status and in-band JSON-RPC code separately.
    for (const { id, httpStatus, jsonRpcCode } of RAW_REJECTIONS) {
      expect(byId(result.checks, id).details).toMatchObject({
        httpStatus,
        jsonRpcCode,
      });
    }

    // The unsupported-version rejection must also advertise what IS supported.
    expect(
      byId(result.checks, "modern-unsupported-version-error").details
    ).toMatchObject({ supportedVersions: ["2026-07-28"] });

    // Every removed 2025 method answers -32601 with modern HTTP behavior.
    expect(
      byId(result.checks, "modern-removed-methods-not-found").details
    ).toMatchObject({
      removedMethods: {
        initialize: { httpStatus: 404, jsonRpcCode: -32601 },
        ping: { httpStatus: 404, jsonRpcCode: -32601 },
        "logging/setLevel": { httpStatus: 404, jsonRpcCode: -32601 },
      },
    });

    // The subscription checks run for real against this fixture: registering
    // tools/prompts/resources makes beta.4 advertise `listChanged`, so the
    // probe opens a live `subscriptions/listen` stream. Nothing publishes a
    // change event here, so the stream carries the acknowledgement alone —
    // enough to settle ordering and tagging, and not enough to settle a
    // graceful close, which is server-initiated and therefore an honest skip.
    // The failing paths are exercised in `subscription-checks.integration`.
    for (const id of [
      "modern-subscription-ack-precedes-notifications",
      "modern-subscription-filter-and-tagging",
    ] as const) {
      expect([id, byId(result.checks, id).status]).toEqual([id, "passed"]);
    }
    const gracefulClose = byId(
      result.checks,
      "modern-subscription-graceful-close"
    );
    expect(gracefulClose.status).toBe("skipped");
    expect(gracefulClose.error?.message).toMatch(/still open/);

    // §15.4: readiness advice is reported but never changes the verdict.
    expect(result.readiness.length).toBeGreaterThan(0);
    for (const item of result.readiness) {
      expect(item.severity).toBe("warning");
      expect(["SHOULD", "RECOMMENDED", "MAY"]).toContain(item.specStrength);
      expect(item.message.length).toBeGreaterThan(0);
    }
    // The point of §15.4 is that advice never becomes a violation. `passed` is
    // false here only because two obligations could not be run, so assert the
    // thing readiness could have broken: it never turns the verdict red.
    expect(result.outcome).not.toBe("failed");

    // The fixture advertises no logging/completions capability, so these
    // both-era checks self-skip on capability (NOT the era gate).
    for (const id of ["logging-set-level", "completion-complete"] as const) {
      const check = byId(result.checks, id);
      expect(check.status).toBe("skipped");
      expect(check.error?.message).not.toMatch(ERA_SKIP);
    }
  });

  it("auto run (no protocolVersion): detects the modern era", async () => {
    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      checkTimeout: 10_000,
    }).run();

    expect(result.checks.filter((c) => c.status === "failed")).toEqual([]);
    // NOT `passed`: three modern obligations cannot be exercised here — the
    // -32021 path needs an `inputRequiredProbe` this fixture does not
    // configure, a declared outputSchema can only be graded against a real
    // `tools/call` result and so needs a safe-to-execute fixture, and a
    // graceful subscription close is server-initiated and cannot be induced by
    // a client-side probe. All three report `could-not-run`, so the run is
    // honestly `incomplete` rather than green.
    expect(result.outcome).toBe("incomplete");
    expect(
      result.checks
        .filter((c) => c.skipReason === "could-not-run")
        .map((c) => c.id)
        .sort(),
    ).toEqual([
      "modern-subscription-graceful-close",
      "modern-tool-output-schema-conformant",
      "modern-undeclared-capability-error",
    ]);
    for (const id of LEGACY_ONLY) {
      const check = byId(result.checks, id);
      expect(check.status).toBe("skipped");
      expect(check.error?.message).toMatch(ERA_SKIP);
    }
    for (const id of MODERN_PASSING) {
      expect(byId(result.checks, id).status).toBe("passed");
    }
  });

  it("raw-only auto run still detects the modern era before raw checks", async () => {
    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      checkIds: ["server-sse-polling-session"],
      checkTimeout: 10_000,
    }).run();

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      id: "server-sse-polling-session",
      status: "skipped",
    });
    expect(result.checks[0]?.error?.message).toMatch(ERA_SKIP);
  });

  it("legacy pin (2025-11-25): keeps the legacy checks active", async () => {
    const pinned = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2025-11-25",
      checkTimeout: 10_000,
    }).run();

    // Only the modern-only checks may be era-skipped on a legacy pin; every
    // pre-Phase-7 check keeps its original status.
    for (const check of pinned.checks) {
      if (isModernOnly(check.id)) {
        expect(check.status).toBe("skipped");
        expect(check.error?.message).toMatch(
          /Not applicable to the legacy era/
        );
        continue;
      }
      expect(check.error?.message ?? "").not.toMatch(ERA_SKIP);
    }
    expect(byId(pinned.checks, "server-initialize").status).toBe("passed");
    expect(byId(pinned.checks, "ping").status).toBe("passed");
    expect(byId(pinned.checks, "capabilities-consistent").status).toBe(
      "passed"
    );
    for (const id of MODERN_PASSING) {
      expect(byId(pinned.checks, id).status).toBe("passed");
    }
  });
});
