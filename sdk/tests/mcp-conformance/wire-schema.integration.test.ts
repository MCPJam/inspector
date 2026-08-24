import { afterEach, describe, expect, it } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import {
  serveWireFixture,
  type WireFixtureOptions,
} from "../support/wire-schema-fixture.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * End-to-end replay of the sweep's findings: the check has to fire against a
 * real server over a real socket, not just against hand-built observations.
 * The `checkIds` selection keeps each run to `server/discover` + `tools/list`
 * traffic so the assertion is about the schema pass and nothing else.
 */
async function runAgainst(options: WireFixtureOptions) {
  const fixture = await serveWireFixture(options);
  closers.push(fixture.close);
  const result = await new MCPConformanceTest({
    serverUrl: fixture.url,
    protocolVersion: "2026-07-28",
    checkTimeout: 5_000,
    checkIds: ["modern-server-discover", "wire-schema-valid"],
  }).run();
  const check = result.checks.find((entry) => entry.id === "wire-schema-valid");
  if (!check) throw new Error("wire-schema-valid did not appear in the run");
  return { result, check };
}

// Each case stands up an HTTP fixture and drives a full conformance run
// through it. Vitest's 5s default is under the wire on a loaded CI box, and a
// timeout here reads as a product hang rather than an impatient runner.
describe("wire-schema-valid against production-shaped defects", { timeout: 20_000 }, () => {
  it("passes a conforming server (the linear/notion shape)", async () => {
    const { check } = await runAgainst({});
    expect([check.id, check.status, check.error?.message]).toEqual([
      "wire-schema-valid",
      "passed",
      undefined,
    ]);
    expect(check.details?.violationCount).toBe(0);
    // Non-vacuity: it graded real traffic, and graded some of it against a
    // METHOD-SPECIFIC definition rather than the near-empty envelope union.
    expect(Number(check.details?.messagesValidated)).toBeGreaterThan(0);
    expect(Number(check.details?.methodCorrelated)).toBeGreaterThan(0);
  });

  it("fails list results missing ttlMs and cacheScope (the hubspot shape)", async () => {
    const { check } = await runAgainst({ omitCacheHints: true });
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("ttlMs");
    expect(check.error?.message).toContain("cacheScope");
  });

  it("fails results missing resultType", async () => {
    const { check } = await runAgainst({ omitResultType: true });
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("resultType");
  });

  it('fails envelopes carrying "id": null (the canva shape)', async () => {
    const { check } = await runAgainst({ nullEnvelopeId: true });
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("/id");
  });

  it("keeps the failure OUT of the verdict while the check is pending", async () => {
    // The whole reason PR 1 landed first: a new MUST check finding a real
    // violation must not retroactively fail a server that was green.
    const { result } = await runAgainst({ omitCacheHints: true });
    expect(result.profile?.pendingCheckIds).toContain("wire-schema-valid");
    expect(result.outcome).not.toBe("failed");
  });

  it("stamps the schema digest onto the run's profile", async () => {
    const { result } = await runAgainst({});
    expect(result.profile?.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
