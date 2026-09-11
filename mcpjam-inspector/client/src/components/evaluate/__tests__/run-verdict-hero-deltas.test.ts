import { describe, expect, it } from "vitest";

import {
  buildHeroPairings,
  buildHeroStatDeltas,
  buildPassedDelta,
  previousCompletedRunOf,
  previousHeroIterations,
} from "../run-verdict-hero-deltas";
import type { HeroStats } from "../run-verdict-hero-model";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

function stats(overrides: Partial<HeroStats> = {}): HeroStats {
  return {
    cases: { kind: "unavailable" },
    iterations: { passed: 18, total: 48 },
    latencyP50Ms: 19_000,
    latencyP95Ms: 67_000,
    tokens: 1_000_000,
    toolCalls: 70,
    ...overrides,
  };
}

function run(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1_000,
    namedHostId: "cursor",
    effectiveModelId: "gpt-5.1",
    ...overrides,
  } as EvalSuiteRun;
}

describe("buildHeroStatDeltas", () => {
  it("treats more passes as progress and higher latency as regression", () => {
    const deltas = buildHeroStatDeltas(
      stats({
        iterations: { passed: 21, total: 48 },
        latencyP50Ms: 27_000,
        tokens: 1_012_000,
        toolCalls: 65,
      }),
      stats(),
    );
    expect(deltas.passed).toEqual({
      label: "+3",
      direction: "up",
      tone: "progress",
    });
    expect(deltas.latency).toEqual({
      label: "+8.0s",
      direction: "up",
      tone: "regression",
    });
    expect(deltas.tokens).toMatchObject({
      direction: "up",
      tone: "regression",
    });
    expect(deltas.toolCalls).toEqual({
      label: "−5",
      direction: "down",
      tone: "progress",
    });
  });

  it("treats fewer passes as regression and lower latency as progress", () => {
    const deltas = buildHeroStatDeltas(
      stats({
        iterations: { passed: 16, total: 48 },
        latencyP50Ms: 11_000,
        tokens: 800_000,
        toolCalls: 80,
      }),
      stats(),
    );
    expect(deltas.passed).toMatchObject({
      direction: "down",
      tone: "regression",
    });
    expect(deltas.latency).toMatchObject({
      direction: "down",
      tone: "progress",
    });
    expect(deltas.tokens).toMatchObject({
      direction: "down",
      tone: "progress",
    });
    expect(deltas.toolCalls).toMatchObject({
      direction: "up",
      tone: "regression",
    });
  });

  it("keeps an unchanged metric quiet", () => {
    const deltas = buildHeroStatDeltas(stats(), stats());
    expect(deltas.passed).toEqual({
      label: "=",
      direction: "same",
      tone: "same",
    });
    expect(deltas.latency?.tone).toBe("same");
  });

  it("does not compare a case count to an iteration fallback", () => {
    const deltas = buildHeroStatDeltas(
      stats({
        cases: { kind: "cases", passed: 21, total: 48, inconclusive: 0 },
      }),
      stats(),
    );
    expect(deltas.passed).toBeNull();
    expect(deltas.latency).not.toBeNull();
  });

  it("omits a metric when either side did not record it", () => {
    const deltas = buildHeroStatDeltas(
      stats({ tokens: null, toolCalls: 10 }),
      stats({ tokens: 100, toolCalls: null }),
    );
    expect(deltas.tokens).toBeNull();
    expect(deltas.toolCalls).toBeNull();
  });
});

describe("previous completed run", () => {
  const current = run({
    _id: "run-3",
    runNumber: 3,
    createdAt: 3_000,
    runGroupId: "g3",
  });
  const previous = run({
    _id: "run-2",
    runNumber: 2,
    createdAt: 2_000,
    runGroupId: "g2",
  });
  const older = run({
    _id: "run-1",
    runNumber: 1,
    createdAt: 1_000,
    runGroupId: "g1",
  });
  const otherHost = run({
    _id: "run-2b",
    runNumber: 2,
    createdAt: 2_100,
    namedHostId: "chatgpt",
    runGroupId: "g2",
  });
  const sameGroup = run({
    _id: "run-3b",
    runNumber: 3,
    createdAt: 3_100,
    namedHostId: "chatgpt",
    runGroupId: "g3",
  });

  it("picks the immediately earlier completed run of the same host and model", () => {
    expect(
      previousCompletedRunOf(current, [
        current,
        previous,
        older,
        otherHost,
        sameGroup,
      ])?._id,
    ).toBe("run-2");
  });

  it("returns nothing for the first run of a pairing", () => {
    expect(previousCompletedRunOf(older, [older, current])).toBeNull();
  });

  it("uses the previous launch aggregate even when a current pairing is new", () => {
    const previousRow = {
      _id: "it-prev",
      suiteRunId: "run-2",
      result: "passed",
    } as EvalIteration;
    expect(
      previousHeroIterations({
        selectedRuns: [current, sameGroup],
        suiteRuns: [current, previous, sameGroup],
        allIterations: [previousRow],
      }),
    ).toEqual([previousRow]);
  });

  it("returns every previous-launch iteration, not one pairing", () => {
    const previousRows = [
      {
        _id: "it-prev-cursor",
        suiteRunId: "run-2",
        result: "passed",
      } as EvalIteration,
      {
        _id: "it-prev-chatgpt",
        suiteRunId: "run-2b",
        result: "failed",
      } as EvalIteration,
    ];
    expect(
      previousHeroIterations({
        selectedRuns: [current, sameGroup],
        suiteRuns: [current, previous, older, otherHost, sameGroup],
        allIterations: previousRows,
        previousRunId: "run-2",
      }),
    ).toEqual(previousRows);
  });

  it("returns the previous run's iterations when history is on the page", () => {
    const previousRow = {
      _id: "it-prev",
      suiteRunId: "run-2",
      result: "passed",
    } as EvalIteration;
    expect(
      previousHeroIterations({
        selectedRuns: [current],
        suiteRuns: [current, previous],
        allIterations: [previousRow],
        previousRunId: "run-2",
      }),
    ).toEqual([previousRow]);
  });

  it("keeps only the selected pairing when filtering the previous launch", () => {
    const previousRows = [
      {
        _id: "it-prev-cursor",
        suiteRunId: "run-2",
        result: "passed",
      } as EvalIteration,
      {
        _id: "it-prev-chatgpt",
        suiteRunId: "run-2b",
        result: "failed",
      } as EvalIteration,
    ];
    expect(
      previousHeroIterations({
        selectedRuns: [current],
        suiteRuns: [current, previous, older, otherHost, sameGroup],
        allIterations: previousRows,
        previousRunId: "run-2",
        matchSelectedPairings: true,
      }),
    ).toEqual([previousRows[0]]);
  });
});

describe("buildHeroPairings", () => {
  it("compares each pairing to its previous-launch twin, not the aggregate", () => {
    const cursor = run({
      _id: "now-cursor",
      namedHostId: "cursor",
      effectiveModelId: "gpt-5.1",
    });
    const chatgpt = run({
      _id: "now-chatgpt",
      namedHostId: "chatgpt",
      effectiveModelId: "gpt-5.1",
    });
    const prevCursor = run({
      _id: "prev-cursor",
      namedHostId: "cursor",
      effectiveModelId: "gpt-5.1",
    });
    const prevChatgpt = run({
      _id: "prev-chatgpt",
      namedHostId: "chatgpt",
      effectiveModelId: "gpt-5.1",
    });
    const pairings = buildHeroPairings({
      targets: [
        {
          key: "cursor",
          run: cursor,
          client: "Cursor",
          modelId: "gpt-5.1",
          model: "gpt-5.1",
          iterations: [
            { result: "passed", status: "completed", resultSource: "reported" } as EvalIteration,
            { result: "passed", status: "completed", resultSource: "reported" } as EvalIteration,
            { result: "failed", status: "completed", resultSource: "reported" } as EvalIteration,
          ],
        },
        {
          key: "chatgpt",
          run: chatgpt,
          client: "ChatGPT",
          modelId: "gpt-5.1",
          model: "gpt-5.1",
          iterations: [
            { result: "failed", status: "completed", resultSource: "reported" } as EvalIteration,
          ],
        },
      ],
      previousLaunch: [prevCursor, prevChatgpt],
      previousIterations: [
        { suiteRunId: "prev-cursor", result: "passed" } as EvalIteration,
        { suiteRunId: "prev-chatgpt", result: "passed" } as EvalIteration,
      ],
    });
    expect(pairings[0]).toMatchObject({
      client: "Cursor",
      passed: 2,
      failed: 1,
      total: 3,
      delta: { label: "+1", direction: "up", tone: "progress" },
    });
    expect(pairings[1]).toMatchObject({
      client: "ChatGPT",
      passed: 0,
      failed: 1,
      total: 1,
      delta: { label: "−1", direction: "down", tone: "regression" },
    });
  });

  it("omits a delta when that pairing has no previous twin", () => {
    const pairings = buildHeroPairings({
      targets: [
        {
          key: "new",
          run: run({
            _id: "now-new",
            namedHostId: "claude",
            effectiveModelId: "opus",
          }),
          client: "Claude",
          modelId: "opus",
          model: "opus",
          iterations: [
            { result: "passed", status: "completed", resultSource: "reported" } as EvalIteration,
          ],
        },
      ],
      previousLaunch: [
        run({
          _id: "prev-cursor",
          namedHostId: "cursor",
          effectiveModelId: "gpt-5.1",
        }),
      ],
      previousIterations: [
        { suiteRunId: "prev-cursor", result: "passed" } as EvalIteration,
      ],
    });
    expect(pairings[0].delta).toBeNull();
    expect(pairings[0]).toMatchObject({ passed: 1, total: 1 });
  });

  it("does not invent a first-launch zero", () => {
    expect(
      buildPassedDelta(21, null),
    ).toBeNull();
    const pairings = buildHeroPairings({
      targets: [
        {
          key: "solo",
          run: run({ _id: "first" }),
          client: "Cursor",
          modelId: "gpt-5.1",
          model: "gpt-5.1",
          iterations: [
            { result: "passed", status: "completed", resultSource: "reported" } as EvalIteration,
          ],
        },
      ],
      previousLaunch: null,
      previousIterations: null,
    });
    expect(pairings[0].delta).toBeNull();
  });
});
