/**
 * The golden fixture — the conformance target for the backend materializer.
 *
 * Convex functions bundle independently and cannot import `@mcpjam/sdk`, so
 * `aggregateStageAnalytics` cannot be the code that writes the row: the
 * materializer over in `mcpjam-backend` is hand-written. This file is what
 * keeps "hand-written" from drifting into "different". A second implementation
 * of the same semantics is acceptable; a second, unpinned SEMANTICS is not.
 *
 * The scenario below is deliberately one that exercises every counting rule at
 * once, so a mirror that gets any single one of them wrong fails here rather
 * than in production six weeks later:
 *
 *   - included, excluded-by-lifecycle, unverified, and version-ahead trials;
 *   - labelled and unlabelled intent;
 *   - two models and two hosts;
 *   - a reached-but-undecided stage (the measurement-coverage gap);
 *   - overlapping spans on one stage (the union, not the sum);
 *   - and one setup signal copied across several iterations.
 *
 * Regenerate deliberately with `UPDATE_STAGE_ANALYTICS_GOLDEN=1 vitest run`,
 * and read the diff: this file changing is a CONTRACT change, and the backend
 * mirror has to move with it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  STAGE_ANALYZER_VERSION,
  USER_VALUE_STAGES,
  aggregateStageAnalytics,
  deriveStageMeasurements,
  evalStageAnalyticsSchema,
  type StageAnalyticsInput,
  type StageAnalyticsTrialInput,
  type StageResultRow,
  type UserValueStage,
} from "../src/contract/index.js";

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "stage-analytics-golden.json"
);

const chainOf = (
  states: Partial<Record<UserValueStage, StageResultRow["state"]>>,
  extra: Partial<Record<UserValueStage, Partial<StageResultRow>>> = {}
): StageResultRow[] =>
  USER_VALUE_STAGES.map((stage) => ({
    stage,
    state: states[stage] ?? "passed",
    ...extra[stage],
  }));

const believed = (
  over: Partial<StageAnalyticsTrialInput> & {
    stageResults: StageResultRow[];
    spans?: { id: string; startedAt: number; endedAt: number }[];
  }
): StageAnalyticsTrialInput => {
  const { spans, ...rest } = over;
  return {
    status: "completed",
    stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
    chainVerified: true,
    measurements: deriveStageMeasurements({
      stageResults: over.stageResults,
      spans,
    }),
    measurementsVerified: true,
    ...rest,
  } as StageAnalyticsTrialInput;
};

/** A `selection` stage that cites two OVERLAPPING spans. Union: 800ms. */
const overlappingSelection = chainOf(
  {},
  {
    selection: { evidence: { spanIds: ["p1", "p2"] } },
  }
);

/** `userValue` reached (a span was cited) but undecided — the coverage gap. */
const pendingUserValue = chainOf(
  { userValue: "notMeasured" },
  { userValue: { reason: "judgePending", evidence: { spanIds: ["j1"] } } }
);

const INPUT: StageAnalyticsInput = {
  run: {
    runId: "run_golden",
    suiteId: "suite_golden",
    runGroupId: "group_golden",
    configRevision: "cfg_golden",
    caseSetFingerprint: "cases_golden",
    organizationId: "org_1",
    projectId: "proj_1",
    runCompletedAt: 1_700_000_100_000,
    sourceMaxUpdatedAt: 1_700_000_090_000,
    materializationState: "provisional",
    now: 1_700_000_200_000,
    createdAt: 1_700_000_150_000,
    readerStageAnalyzerVersion: STAGE_ANALYZER_VERSION,
  },
  trials: [
    believed({
      trialKey: "i1",
      stageResults: overlappingSelection,
      spans: [
        { id: "p1", startedAt: 0, endedAt: 500 },
        { id: "p2", startedAt: 250, endedAt: 800 },
      ],
      intent: "search",
      provider: "anthropic",
      model: "claude",
      hostKey: "host_a",
      hostName: "Emulated",
      executionEngine: "emulated",
    }),
    believed({
      trialKey: "i2",
      stageResults: chainOf(
        {
          selection: "failed",
          call: "notReached",
          response: "notReached",
          userValue: "notReached",
        },
        {
          selection: { reason: "missingToolCall" },
        }
      ),
      failureCategory: "selection",
      intent: "search",
      provider: "anthropic",
      model: "claude",
      hostKey: "host_a",
      executionEngine: "emulated",
    }),
    believed({
      trialKey: "i3",
      stageResults: pendingUserValue,
      spans: [{ id: "j1", startedAt: 10, endedAt: 40 }],
      provider: "openai",
      model: "gpt",
      hostKey: "host_b",
      hostName: "Claude Code",
      executionEngine: "harness:claude-code",
    }),
    // Deliberately unlabelled AND notApplicable at the tail.
    believed({
      trialKey: "i4",
      stageResults: chainOf({ userValue: "notApplicable" }),
      provider: "openai",
      model: "gpt",
      hostKey: "host_b",
    }),
    // Excluded three different ways.
    { trialKey: "i5", status: "cancelled", intent: "search" },
    {
      trialKey: "i6",
      status: "completed",
      stageResults: chainOf({}),
      stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
      chainVerified: false,
    },
    {
      trialKey: "i7",
      status: "completed",
      stageResults: chainOf({}),
      stageAnalyzerVersion: STAGE_ANALYZER_VERSION + 1,
      chainVerified: true,
    },
  ],
  // One attempt, copied onto three iterations.
  setupSignals: ["i1", "i2", "i5"].map((trialKey) => ({
    phase: "connection" as const,
    outcome: "failed" as const,
    attribution: "theirs" as const,
    egressVerified: true,
    durationMs: 2500,
    trialKey,
  })),
};

describe("golden fixture", () => {
  const actual = aggregateStageAnalytics(INPUT);

  test("the fixture is a VALID row", () => {
    const parsed = evalStageAnalyticsSchema.safeParse(actual);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  test("matches the committed fixture byte for byte", () => {
    const serialized = `${JSON.stringify(actual, null, 2)}\n`;
    if (process.env.UPDATE_STAGE_ANALYTICS_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }
    expect(serialized).toBe(readFileSync(GOLDEN_PATH, "utf8"));
  });

  test("the scenario actually exercises what it claims to", () => {
    // A fixture that silently stopped covering a rule would keep passing while
    // protecting nothing, so the coverage itself is asserted.
    expect(actual.includedTrials).toBe(4);
    expect(actual.totalTrials).toBe(7);
    expect(actual.excludedTrialDetail).toEqual({
      cancelled: 1,
      chainUnverified: 1,
      chainVersionAhead: 1,
    });
    expect(actual.materializationState).toBe("provisional");
    // All three parity identities present, so a consumer can tell a comparable
    // row from one that merely does not conflict.
    expect(actual.configRevision).toBe("cfg_golden");
    expect(actual.caseSetFingerprint).toBe("cases_golden");
    // Uniform source versions, so no mixed list.
    expect(actual.sourceStageAnalyzerVersions).toBeUndefined();

    const overall = actual.slices.find((s) => s.slice.dimension === "overall")!;
    // Overlapping spans: 0-500 and 250-800 is 800ms of wall time, not 1050.
    expect(overall.stages[2]!.latency).toMatchObject({
      sampleCount: 1,
      totalMs: 800,
    });
    // The measurement-coverage gap: reached, but only some of it decided.
    expect(overall.stages[5]!).toMatchObject({
      reached: 2,
      measured: 1,
      notMeasured: 1,
      notApplicable: 1,
    });
    // Two intents (one unlabelled), two models, two hosts — marginals only.
    expect(
      actual.slices.filter((s) => s.slice.dimension === "intent")
    ).toHaveLength(2);
    expect(
      actual.slices.filter((s) => s.slice.dimension === "model")
    ).toHaveLength(2);
    expect(
      actual.slices.filter((s) => s.slice.dimension === "host")
    ).toHaveLength(2);
    // Three copies of one signal: one attempt, one sample, three impacted.
    expect(actual.setup).toHaveLength(1);
    expect(actual.setup[0]).toMatchObject({
      uniqueAttempts: 1,
      impactedTrials: 3,
      latency: { sampleCount: 1, totalMs: 2500 },
    });
  });
});
