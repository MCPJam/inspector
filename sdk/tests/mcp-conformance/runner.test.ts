import {
  CHECK_ERAS,
  MCP_CHECK_IDS,
  MCPConformanceTest,
} from "../../src/mcp-conformance/index.js";
import {
  conformanceProfile,
  CONFORMANCE_CHECKER_VERSION,
} from "../../src/conformance-profile.js";
import { scoreFromProtocolResult } from "../../src/conformance-score.js";
import { startConformanceMockServer } from "../mock-servers/conformance-mcp-server.js";

describe("MCPConformanceTest", () => {
  it("passes the full conformance suite against the dedicated mock server", async () => {
    const mockServer = await startConformanceMockServer();

    try {
      const test = new MCPConformanceTest({
        serverUrl: mockServer.url,
        checkTimeout: 10_000,
      });

      const result = await test.run();

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(MCP_CHECK_IDS.length);
      // Byte-identity guard: on a legacy server every check that applies to
      // the legacy era still passes exactly as it did before Phase 7, and the
      // modern-only checks are era-SKIPPED (never passed, never failed).
      for (const check of result.checks) {
        const applies = CHECK_ERAS[check.id].includes("legacy");
        expect([check.id, check.status]).toEqual([
          check.id,
          applies ? "passed" : "skipped",
        ]);
      }
      // Readiness is advisory only: it never contributes to the verdict.
      expect(
        result.readiness.every((item) => item.severity === "warning"),
      ).toBe(true);
      expect(result.categorySummary.core.passed).toBe(5);
      // `protocol-invalid-method-error` plus `wire-schema-valid`: the schema
      // check is era-neutral, so it runs and passes on this legacy fixture too.
      expect(result.categorySummary.protocol.passed).toBe(2);
      expect(result.categorySummary.tools.passed).toBe(2);
      expect(result.categorySummary.prompts.passed).toBe(1);
      expect(result.categorySummary.resources.passed).toBe(1);
      expect(result.categorySummary.security.passed).toBe(2);
      expect(result.categorySummary.transport.passed).toBe(7);

      // The run stamps WHICH questions it asked. Every check in today's pool is
      // scored by the frozen profile, so nothing is pending and the score is
      // computed over the full applicable set — the state PR 1 must preserve.
      const profile = conformanceProfile("mcp-protocol");
      expect(result.profile).toMatchObject({
        profileId: "mcp-protocol",
        profileVersion: profile.version,
        checkerVersion: CONFORMANCE_CHECKER_VERSION,
        // Every gap-program check ran (or era-skipped) and reported a real
        // verdict, but this profile version scores none of them yet — so they
        // are reported and excluded from the number.
        pendingCheckIds: [
          "modern-cache-hint-coverage",
          "modern-cache-hint-values-valid",
          "modern-cache-scope-stable-across-pages",
          "modern-header-names-case-insensitive",
          "modern-missing-method-header-rejected",
          "modern-resource-read-no-empty-contents",
          "modern-tool-output-schema-conformant",
          "wire-schema-valid",
        ],
      });
      // The digest is stamped only because the schema pass actually ran.
      expect(result.profile?.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
      const score = scoreFromProtocolResult(result);
      expect(score.pending).toBe(8);
      // Every legacy-applicable check EXCEPT the pending one is in the
      // denominator; the modern-only checks era-skipped out of it, which is the
      // pre-existing behavior this must not disturb.
      const legacyApplicable = result.checks.filter(
        (check) => CHECK_ERAS[check.id].includes("legacy"),
      ).length;
      // The modern-only pending checks era-skipped out of the legacy
      // denominator already; only `wire-schema-valid` is both legacy-applicable
      // and unscored, so exactly one comes off.
      expect(score.applicable).toBe(legacyApplicable - 1);
    } finally {
      await mockServer.stop();
    }
  });

  it("skips optional capabilities and accepts tools/prompts without descriptions", async () => {
    const mockServer = await startConformanceMockServer({
      omitLogging: true,
      omitCompletion: true,
      omitToolDescriptions: ["test_simple_text"],
      omitPromptDescriptions: ["test_simple_prompt"],
    });

    try {
      const test = new MCPConformanceTest({
        serverUrl: mockServer.url,
        checkTimeout: 10_000,
        checkIds: [
          "logging-set-level",
          "completion-complete",
          "tools-list",
          "prompts-list",
        ],
      });

      const result = await test.run();
      const statuses = Object.fromEntries(
        result.checks.map((check) => [check.id, check.status]),
      );

      expect(result.passed).toBe(true);
      expect(statuses).toEqual({
        "logging-set-level": "skipped",
        "completion-complete": "skipped",
        "tools-list": "passed",
        "prompts-list": "passed",
      });
    } finally {
      await mockServer.stop();
    }
  });

  it("modern run + connect failure + all-legacy-only selection surfaces a failure, not a pass", async () => {
    // Modern era, but the only selected client check (`ping`) is legacy-only,
    // so it is era-skipped for this run. The server is unreachable, so
    // `withEphemeralClient` throws. Without the connect-failure anchor, every
    // check would be era-skipped and the run would silently report `passed`.
    const test = new MCPConformanceTest({
      serverUrl: "http://127.0.0.1:1/mcp",
      protocolVersion: "2026-07-28",
      checkTimeout: 3_000,
      checkIds: ["ping"],
    });

    const result = await test.run();

    expect(result.passed).toBe(false);

    // Assert the anchor itself, not just "something failed": the connect
    // failure is pinned to the first selected check (`ping`). A bare
    // `failed.length >= 1` would also pass if `ping` had failed for an
    // unrelated reason or a different check failed, masking a missing anchor.
    const ping = result.checks.find((check) => check.id === "ping");
    expect(ping?.status).toBe("failed");
    // And exactly the anchored check failed — no other check masks a missing
    // anchor, and none is left era-skipped-into-a-silent-pass.
    const failed = result.checks.filter((check) => check.status === "failed");
    expect(failed.map((check) => check.id)).toEqual(["ping"]);
  });

  it("treats stateless Streamable HTTP servers as supported transport variants", async () => {
    const mockServer = await startConformanceMockServer({
      statelessTransport: true,
    });

    try {
      const test = new MCPConformanceTest({
        serverUrl: mockServer.url,
        checkTimeout: 10_000,
        checkIds: [
          "server-sse-polling-session",
          "server-accepts-multiple-post-streams",
          "server-sse-streams-functional",
        ],
      });

      const result = await test.run();
      const statuses = Object.fromEntries(
        result.checks.map((check) => [check.id, check.status]),
      );

      expect(result.passed).toBe(true);
      expect(statuses).toEqual({
        "server-sse-polling-session": "skipped",
        "server-accepts-multiple-post-streams": "passed",
        "server-sse-streams-functional": "passed",
      });
    } finally {
      await mockServer.stop();
    }
  });
});
