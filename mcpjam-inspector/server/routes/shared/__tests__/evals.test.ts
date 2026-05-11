import { describe, expect, it } from "vitest";
import {
  MAX_TOTAL_LLM_CALLS,
  RunEvalsRequestSchema,
  RunTestCaseRequestSchema,
  assertSuiteRunWithinCap,
  assertTestCaseRunWithinCap,
  filterAndRemapReplayConfigs,
} from "../evals";
import { WebRouteError } from "../../web/errors";

function buildSuiteRequest(overrides?: {
  testCount?: number;
  runs?: number;
}): unknown {
  const testCount = overrides?.testCount ?? 1;
  const runs = overrides?.runs ?? 1;
  return {
    suiteName: "S",
    projectId: "p_1",
    serverIds: ["srv_1"],
    convexAuthToken: "tok",
    tests: Array.from({ length: testCount }, (_, i) => ({
      title: `t${i}`,
      query: "q",
      runs,
      model: "claude-3",
      provider: "anthropic",
      expectedToolCalls: [],
    })),
  };
}

function buildTestCaseRequest(runs?: number): unknown {
  return {
    testCaseId: "tc_1",
    model: "claude-3",
    provider: "anthropic",
    serverIds: ["srv_1"],
    convexAuthToken: "tok",
    ...(runs === undefined ? {} : { testCaseOverrides: { runs } }),
  };
}

describe("RunEvalsRequestSchema runs cap", () => {
  it("accepts runs up to 10", () => {
    const result = RunEvalsRequestSchema.safeParse(
      buildSuiteRequest({ runs: 10 }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects runs above 10 at the Zod layer", () => {
    const result = RunEvalsRequestSchema.safeParse(
      buildSuiteRequest({ runs: 11 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-positive runs", () => {
    const result = RunEvalsRequestSchema.safeParse(
      buildSuiteRequest({ runs: 0 }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts iterationOverride between 1 and 10", () => {
    const base = buildSuiteRequest() as Record<string, unknown>;
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 1 }).success,
    ).toBe(true);
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 10 }).success,
    ).toBe(true);
  });

  it("rejects iterationOverride outside [1, 10]", () => {
    const base = buildSuiteRequest() as Record<string, unknown>;
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 0 }).success,
    ).toBe(false);
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 11 }).success,
    ).toBe(false);
  });
});

describe("RunTestCaseRequestSchema runs cap", () => {
  it("accepts testCaseOverrides.runs up to 10", () => {
    const result = RunTestCaseRequestSchema.safeParse(buildTestCaseRequest(10));
    expect(result.success).toBe(true);
  });

  it("rejects testCaseOverrides.runs above 10", () => {
    const result = RunTestCaseRequestSchema.safeParse(buildTestCaseRequest(11));
    expect(result.success).toBe(false);
  });

  it("allows omitted testCaseOverrides (single-run default)", () => {
    const result = RunTestCaseRequestSchema.safeParse(buildTestCaseRequest());
    expect(result.success).toBe(true);
  });
});

describe("assertSuiteRunWithinCap", () => {
  it("passes when total LLM calls is within the cap", () => {
    const req = RunEvalsRequestSchema.parse(
      buildSuiteRequest({ testCount: 10, runs: 10 }),
    );
    expect(() => assertSuiteRunWithinCap(req)).not.toThrow();
  });

  it(`rejects when total exceeds ${MAX_TOTAL_LLM_CALLS}`, () => {
    const req = RunEvalsRequestSchema.parse(
      buildSuiteRequest({ testCount: 10, runs: 10 }),
    );
    try {
      assertSuiteRunWithinCap(req, 4); // 10 × 10 × 4 = 400 > 300
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRouteError);
      expect((err as WebRouteError).status).toBe(400);
      expect((err as WebRouteError).details?.cap).toBe(MAX_TOTAL_LLM_CALLS);
      expect((err as WebRouteError).details?.totalCalls).toBe(400);
    }
  });

  it(`accepts exactly ${MAX_TOTAL_LLM_CALLS}`, () => {
    const req = RunEvalsRequestSchema.parse(
      buildSuiteRequest({ testCount: 10, runs: 10 }),
    );
    expect(() => assertSuiteRunWithinCap(req, 3)).not.toThrow();
  });

  it("uses iterationOverride for cap math instead of per-test runs", () => {
    // 31 cases × runs=1 each is well under the cap, but with
    // iterationOverride=10 the actual call count is 310 — must trip the cap.
    const base = buildSuiteRequest({ testCount: 31, runs: 1 }) as Record<
      string,
      unknown
    >;
    const req = RunEvalsRequestSchema.parse({
      ...base,
      iterationOverride: 10,
    });
    try {
      assertSuiteRunWithinCap(req);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRouteError);
      expect((err as WebRouteError).details?.totalCalls).toBe(310);
    }
  });
});

describe("assertTestCaseRunWithinCap", () => {
  it("passes for default (1 call)", () => {
    const req = RunTestCaseRequestSchema.parse(buildTestCaseRequest());
    expect(() => assertTestCaseRunWithinCap(req)).not.toThrow();
  });

  it("rejects beyond cap when a config count multiplier pushes it over", () => {
    const req = RunTestCaseRequestSchema.parse(buildTestCaseRequest(10));
    // 10 iterations × 31 configs > 300
    expect(() => assertTestCaseRunWithinCap(req, 31)).toThrowError(
      WebRouteError,
    );
  });
});

describe("filterAndRemapReplayConfigs", () => {
  it("filters unrelated servers and remaps stored server ids", () => {
    expect(
      filterAndRemapReplayConfigs(
        [
          {
            serverId: "srv_asana",
            url: "https://asana.example/mcp",
            accessToken: "at_123",
          },
          {
            serverId: "srv_github",
            url: "https://github.example/mcp",
            accessToken: "at_456",
          },
        ],
        ["srv_asana"],
        ["asana"],
      ),
    ).toEqual([
      {
        serverId: "asana",
        url: "https://asana.example/mcp",
        accessToken: "at_123",
      },
    ]);
  });
});
