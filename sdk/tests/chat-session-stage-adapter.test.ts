/**
 * The chat-session adapter: golden fixtures for the three sources, plus the
 * rules D8 exists to enforce.
 *
 * The central assertion of the whole file is the one at the top of
 * "identical normalized evidence derives identically": User Testing, swarm and
 * direct sessions that captured the SAME thing must produce the SAME six rows.
 * A funnel that reads differently per surface is a funnel nobody can compare.
 */

import { describe, test, expect } from "vitest";
import {
  CHAT_SESSION_STAGE_SOURCES,
  buildChatSessionAuthoredCase,
  buildChatSessionStageInput,
  deriveStageResults,
  STAGE_ANALYZER_VERSION,
  type ChatSessionStageInput,
  type ChatSessionStageSource,
  type StageResultRow,
  type StageSpanLike,
  type StageState,
  type UserValueStage,
} from "../src/contract/index.js";

const okToolSpan = (id: string, toolName: string): StageSpanLike => ({
  id,
  category: "tool",
  status: "ok",
  toolName,
});

const domainErrorToolSpan = (id: string, toolName: string): StageSpanLike => ({
  id,
  category: "tool",
  status: "error",
  toolName,
});

const protocolErrorToolSpan = (
  id: string,
  toolName: string
): StageSpanLike => ({
  id,
  category: "tool",
  status: "error",
  toolName,
  mcpErrorCode: -32603,
});

function base(
  over: Partial<ChatSessionStageInput> = {}
): ChatSessionStageInput {
  return {
    source: "user_testing",
    hasUserAsk: true,
    lifecycle: "settled",
    ...over,
  };
}

const derive = (input: ChatSessionStageInput) =>
  deriveStageResults(buildChatSessionStageInput(input));

const rowFor = (rows: StageResultRow[], stage: UserValueStage) => {
  const row = rows.find((candidate) => candidate.stage === stage);
  if (!row) throw new Error(`no ${stage} row`);
  return row;
};

/** Compact `stage:state` shape — what a funnel actually reads. */
const shape = (rows: StageResultRow[]): Record<UserValueStage, StageState> =>
  Object.fromEntries(rows.map((r) => [r.stage, r.state])) as Record<
    UserValueStage,
    StageState
  >;

// ── golden fixtures ──────────────────────────────────────────────────────────

const READY_TOOL_SESSION: Partial<ChatSessionStageInput> = {
  spans: [okToolSpan("span-1", "search_docs")],
  readiness: {
    status: "completed",
    toolCallCount: 1,
    advertisedToolCount: 9,
    advertisedToolsKnown: true,
  },
};

describe("golden: a real User Testing session graded by production checks", () => {
  const rows = derive(
    base({
      source: "user_testing",
      ...READY_TOOL_SESSION,
      criteria: {
        status: "completed",
        results: [{ criterionId: "answered", passed: true }],
      },
    })
  );

  test("the whole chain", () => {
    expect(shape(rows.stageResults)).toEqual({
      connection: "passed",
      discovery: "passed",
      // Rule 1: a call ran, but nothing says the RIGHT tool ran.
      selection: "notMeasured",
      call: "passed",
      response: "passed",
      userValue: "passed",
    });
    expect(rows.firstFailedStage).toBeUndefined();
    expect(rows.failureCategory).toBeUndefined();
    expect(rows.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
  });

  test("selection names WHY it is unmeasured rather than going quiet", () => {
    expect(rowFor(rows.stageResults, "selection")).toMatchObject({
      reason: "matchVerdictUnavailable",
      evidence: { spanIds: ["span-1"] },
    });
  });

  test("a failed production criterion is a userValue failure, not a setup one", () => {
    const failed = derive(
      base({
        ...READY_TOOL_SESSION,
        criteria: {
          status: "completed",
          results: [
            { criterionId: "answered", passed: false },
            { criterionId: "cited", passed: true },
          ],
        },
      })
    );
    expect(rowFor(failed.stageResults, "userValue")).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
    });
    expect(failed.firstFailedStage).toBe("userValue");
    expect(failed.failureCategory).toBe("userValue");
  });
});

describe("golden: a swarm session with a rubric and a goal judge", () => {
  test("deterministic criteria outrank a disagreeing judge", () => {
    const rows = derive(
      base({
        source: "swarm",
        ...READY_TOOL_SESSION,
        criteria: {
          status: "completed",
          results: [{ criterionId: "booked", passed: false }],
        },
        goalJudge: { status: "completed", passed: true, reason: "looks fine" },
      })
    );
    expect(rowFor(rows.stageResults, "userValue")).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
    });
  });

  test("the judge fills deterministic silence", () => {
    const rows = derive(
      base({
        source: "swarm",
        ...READY_TOOL_SESSION,
        goalJudge: {
          status: "completed",
          passed: true,
          reason: "the persona booked the room",
        },
      })
    );
    expect(rowFor(rows.stageResults, "userValue")).toMatchObject({
      state: "passed",
      reason: "judgeObserved",
      evidence: { predicateReasons: ["the persona booked the room"] },
    });
  });

  test("a judge FAIL is a userValue failure, not a server-data one", () => {
    const rows = derive(
      base({
        source: "swarm",
        ...READY_TOOL_SESSION,
        goalJudge: { status: "completed", passed: false },
      })
    );
    expect(rowFor(rows.stageResults, "userValue").state).toBe("failed");
    expect(rows.failureCategory).toBe("userValue");
  });
});

describe("golden: a direct / playground session (D8p substrate)", () => {
  test("upstream evidence is real; userValue stays unmeasured with no grader", () => {
    const rows = derive(base({ source: "direct", ...READY_TOOL_SESSION }));
    expect(shape(rows.stageResults)).toEqual({
      connection: "passed",
      discovery: "passed",
      selection: "notMeasured",
      call: "passed",
      response: "passed",
      userValue: "notMeasured",
    });
    expect(rowFor(rows.stageResults, "userValue").reason).toBe(
      "judgeNotRequested"
    );
  });
});

// ── the cross-surface invariant ──────────────────────────────────────────────

describe("identical normalized evidence derives identically across surfaces", () => {
  const evidence: Partial<ChatSessionStageInput> = {
    ...READY_TOOL_SESSION,
    criteria: {
      status: "completed",
      results: [{ criterionId: "answered", passed: true }],
    },
  };

  test("every source produces the same six rows", () => {
    const derivations = CHAT_SESSION_STAGE_SOURCES.map((source) =>
      derive(base({ source, ...evidence }))
    );
    const [first, ...rest] = derivations;
    for (const other of rest) expect(other).toEqual(first);
  });

  test("the SOURCE never reaches the analyzer input at all", () => {
    const inputs = CHAT_SESSION_STAGE_SOURCES.map((source) =>
      buildChatSessionStageInput(base({ source, ...evidence }))
    );
    const [first, ...rest] = inputs;
    for (const other of rest) expect(other).toEqual(first);
  });
});

// ── rule 1: a tool call does not prove selection ─────────────────────────────

describe("selection is never inferred from a call", () => {
  test("many successful calls still leave selection unmeasured", () => {
    const rows = derive(
      base({
        spans: [
          okToolSpan("s1", "a"),
          okToolSpan("s2", "b"),
          okToolSpan("s3", "c"),
        ],
      })
    );
    expect(rowFor(rows.stageResults, "selection")).toMatchObject({
      state: "notMeasured",
      reason: "matchVerdictUnavailable",
    });
  });

  test("no calls at all is `noEvidenceCaptured`, a different sentence", () => {
    const rows = derive(base({}));
    expect(rowFor(rows.stageResults, "selection")).toMatchObject({
      state: "notMeasured",
      reason: "noEvidenceCaptured",
    });
  });

  test("no trace at all is `traceAbsent`, a third sentence", () => {
    // "The run recorded no trace" and "a sink existed and captured nothing"
    // send an operator to two different places, so `selection` reports them
    // apart — the same way `call` and `response` already do.
    const rows = derive(base({ traceAbsent: true }));
    expect(rowFor(rows.stageResults, "selection")).toMatchObject({
      state: "notMeasured",
      reason: "traceAbsent",
    });
    for (const stage of ["call", "response"] as const) {
      expect(rowFor(rows.stageResults, stage).reason).toBe("traceAbsent");
    }
  });

  test("selection is APPLICABLE — an unmeasured gap, never hidden", () => {
    const rows = derive(base({}));
    expect(rowFor(rows.stageResults, "selection").state).not.toBe(
      "notApplicable"
    );
  });

  test("the authored case says so on the wire", () => {
    expect(buildChatSessionAuthoredCase({ hasUserAsk: true })).toEqual({
      mode: "model_driven",
      expectsToolCall: false,
      expectsWidgetRender: false,
      assertionCount: 0,
      hasUserAsk: true,
      toolExpectation: "open",
    });
  });
});

// ── rule 6: ask vs no ask ────────────────────────────────────────────────────

describe("an ask without a grader is unmeasured; no ask is inapplicable", () => {
  test("ask + no grader ⇒ notMeasured / judgeNotRequested", () => {
    const rows = derive(base({ hasUserAsk: true, ...READY_TOOL_SESSION }));
    expect(rowFor(rows.stageResults, "userValue")).toMatchObject({
      state: "notMeasured",
      reason: "judgeNotRequested",
    });
  });

  test("no ask ⇒ notApplicable / notAuthored", () => {
    const rows = derive(base({ hasUserAsk: false, ...READY_TOOL_SESSION }));
    expect(rowFor(rows.stageResults, "userValue")).toMatchObject({
      state: "notApplicable",
      reason: "notAuthored",
    });
  });

  test("neither is ever a pass", () => {
    for (const hasUserAsk of [true, false]) {
      const rows = derive(base({ hasUserAsk, ...READY_TOOL_SESSION }));
      expect(rowFor(rows.stageResults, "userValue").state).not.toBe("passed");
    }
  });
});

// ── rule 4: a broken grader is unmeasured ────────────────────────────────────

describe("grader failure is unmeasured, never a product failure", () => {
  test("failed deterministic criteria ⇒ evaluatorError", () => {
    const rows = derive(
      base({ ...READY_TOOL_SESSION, criteria: { status: "failed" } })
    );
    expect(rowFor(rows.stageResults, "userValue")).toMatchObject({
      state: "notMeasured",
      reason: "evaluatorError",
    });
    expect(rows.firstFailedStage).toBeUndefined();
    expect(rows.failureCategory).toBe("evaluator");
  });

  test("a judge is NOT promoted into the silence a broken grader left", () => {
    const rows = derive(
      base({
        ...READY_TOOL_SESSION,
        criteria: { status: "failed" },
        goalJudge: { status: "completed", passed: true },
      })
    );
    expect(rowFor(rows.stageResults, "userValue").state).toBe("notMeasured");
  });

  test("a failed judge is an evaluator error too", () => {
    const rows = derive(
      base({ ...READY_TOOL_SESSION, goalJudge: { status: "failed" } })
    );
    expect(rowFor(rows.stageResults, "userValue")).toMatchObject({
      state: "notMeasured",
      reason: "evaluatorError",
    });
  });

  test("criteria still pending ⇒ a verdict is owed, not a verdict", () => {
    const rows = derive(
      base({ ...READY_TOOL_SESSION, criteria: { status: "pending" } })
    );
    expect(rowFor(rows.stageResults, "userValue")).toMatchObject({
      state: "notMeasured",
      reason: "judgePending",
    });
  });

  test("an empty rubric grades nothing — no vacuous pass", () => {
    const rows = derive(
      base({
        ...READY_TOOL_SESSION,
        criteria: { status: "completed", results: [], criterionIds: [] },
      })
    );
    expect(rowFor(rows.stageResults, "userValue").state).toBe("notMeasured");
  });

  /**
   * Zero rows is not automatically "there was no rubric".
   *
   * A completed grade whose scope NAMED criteria but produced no readable rows
   * is a grade we failed to read. Treating that silence as an empty rubric
   * would let the goal judge answer `userValue` on a session the deterministic
   * rubric was supposed to decide — which is the judge outranking the criteria,
   * exactly backwards.
   */
  test("zero rows against a NAMED scope never lets the judge answer", () => {
    const rows = derive(
      base({
        ...READY_TOOL_SESSION,
        criteria: { status: "completed", results: [], criterionIds: ["c1"] },
        goalJudge: { status: "completed", passed: true },
      })
    );
    expect(rowFor(rows.stageResults, "userValue").state).toBe("notMeasured");
  });

  test("zero rows with NO scope never lets the judge answer either", () => {
    // An unknown scope cannot prove there was nothing to grade.
    const rows = derive(
      base({
        ...READY_TOOL_SESSION,
        criteria: { status: "completed", results: [] },
        goalJudge: { status: "completed", passed: true },
      })
    );
    expect(rowFor(rows.stageResults, "userValue").state).toBe("notMeasured");
  });

  test("an EXPLICITLY empty rubric does let the judge answer", () => {
    // The one shape where the silence is real.
    const rows = derive(
      base({
        ...READY_TOOL_SESSION,
        criteria: { status: "completed", results: [], criterionIds: [] },
        goalJudge: { status: "completed", passed: true },
      })
    );
    expect(rowFor(rows.stageResults, "userValue").state).toBe("passed");
  });
});

// ── rule 5: no manufactured connection failure ───────────────────────────────

describe("no connection failure is manufactured", () => {
  const HOSTILE: ChatSessionStageInput[] = [
    base({ traceAbsent: true }),
    base({ lifecycle: "stopped" }),
    base({ readiness: { status: "failed" } }),
    base({
      readiness: {
        status: "partial",
        advertisedToolCount: 0,
        advertisedToolsKnown: false,
      },
    }),
    base({ spans: [protocolErrorToolSpan("s1", "search")] }),
    base({ spans: [domainErrorToolSpan("s1", "search")] }),
  ];

  test("connection never fails, on any of these", () => {
    for (const input of HOSTILE) {
      expect(rowFor(derive(input).stageResults, "connection").state).not.toBe(
        "failed"
      );
    }
  });

  test("the adapter emits no setupSignals at all", () => {
    for (const input of HOSTILE) {
      expect(
        buildChatSessionStageInput(input).evidence.setupSignals
      ).toBeUndefined();
    }
  });

  test("an unknown advertised inventory establishes nothing", () => {
    const input = buildChatSessionStageInput(
      base({
        readiness: {
          status: "partial",
          advertisedToolCount: 0,
          advertisedToolsKnown: false,
        },
      })
    );
    expect(input.evidence.toolSignals).toBeUndefined();
    expect(rowFor(derive(base({})).stageResults, "connection").state).toBe(
      "notMeasured"
    );
  });
});

// ── rule 2: readiness is evidence, not a verdict ─────────────────────────────

describe("readiness is evidence, not a chain verdict", () => {
  test("a `not_ready` readiness with clean spans still reads clean", () => {
    const rows = derive(
      base({
        spans: [okToolSpan("s1", "search")],
        readiness: {
          status: "completed",
          toolCallCount: 1,
          advertisedToolCount: 4,
          advertisedToolsKnown: true,
        },
      })
    );
    expect(rowFor(rows.stageResults, "call").state).toBe("passed");
    expect(rowFor(rows.stageResults, "response").state).toBe("passed");
  });

  test("a known inventory establishes connection AND discovery", () => {
    const rows = derive(
      base({
        readiness: {
          status: "completed",
          advertisedToolCount: 7,
          advertisedToolsKnown: true,
        },
      })
    );
    expect(shape(rows.stageResults)).toMatchObject({
      connection: "passed",
      discovery: "passed",
    });
  });
});

// ── measured upstream failures still work ────────────────────────────────────

describe("real upstream failures are still measured", () => {
  test("a protocol error fails `call` and blanks what came after it", () => {
    const rows = derive(
      base({
        readiness: {
          status: "completed",
          advertisedToolCount: 3,
          advertisedToolsKnown: true,
        },
        spans: [protocolErrorToolSpan("s1", "search")],
      })
    );
    expect(shape(rows.stageResults)).toMatchObject({
      connection: "passed",
      call: "failed",
      response: "notReached",
      userValue: "notReached",
    });
    expect(rows.firstFailedStage).toBe("call");
  });

  test("a domain error fails `response`, not `call`", () => {
    const rows = derive(base({ spans: [domainErrorToolSpan("s1", "search")] }));
    expect(shape(rows.stageResults)).toMatchObject({
      call: "passed",
      response: "failed",
    });
    expect(rows.failureCategory).toBe("serverData");
  });

  test("an upstream failure discards a judge PASS rather than rendering it", () => {
    const rows = derive(
      base({
        spans: [protocolErrorToolSpan("s1", "search")],
        goalJudge: { status: "completed", passed: true },
      })
    );
    expect(rowFor(rows.stageResults, "userValue").state).toBe("notReached");
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  test("a stopped session measures nothing and fails nothing", () => {
    const rows = derive(base({ lifecycle: "stopped", ...READY_TOOL_SESSION }));
    for (const row of rows.stageResults) {
      expect(row.state).not.toBe("failed");
      expect(row.state).not.toBe("passed");
    }
    // `failureCategory` answers "why is there no good outcome", not "which
    // stage failed" — the analyzer buckets a stopped run under `setup` and
    // leaves `firstFailedStage` absent. An abandoned transcript therefore
    // reaches no aggregate's numerator: eligible is passed + failed only.
    expect(rows.firstFailedStage).toBeUndefined();
    expect(rows.failureCategory).toBe("setup");
  });

  test("a running session still derives from what it has", () => {
    const rows = derive(base({ lifecycle: "running", ...READY_TOOL_SESSION }));
    expect(rowFor(rows.stageResults, "call").state).toBe("passed");
  });

  test("the source list is closed and covers the three surfaces", () => {
    const expected: ChatSessionStageSource[] = [
      "user_testing",
      "swarm",
      "direct",
    ];
    expect([...CHAT_SESSION_STAGE_SOURCES]).toEqual(expected);
  });
});
