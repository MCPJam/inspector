/**
 * What each mode is allowed to change about a finalized iteration, and the
 * parity assertion that makes "ships at off" checkable.
 *
 * THE TELEMETRY ASSERTION IS THE PARITY ASSERTION. The shadow emitter is
 * silent on agreement by construction, so `toHaveBeenCalledTimes(0)` over the
 * whole fixture set says "the score engine reached the same verdict as the
 * legacy one, everywhere" more strongly than comparing two booleans would: it
 * also covers the userValue row and the scorer set.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StageAuthoredCase } from "@mcpjam/sdk/contract";

const telemetry = vi.hoisted(() => ({ emitShadowMismatch: vi.fn() }));

vi.mock("../shadow-mismatch.js", async () => {
  const actual =
    await vi.importActual<typeof import("../shadow-mismatch.js")>(
      "../shadow-mismatch.js"
    );
  return { ...actual, ...telemetry };
});

const { buildIterationFinishParams } = await import("../finalize-iteration.js");

const ENV_KEY = "MCPJAM_GRADING_ENGINE_MODE";

const stageCase: StageAuthoredCase = {
  mode: "model_driven",
  expectsToolCall: true,
  assertionCount: 1,
};

type Fixture = {
  name: string;
  passed: boolean;
  predicateResults: Array<Record<string, unknown>>;
  evaluation: Record<string, unknown>;
  isNegativeTest?: boolean;
};

/** A `PredicateResult`-shaped row: the projection needs the predicate itself. */
function predicate(passed: boolean, reason: string) {
  return {
    predicate: { type: "contains", value: reason },
    passed,
    reason,
  };
}

/** A `MultiTurnEvaluationResult`-shaped object with the counted fields filled. */
function evaluation(over: Record<string, unknown>): Record<string, unknown> {
  const missing = (over.missing as unknown[]) ?? [];
  const unexpected = (over.unexpected as unknown[]) ?? [];
  const argumentMismatches = (over.argumentMismatches as unknown[]) ?? [];
  return {
    expectedToolCalls: [],
    toolsCalled: [],
    promptSummaries: [],
    turnCount: 1,
    failedTurnCount: 0,
    passed: true,
    ...over,
    missing,
    unexpected,
    argumentMismatches,
  };
}

/**
 * One fixture per shape the runner actually produces. Every one goes through
 * both engines below.
 */
const fixtures: Fixture[] = [
  {
    name: "tool match passes, predicates pass",
    passed: true,
    predicateResults: [predicate(true, "ok")],
    evaluation: evaluation({
      expectedToolCalls: [{ toolName: "list_files" }],
      toolsCalled: [{ toolName: "list_files", arguments: {} }],
    }),
  },
  {
    name: "a predicate failed",
    passed: false,
    predicateResults: [predicate(true, "ok"), predicate(false, "wrong city")],
    evaluation: evaluation({
      expectedToolCalls: [{ toolName: "list_files" }],
      toolsCalled: [{ toolName: "list_files", arguments: {} }],
    }),
  },
  {
    name: "a tool call was missing",
    passed: false,
    predicateResults: [],
    evaluation: evaluation({
      expectedToolCalls: [{ toolName: "list_files" }],
      passed: false,
      failedTurnCount: 1,
      missing: [{ toolName: "list_files" }],
    }),
  },
  {
    name: "an unexpected tool was called",
    passed: false,
    predicateResults: [],
    evaluation: evaluation({
      toolsCalled: [{ toolName: "delete_all", arguments: {} }],
      passed: false,
      failedTurnCount: 1,
      unexpected: [{ toolName: "delete_all" }],
    }),
  },
  {
    name: "arguments mismatched",
    passed: false,
    predicateResults: [],
    evaluation: evaluation({
      expectedToolCalls: [{ toolName: "list_files" }],
      toolsCalled: [{ toolName: "list_files", arguments: { path: "/tmp" } }],
      passed: false,
      failedTurnCount: 1,
      argumentMismatches: [{ toolName: "list_files", field: "path" }],
    }),
  },
  {
    name: "a negative case whose forbidden call did not happen",
    passed: true,
    isNegativeTest: true,
    predicateResults: [],
    evaluation: evaluation({
      expectedToolCalls: [{ toolName: "delete_all" }],
    }),
  },
  {
    name: "no predicates and no expectations at all",
    passed: true,
    predicateResults: [],
    evaluation: evaluation({}),
  },
];

function build(fixture: Fixture, over: Record<string, unknown> = {}) {
  return buildIterationFinishParams({
    iterationId: "iter1",
    runId: "run1",
    passed: fixture.passed,
    evaluation: fixture.evaluation as never,
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    messages: [{ role: "user", content: "hi" }],
    status: "completed",
    startedAt: 1_700_000_000_000,
    predicateResults: fixture.predicateResults,
    stageCase,
    iterationMetadataBase: { caseTitle: "case" },
    ...(fixture.isNegativeTest ? { isNegativeTest: true } : {}),
    scoreMatchOptions: { exactArguments: false },
    ...over,
  });
}

const SCORE_KEYS = [
  "scores",
  "evaluationConfig",
  "scoresShadow",
  "evaluationConfigShadow",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(ENV_KEY, "off");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("off is byte-identical to before this wave", () => {
  test.each(fixtures.map((f) => [f.name, f] as const))(
    "%s: no score key, no telemetry",
    (_name, fixture) => {
      const params = build(fixture);
      const metadata = params.metadata as Record<string, unknown>;
      for (const key of SCORE_KEYS) expect(metadata).not.toHaveProperty(key);
      expect(telemetry.emitShadowMismatch).not.toHaveBeenCalled();
    }
  );

  test("an unrecognized env value is off, not a mode", () => {
    vi.stubEnv(ENV_KEY, "DUAL-WRITE-PLEASE");
    const metadata = build(fixtures[0]!).metadata as Record<string, unknown>;
    for (const key of SCORE_KEYS) expect(metadata).not.toHaveProperty(key);
  });

  test("off differs from dual_write in exactly the score keys and nothing else", () => {
    const off = build(fixtures[1]!, { gradingMode: "off" });
    const dual = build(fixtures[1]!, { gradingMode: "dual_write" });
    const strip = (params: typeof off) => {
      const { scores, evaluationConfig, ...rest } = params.metadata as Record<
        string,
        unknown
      >;
      return { ...params, metadata: rest };
    };
    expect(strip(dual)).toEqual(strip(off));
  });
});

describe("shadow writes shadow keys only", () => {
  test.each(fixtures.map((f) => [f.name, f] as const))(
    "%s",
    (_name, fixture) => {
      const metadata = build(fixture, { gradingMode: "shadow" })
        .metadata as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("scores");
      expect(metadata).not.toHaveProperty("evaluationConfig");
      // A case with nothing to score writes nothing at all, which is correct:
      // an empty row set is not a shadow of anything.
      if (metadata.scoresShadow !== undefined) {
        expect(Array.isArray(metadata.scoresShadow)).toBe(true);
        expect(metadata).toHaveProperty("evaluationConfigShadow");
      }
    }
  );
});

describe("dual_write writes real keys only", () => {
  test.each(fixtures.map((f) => [f.name, f] as const))(
    "%s",
    (_name, fixture) => {
      const metadata = build(fixture, { gradingMode: "dual_write" })
        .metadata as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("scoresShadow");
      expect(metadata).not.toHaveProperty("evaluationConfigShadow");
      if (metadata.scores !== undefined) {
        expect(Array.isArray(metadata.scores)).toBe(true);
        expect(metadata).toHaveProperty("evaluationConfig");
      }
    }
  );

  test("the authoritative verdict is untouched in every mode", () => {
    for (const fixture of fixtures) {
      for (const mode of ["off", "shadow", "dual_write"] as const) {
        expect(build(fixture, { gradingMode: mode }).passed).toBe(
          fixture.passed
        );
      }
    }
  });
});

describe("fixture parity: the score engine agrees with the legacy verdict", () => {
  test("every fixture, every non-off mode, zero mismatch emissions", () => {
    for (const mode of ["shadow", "dual_write"] as const) {
      for (const fixture of fixtures) {
        build(fixture, { gradingMode: mode });
      }
    }
    // Silence IS the parity result. A single call here would name the fixture,
    // the scorer, and the direction of the disagreement.
    expect(telemetry.emitShadowMismatch).toHaveBeenCalledTimes(0);
  });

  test("the harness can actually fail: an inverted verdict is reported", () => {
    // Guards against a green parity run that is really a silent no-op.
    build(
      { ...fixtures[1]!, passed: true },
      { gradingMode: "shadow" }
    );
    expect(telemetry.emitShadowMismatch).toHaveBeenCalledTimes(1);
  });

  test("stage rows are identical across modes — scoring never re-derives them", () => {
    for (const fixture of fixtures) {
      const off = (build(fixture, { gradingMode: "off" }).metadata as Record<
        string,
        unknown
      >).stageResults;
      const dual = (
        build(fixture, { gradingMode: "dual_write" }).metadata as Record<
          string,
          unknown
        >
      ).stageResults;
      expect(dual).toEqual(off);
    }
  });
});
