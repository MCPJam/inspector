/**
 * The SDK's run verdict aggregator agrees with the backend's, row for row.
 *
 * Two byte-for-byte fixture copies hold the two implementations of one policy
 * together:
 *
 *   - `eval-verdict-policy-parity-fixtures.json` (owned here) pins the
 *     per-case roll-up in its `aggregation` cohort;
 *   - `eval-verdict-run-aggregation-parity-fixtures.json` (OWNED by
 *     mcpjam-backend, generated there from `aggregateEvalRunVerdict`) pins full
 *     run decisions, refusals, and the finalization adapter's reading of
 *     iteration evidence.
 *
 * Then the part no fixture can carry: REAL SDK results — `EvalTest` runs
 * mapped through the SDK's own upload mapper, which is exactly the evidence the
 * backend adapter reads for an SDK run — go through the ported adapter and
 * aggregator, so a local decision and a hosted one are shown to read the same
 * iterations the same way.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import runFixtures from "./fixtures/eval-verdict-run-aggregation-parity-fixtures.json" with { type: "json" };
import {
  EvalVerdictAggregationError,
  aggregateEvalCaseVerdict,
  aggregateEvalRunVerdict,
  evalV2IterationHasEvaluatorError,
  evalV2TrialObservation,
  type EvalCaseVerdictInput,
  type EvalV2IterationEvidence,
} from "../src/contract/verdict-aggregate.js";
import * as contract from "../src/contract/index.js";
import {
  EVAL_VERDICT_DECISION_REASONS,
  evalCaseVerdictAggregationSchema,
  evalVerdictDecisionSchema,
  type ResolvedEvalValidityPolicy,
} from "../src/contract/verdict-policy.js";
import { resolveEvalGradingValidityPolicy } from "../src/contract/grading-policy.js";
import { EvalTest } from "../src/EvalTest.js";
import { HostRunner } from "../src/HostRunner.js";
import { PromptResult } from "../src/PromptResult.js";
import { iterationsToEvalResultInputs } from "../src/eval-result-mapping.js";
import type { Scorer } from "../src/scorers/types.js";
import {
  stripAnnotations,
  verdictPolicyFixtures,
} from "./support/eval-verdict-policy-fixtures.js";

/** Pinned bytes of the backend-owned copy. Re-pin only on a deliberate re-sync. */
const RUN_FIXTURE_SHA256 =
  "c8fb45bf8a9fddf847f4fc3c5d1f8c574b8c09dbafb199f7542621182175d70f";

type RunCorpus = {
  __generator: {
    owner: string;
    command: string;
    sourceCommit: string;
    caseCorpusBaselineSha256: string;
  };
  runs: Array<{
    __label: string;
    input: {
      policy: ResolvedEvalValidityPolicy;
      cases: EvalCaseVerdictInput[];
    };
    expected: Record<string, unknown>;
  }>;
  refusals: Array<{
    __label: string;
    input: unknown;
    expectedErrorIncludes: string;
  }>;
  evaluatorErrorSignals: Array<{
    __label: string;
    metadata?: Record<string, unknown>;
    expected: boolean;
  }>;
  trialObservations: Array<{
    __label: string;
    row: EvalV2IterationEvidence;
    expected?: Record<string, unknown>;
    expectedErrorIncludes?: string;
  }>;
};

const corpus = runFixtures as unknown as RunCorpus;

function fixtureBytes(name: string): Buffer {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("run aggregation corpus — provenance of the copy", () => {
  it("is the backend's bytes, unedited", () => {
    // A copy: an edit made here instead of regenerating upstream would leave
    // both repos green while they implemented different policies.
    expect(
      sha256(fixtureBytes("eval-verdict-run-aggregation-parity-fixtures.json"))
    ).toBe(RUN_FIXTURE_SHA256);
    expect(corpus.__generator.owner).toBe("mcpjam-backend");
    expect(corpus.__generator.command).toBe(
      "npm run generate:eval-verdict-run-fixtures"
    );
    expect(corpus.__generator.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("was cut against the per-case corpus this repo holds", () => {
    // Both repos consume the same per-case bytes: the backend recorded their
    // hash when it generated the run corpus, and this repo's copy matches.
    expect(
      sha256(fixtureBytes("eval-verdict-policy-parity-fixtures.json"))
    ).toBe(corpus.__generator.caseCorpusBaselineSha256);
  });

  it("covers every verdict and every run-level reason", () => {
    const verdicts = new Set(corpus.runs.map((row) => row.expected.verdict));
    expect([...verdicts].sort()).toEqual(["failed", "inconclusive", "passed"]);
    const reasons = new Set(
      corpus.runs.flatMap((row) => row.expected.reasons as string[])
    );
    for (const reason of EVAL_VERDICT_DECISION_REASONS) {
      // A per-case reason; it never appears at run level.
      if (reason === "casePassRateMetThreshold") continue;
      expect(reasons, reason).toContain(reason);
    }
  });
});

describe("aggregateEvalCaseVerdict — the per-case corpus", () => {
  for (const row of verdictPolicyFixtures.aggregation) {
    it(`aggregates: ${row.__label}`, () => {
      const actual = aggregateEvalCaseVerdict(stripAnnotations(row.input));
      expect(actual).toEqual(row.expected);
      expect(evalCaseVerdictAggregationSchema.safeParse(actual).success).toBe(
        true
      );
    });
  }
});

describe("aggregateEvalRunVerdict — the backend-generated run corpus", () => {
  for (const row of corpus.runs) {
    it(`decides: ${row.__label}`, () => {
      const decision = aggregateEvalRunVerdict(stripAnnotations(row.input));
      // The WHOLE decision: reason order, per-rate exclusion tallies and the
      // case rows are exactly where a mirror drifts.
      expect(decision).toEqual(row.expected);
      expect(evalVerdictDecisionSchema.safeParse(row.expected).success).toBe(
        true
      );
    });
  }

  for (const row of corpus.refusals) {
    it(`refuses: ${row.__label}`, () => {
      let thrown: unknown;
      try {
        aggregateEvalRunVerdict(
          stripAnnotations(row.input) as Parameters<
            typeof aggregateEvalRunVerdict
          >[0]
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(EvalVerdictAggregationError);
      expect((thrown as Error).message).toContain(row.expectedErrorIncludes);
    });
  }
});

describe("the finalization adapter — the backend-generated rows", () => {
  for (const row of corpus.evaluatorErrorSignals) {
    it(`reads evaluator error = ${row.expected}: ${row.__label}`, () => {
      expect(evalV2IterationHasEvaluatorError(row.metadata)).toBe(row.expected);
    });
  }

  for (const row of corpus.trialObservations) {
    it(`observes: ${row.__label}`, () => {
      if (row.expectedErrorIncludes !== undefined) {
        expect(() => evalV2TrialObservation(row.row)).toThrow(
          row.expectedErrorIncludes
        );
        return;
      }
      expect(evalV2TrialObservation(row.row)).toEqual(row.expected);
    });
  }
});

describe("the contract entry exports the producer", () => {
  it("re-exports the aggregator and the adapter", () => {
    expect(contract.aggregateEvalRunVerdict).toBe(aggregateEvalRunVerdict);
    expect(contract.aggregateEvalCaseVerdict).toBe(aggregateEvalCaseVerdict);
    expect(contract.evalV2TrialObservation).toBe(evalV2TrialObservation);
    expect(contract.evalV2IterationHasEvaluatorError).toBe(
      evalV2IterationHasEvaluatorError
    );
    expect(contract.EvalVerdictAggregationError).toBe(
      EvalVerdictAggregationError
    );
  });
});

// ── representative SDK results ──────────────────────────────────────────────

function reply(prompt: string): PromptResult {
  return PromptResult.from({
    prompt,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: "done" },
    ],
    text: "done",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
  });
}

const agent = () => HostRunner.mock(async (prompt) => reply(prompt));

function crashingScorer(role: "gating" | "advisory"): Scorer {
  return {
    definition: {
      scorerId: `crash-${role}`,
      idSource: "explicit",
      scorerVersion: "1",
      implementationHash: "crash",
      deterministic: true,
      passThreshold: 1,
      role,
    },
    score: () => {
      throw new Error("grader crashed");
    },
  };
}

/**
 * One EvalTest run → the evidence rows the backend would store for it: the
 * SDK's own upload mapper supplies `status`, `passed` and the
 * `metadata.scores` / `metadata.evaluationConfig` pair the adapter reads.
 */
async function evidenceOf(
  test: EvalTest,
  options: { iterations: number; timeoutMs?: number } = { iterations: 1 }
): Promise<EvalV2IterationEvidence[]> {
  const run = await test.run(agent(), {
    iterations: options.iterations,
    concurrency: 1,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    mcpjam: { enabled: false },
  });
  const inputs = iterationsToEvalResultInputs(
    test.getName(),
    run.iterationDetails,
    test.getConfig().expectedToolCalls,
    undefined,
    undefined,
    test.getConfig().predicates,
    test.getConfig().matchOptions,
    run.evaluationConfig
  );
  return inputs.map((input) => ({
    status: input.status!,
    result: input.passed ? "passed" : "failed",
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }));
}

describe("the adapter reads real SDK results the way the backend does", () => {
  it("a graded pass and a graded failure are task verdicts", async () => {
    const [passing] = await evidenceOf(
      new EvalTest({
        id: "c_pass",
        name: "pass",
        test: async (executor) => {
          await executor.run("go");
          return true;
        },
      })
    );
    const [failing] = await evidenceOf(
      new EvalTest({
        id: "c_fail",
        name: "fail",
        expectedToolCalls: [{ toolName: "never_called", arguments: {} }],
        test: async (executor) => {
          await executor.run("go");
          return true;
        },
      })
    );
    expect(evalV2TrialObservation(passing!)).toEqual({
      status: "completed",
      taskVerdict: "passed",
    });
    // The server under test did not call the tool: a MEASURED failure.
    expect(evalV2TrialObservation(failing!)).toEqual({
      status: "completed",
      taskVerdict: "failed",
    });
  });

  it("a crashed GATING grader is an evaluator error, not a task failure", async () => {
    const [row] = await evidenceOf(
      new EvalTest({
        id: "c_gating_crash",
        name: "gating crash",
        scorers: [crashingScorer("gating")],
        test: async (executor) => {
          await executor.run("go");
          return true;
        },
      })
    );
    // The iteration FAILED under legacy `passed` — the adapter must not read
    // that as the server failing its task.
    expect(row!.result).toBe("failed");
    expect(evalV2TrialObservation(row!)).toEqual({
      status: "completed",
      evaluatorError: true,
    });
  });

  it("a crashed ADVISORY grader leaves the task verdict standing", async () => {
    const [row] = await evidenceOf(
      new EvalTest({
        id: "c_advisory_crash",
        name: "advisory crash",
        scorers: [crashingScorer("advisory")],
        test: async (executor) => {
          await executor.run("go");
          return true;
        },
      })
    );
    expect(evalV2TrialObservation(row!)).toEqual({
      status: "completed",
      taskVerdict: "passed",
    });
  });

  it("execution failures and timeouts are lifecycle, never verdicts", async () => {
    const [threw] = await evidenceOf(
      new EvalTest({
        id: "c_threw",
        name: "threw",
        test: async () => {
          throw new Error("harness broke");
        },
      })
    );
    const [slow] = await evidenceOf(
      new EvalTest({
        id: "c_slow",
        name: "slow",
        test: async () => {
          await new Promise(() => {});
          return true;
        },
      }),
      { iterations: 1, timeoutMs: 20 }
    );
    expect(evalV2TrialObservation(threw!)).toEqual({ status: "failed" });
    expect(evalV2TrialObservation(slow!)).toEqual({ status: "timed_out" });
  });

  it("aggregates a mixed SDK run into the decision the policy defines", async () => {
    const passing = await evidenceOf(
      new EvalTest({
        id: "c_mixed_pass",
        name: "mixed pass",
        test: async (executor) => {
          await executor.run("go");
          return true;
        },
      }),
      { iterations: 3 }
    );
    const broken = await evidenceOf(
      new EvalTest({
        id: "c_mixed_broken",
        name: "mixed broken",
        scorers: [crashingScorer("gating")],
        test: async (executor) => {
          await executor.run("go");
          return true;
        },
      }),
      { iterations: 2 }
    );
    const decision = aggregateEvalRunVerdict({
      policy: resolveEvalGradingValidityPolicy(undefined),
      cases: [
        {
          caseId: "c_mixed_pass",
          configuredTrials: 3,
          effectivePassThreshold: 1,
          trials: passing.map(evalV2TrialObservation),
        },
        {
          caseId: "c_mixed_broken",
          configuredTrials: 2,
          effectivePassThreshold: 1,
          trials: broken.map(evalV2TrialObservation),
        },
      ],
    });
    // Two broken graders in five attempts: validity fails on the evaluator
    // ceiling and on the case nothing could be graded for — the run says
    // nothing about the server, rather than "failed".
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reasons).toEqual([
      "evaluatorErrorRateAboveMaximum",
      "caseHasNoEligibleTrials",
    ]);
    expect(decision.cases.map((entry) => entry.verdict)).toEqual([
      "passed",
      "inconclusive",
    ]);
  });
});
