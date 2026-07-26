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

function statusById(checks: MCPCheckResult[]): Record<string, string> {
  return Object.fromEntries(checks.map((c) => [c.id, c.status]));
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
  "capabilities-consistent",
  "server-sse-polling-session",
  "server-accepts-multiple-post-streams",
  "server-sse-streams-functional",
  "localhost-host-rebinding-rejected",
  "localhost-host-valid-accepted",
];

// Neutral checks that carry real surface on the modern fixture — must pass.
const MODERN_PASSING: MCPCheckId[] = [
  "tools-list",
  "tools-input-schemas-valid",
  "prompts-list",
  "resources-list",
  "protocol-invalid-method-error",
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
    expect(result.passed).toBe(true);

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

    // The fixture advertises no logging/completions capability, so these
    // both-era checks self-skip on capability (NOT the era gate).
    for (const id of ["logging-set-level", "completion-complete"] as const) {
      const check = byId(result.checks, id);
      expect(check.status).toBe("skipped");
      expect(check.error?.message).not.toMatch(ERA_SKIP);
    }
  });

  it("legacy run (no protocolVersion): era gate is inert — every check runs", async () => {
    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      checkTimeout: 10_000,
    }).run();

    // No check is skipped for era reasons on a legacy run — this is the
    // "byte-identical to today" guarantee. (We do not assert `passed`: the
    // dual-era fixture leaves DNS-rebinding protection disabled, so
    // `localhost-host-rebinding-rejected` fails here exactly as it did
    // before this PR — a fixture property, not an era regression.)
    for (const check of result.checks) {
      expect(check.error?.message ?? "").not.toMatch(ERA_SKIP);
    }

    // The legacy-only checks actually execute rather than being skipped away.
    expect(byId(result.checks, "server-initialize").status).toBe("passed");
    expect(byId(result.checks, "ping").status).toBe("passed");
    expect(byId(result.checks, "capabilities-consistent").status).toBe(
      "passed"
    );
    for (const id of MODERN_PASSING) {
      expect(byId(result.checks, id).status).toBe("passed");
    }
  });

  it("legacy pin (2025-11-25): identical to the default legacy run", async () => {
    const unpinned = await new MCPConformanceTest({
      serverUrl: served.url,
      checkTimeout: 10_000,
    }).run();
    const pinned = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2025-11-25",
      checkTimeout: 10_000,
    }).run();

    // Same set of checks, same statuses — the stateful pin routes through the
    // identical legacy path.
    expect(statusById(pinned.checks)).toEqual(statusById(unpinned.checks));
    for (const check of pinned.checks) {
      expect(check.error?.message ?? "").not.toMatch(ERA_SKIP);
    }
  });
});
