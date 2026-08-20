/**
 * `deriveStageResults` — the derivation half of the user-value chain.
 *
 * The suite is organized around the properties that make the output safe to
 * render, not around the code's branches:
 *
 *   - every one of the five states is reachable, per stage;
 *   - row COUNT and ORDER are invariant (position is how `notReached` works);
 *   - conflicting signals resolve by a stated precedence;
 *   - and — the control this whole step exists for — missing evidence yields
 *     `notMeasured` and NEVER `passed`.
 */

import { describe, expect, test } from "vitest";
import {
  STAGE_ANALYZER_VERSION,
  USER_VALUE_STAGES,
  deriveStageResults,
  stageDerivationSchema,
  stageDerivationToMetadata,
  type StageAuthoredCase,
  type StageDerivationInput,
  type StageResultRow,
  type UserValueStage,
} from "../src/contract/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const modelDrivenCase: StageAuthoredCase = {
  mode: "model_driven",
  expectsToolCall: true,
  assertionCount: 1,
};

const toolSpan = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  category: "tool",
  status: "ok",
  toolName: "list_files",
  promptIndex: 0,
  ...over,
});

const cleanTurn = {
  promptIndex: 0,
  missing: [],
  unexpected: [],
  argumentMismatches: [],
};

function derive(over: Partial<StageDerivationInput> = {}) {
  return deriveStageResults({
    authored: modelDrivenCase,
    evidence: {
      spans: [toolSpan()],
      prompts: [cleanTurn],
      predicateResults: [{ passed: true, reason: "ok" }],
    },
    iteration: { status: "completed" },
    ...over,
  });
}

const stateOf = (rows: StageResultRow[], stage: UserValueStage) =>
  rows.find((r) => r.stage === stage)!;

// ── invariants ───────────────────────────────────────────────────────────────

describe("shape invariants", () => {
  test("always returns exactly six rows in USER_VALUE_STAGES order", () => {
    for (const input of [
      {},
      { iteration: { status: "timed_out" as const } },
      { policy: { blocked: true, reason: "org policy" } },
      { evidence: {} },
    ]) {
      const { stageResults } = derive(input as Partial<StageDerivationInput>);
      expect(stageResults).toHaveLength(USER_VALUE_STAGES.length);
      expect(stageResults.map((r) => r.stage)).toEqual([...USER_VALUE_STAGES]);
    }
  });

  test("stamps the analyzer version on every derivation", () => {
    expect(derive().stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
    expect(
      derive({ iteration: { status: "cancelled" } }).stageAnalyzerVersion
    ).toBe(STAGE_ANALYZER_VERSION);
  });

  test("its own output validates against the persisted-shape schema", () => {
    for (const input of [
      {},
      {
        evidence: {
          spans: [toolSpan({ status: "error" })],
          prompts: [cleanTurn],
        },
      },
      { policy: { blocked: true } },
      { iteration: { status: "setup_failed" as const } },
    ]) {
      const parsed = stageDerivationSchema.safeParse(
        derive(input as Partial<StageDerivationInput>)
      );
      expect(parsed.success).toBe(true);
    }
  });

  test("the schema rejects rows that arrive re-sorted", () => {
    const derivation = derive();
    const sorted = {
      ...derivation,
      stageResults: [...derivation.stageResults].sort((a, b) =>
        a.stage.localeCompare(b.stage)
      ),
    };
    expect(stageDerivationSchema.safeParse(sorted).success).toBe(false);
  });

  test("the schema rejects a firstFailedStage that names no failed row", () => {
    const derivation = derive();
    expect(
      stageDerivationSchema.safeParse({
        ...derivation,
        firstFailedStage: "call",
      }).success
    ).toBe(false);
  });
});

// ── the non-vacuity control ──────────────────────────────────────────────────

describe("NON-VACUITY — missing evidence is never a pass", () => {
  test("an iteration with no evidence at all yields zero passed stages", () => {
    const { stageResults, firstFailedStage } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceAbsent: true },
      iteration: { status: "completed" },
    });
    expect(stageResults.filter((r) => r.state === "passed")).toHaveLength(0);
    expect(stageResults.every((r) => r.state === "notMeasured")).toBe(true);
    // Nothing was measured, so nothing FAILED either — the run says nothing.
    expect(firstFailedStage).toBeUndefined();
  });

  test("a custom executor's message-only trace never passes a stage", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      // The HostExecutor contract does not include spans, so an executor that
      // never populates them produces a trace with messages and no span key.
      evidence: { traceLacksSpanChannel: true },
      iteration: { status: "completed" },
    });
    expect(stageResults.filter((r) => r.state === "passed")).toHaveLength(0);
    expect(stateOf(stageResults, "call")).toMatchObject({
      state: "notMeasured",
      reason: "executorEmitsNoSpans",
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "notMeasured",
      reason: "executorEmitsNoSpans",
    });
  });

  test("`executorEmitsNoSpans` is distinct from `traceAbsent`", () => {
    const absent = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceAbsent: true },
      iteration: { status: "completed" },
    });
    const spanless = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceLacksSpanChannel: true },
      iteration: { status: "completed" },
    });
    expect(stateOf(absent.stageResults, "call").reason).toBe("traceAbsent");
    expect(stateOf(spanless.stageResults, "call").reason).toBe(
      "executorEmitsNoSpans"
    );
  });

  test("a passing predicate list with no spans still leaves `call` unmeasured", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        predicateResults: [{ passed: true, reason: "no tool errors" }],
        traceLacksSpanChannel: true,
      },
      iteration: { status: "completed" },
    });
    // The predicate passed vacuously — it had no spans to inspect. The chain
    // must not launder that into a green `call`.
    expect(stateOf(stageResults, "call").state).toBe("notMeasured");
  });
});

// ── per-stage states ─────────────────────────────────────────────────────────

describe("connection & discovery", () => {
  test("a successful tool span retroactively proves both", () => {
    const { stageResults } = derive();
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "passed",
      reason: "impliedByLaterEvidence",
    });
    expect(stateOf(stageResults, "discovery").state).toBe("passed");
  });

  test("tool-exposure counts alone prove discovery", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { toolSignals: { toolsTotalBefore: 12, toolsExposed: 12 } },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "passed",
      reason: "observed",
    });
  });

  test("no spans and no signals is `noSpanChannel`, not a failure", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceLacksSpanChannel: true },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "notMeasured",
      reason: "noSpanChannel",
    });
  });

  test("a transport-local MCP code does not prove we reached the server", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      // -32001 is a CLIENT-side request timeout, not a server response.
      evidence: {
        spans: [toolSpan({ status: "error", mcpErrorCode: -32001 })],
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "connection").state).toBe("notMeasured");
  });
});

describe("selection", () => {
  test("a missing expected call fails it", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [{ promptIndex: 2, missing: [{ toolName: "search" }] }],
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "failed",
      reason: "missingToolCall",
      evidence: { promptIndexes: [2] },
    });
    expect(firstFailedStage).toBe("selection");
    expect(failureCategory).toBe("selection");
  });

  test("an unexpected call fails it (the negative-case gate)", () => {
    const { stageResults } = derive({
      authored: { ...modelDrivenCase, isNegativeTest: true },
      evidence: {
        spans: [toolSpan()],
        prompts: [{ promptIndex: 0, unexpected: [{ toolName: "delete_all" }] }],
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "failed",
      reason: "unexpectedToolCall",
    });
  });

  test("a model-free case does not have a selection stage", () => {
    const { stageResults } = derive({
      authored: {
        mode: "model_free",
        expectsToolCall: true,
        assertionCount: 1,
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "notApplicable",
      reason: "notAuthored",
    });
  });
});

describe("call & response", () => {
  test("an MCP error code fails `call` as a protocol error", () => {
    const { stageResults, failureCategory } = derive({
      evidence: {
        spans: [toolSpan({ status: "error", mcpErrorCode: -32602 })],
        prompts: [cleanTurn],
      },
    });
    expect(stateOf(stageResults, "call")).toMatchObject({
      state: "failed",
      reason: "protocolError",
    });
    expect(failureCategory).toBe("serverData");
  });

  test("a transport-local code is attributed to setup, not the server", () => {
    const { failureCategory } = derive({
      evidence: {
        spans: [toolSpan({ status: "error", mcpErrorCode: -32000 })],
        prompts: [cleanTurn],
      },
    });
    expect(failureCategory).toBe("setup");
  });

  test("an argument mismatch fails `call` and is categorized as arguments", () => {
    const { stageResults, failureCategory } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [{ promptIndex: 0, argumentMismatches: [{ path: "limit" }] }],
      },
    });
    expect(stateOf(stageResults, "call")).toMatchObject({
      state: "failed",
      reason: "argumentMismatch",
    });
    expect(failureCategory).toBe("arguments");
  });

  test("a DOMAIN error (errored span, no code) fails `response`, not `call`", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      evidence: {
        spans: [toolSpan({ status: "error" })],
        prompts: [cleanTurn],
      },
    });
    // The call reached the server and got a protocol-correct answer; the
    // ANSWER was unusable. That is a `serverData` problem, not an argument one.
    expect(stateOf(stageResults, "call").state).toBe("passed");
    expect(stateOf(stageResults, "response")).toMatchObject({
      state: "failed",
      reason: "toolError",
    });
    expect(firstFailedStage).toBe("response");
    expect(failureCategory).toBe("serverData");
  });

  test("a widget that did not render fails `response`", () => {
    const { stageResults } = derive({
      authored: { ...modelDrivenCase, expectsWidgetRender: true },
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        renderObservations: [{ status: "bridge_timeout" }],
      },
    });
    expect(stateOf(stageResults, "response")).toMatchObject({
      state: "failed",
      reason: "renderFailed",
    });
  });

  test("a case expecting a render with no observation is unmeasured, not passed", () => {
    const { stageResults } = derive({
      authored: { ...modelDrivenCase, expectsWidgetRender: true },
      evidence: { spans: [toolSpan()], prompts: [cleanTurn] },
    });
    expect(stateOf(stageResults, "response")).toMatchObject({
      state: "notMeasured",
      reason: "noEvidenceCaptured",
    });
  });

  test("a pure render probe reaches `response` without expecting a tool call", () => {
    // A widget probe can assert a render while authoring no expected tool call.
    // Gating `response` on the call stage alone would make `renderFailed`
    // unreachable for exactly the case that most needs it.
    const { stageResults } = derive({
      authored: {
        mode: "model_driven",
        expectsToolCall: false,
        expectsWidgetRender: true,
        assertionCount: 0,
      },
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        renderObservations: [{ status: "mount_failed" }],
      },
    });
    expect(stateOf(stageResults, "call").state).toBe("notApplicable");
    expect(stateOf(stageResults, "response")).toMatchObject({
      state: "failed",
      reason: "renderFailed",
    });
  });

  test("a case that expects no tool call has no call/response stages", () => {
    const { stageResults } = derive({
      authored: {
        mode: "model_driven",
        expectsToolCall: false,
        assertionCount: 1,
      },
    });
    expect(stateOf(stageResults, "call").state).toBe("notApplicable");
    expect(stateOf(stageResults, "response").state).toBe("notApplicable");
  });
});

describe("userValue", () => {
  test("a failed predicate fails it and carries its reason", () => {
    const { stageResults, failureCategory } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        predicateResults: [
          { passed: true, reason: "ok" },
          { passed: false, reason: "expected 'Refunded' on screen" },
        ],
      },
    });
    expect(stateOf(stageResults, "userValue")).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
      evidence: { predicateReasons: ["expected 'Refunded' on screen"] },
    });
    expect(failureCategory).toBe("userValue");
  });

  test("a case asserting nothing has no userValue stage", () => {
    const { stageResults } = derive({
      authored: {
        mode: "model_driven",
        expectsToolCall: true,
        assertionCount: 0,
      },
    });
    expect(stateOf(stageResults, "userValue").state).toBe("notApplicable");
  });
});

// ── precedence ───────────────────────────────────────────────────────────────

describe("precedence when signals conflict", () => {
  test("EVALUATOR ERROR: spans say the call succeeded, the grader broke", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        evaluatorErrored: true,
      },
    });
    // What was observed stays observed…
    expect(stateOf(stageResults, "call").state).toBe("passed");
    expect(stateOf(stageResults, "response").state).toBe("passed");
    // …and the thing the grader was supposed to decide is simply unknown.
    expect(stateOf(stageResults, "userValue")).toMatchObject({
      state: "notMeasured",
      reason: "evaluatorError",
    });
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBe("evaluator");
  });

  test("a broken grader never launders a real server failure", () => {
    const { firstFailedStage, failureCategory } = derive({
      evidence: {
        spans: [toolSpan({ status: "error", mcpErrorCode: -32602 })],
        prompts: [cleanTurn],
        evaluatorErrored: true,
      },
    });
    // The server demonstrably failed; that is reported against the server.
    expect(firstFailedStage).toBe("call");
    expect(failureCategory).toBe("serverData");
  });

  test("POLICY BLOCK: notMeasured with a policy reason, never a failure", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      policy: { blocked: true, reason: "tool disabled by org policy" },
    });
    const applicable = stageResults.filter((r) => r.state !== "notApplicable");
    expect(applicable.every((r) => r.state === "notMeasured")).toBe(true);
    expect(applicable.every((r) => r.reason === "blockedByPolicy")).toBe(true);
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBeUndefined();
  });

  test("POSITION: every stage after the first failure is notReached", () => {
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [{ promptIndex: 0, missing: [{ toolName: "search" }] }],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(firstFailedStage).toBe("selection");
    // `call` and `response` had spans that would otherwise have passed, and
    // `userValue` had a passing predicate — the chain broke upstream of all of
    // them, so none of them ran in the sense the chain means.
    expect(stateOf(stageResults, "call")).toMatchObject({
      state: "notReached",
      reason: "earlierStageFailed",
    });
    expect(stateOf(stageResults, "response").state).toBe("notReached");
    expect(stateOf(stageResults, "userValue").state).toBe("notReached");
    // Stages BEFORE the failure keep their own verdicts.
    expect(stateOf(stageResults, "connection").state).toBe("passed");
  });

  test("notApplicable survives notReached propagation", () => {
    const { stageResults } = derive({
      authored: {
        mode: "model_driven",
        expectsToolCall: true,
        assertionCount: 0,
      },
      evidence: {
        spans: [toolSpan()],
        prompts: [{ promptIndex: 0, missing: [{ toolName: "search" }] }],
      },
    });
    expect(stateOf(stageResults, "userValue").state).toBe("notApplicable");
  });
});

// ── lifecycle / row-existence degradation ────────────────────────────────────

describe("honest degradation for rows that never produced a verdict", () => {
  test.each([
    ["setup_failed", "setupAborted"],
    ["cancelled", "lifecycleStopped"],
    ["timed_out", "lifecycleStopped"],
    ["skipped", "lifecycleStopped"],
  ] as const)(
    "status %s ⇒ notMeasured/%s, category setup",
    (status, reason) => {
      const { stageResults, firstFailedStage, failureCategory } = derive({
        iteration: { status },
      });
      const applicable = stageResults.filter(
        (r) => r.state !== "notApplicable"
      );
      expect(applicable.every((r) => r.state === "notMeasured")).toBe(true);
      expect(applicable.every((r) => r.reason === reason)).toBe(true);
      // Harness noise must never inflate a server failure rate.
      expect(firstFailedStage).toBeUndefined();
      expect(failureCategory).toBe("setup");
    }
  );

  test("a `failed` row with no trace is read as a setup abort", () => {
    // `persistSetupFailedIteration` writes status "failed" because the update
    // mutation cannot spell `setup_failed` yet — so the shape, not the status,
    // is what identifies it.
    const { stageResults, firstFailedStage, failureCategory } =
      deriveStageResults({
        authored: modelDrivenCase,
        evidence: { traceAbsent: true },
        iteration: { status: "failed", error: "server not connected" },
      });
    const applicable = stageResults.filter((r) => r.state !== "notApplicable");
    expect(applicable.every((r) => r.reason === "setupAborted")).toBe(true);
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBe("setup");
  });
});

// ── metadata projection ──────────────────────────────────────────────────────

describe("stageDerivationToMetadata", () => {
  test("always carries the rows and the analyzer version", () => {
    const meta = stageDerivationToMetadata(derive());
    expect(meta.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
    expect(Array.isArray(meta.stageResults)).toBe(true);
    // Nothing failed, so neither optional key is invented.
    expect("firstFailedStage" in meta).toBe(false);
    expect("failureCategory" in meta).toBe(false);
  });

  test("carries the failure keys when something failed", () => {
    const meta = stageDerivationToMetadata(
      derive({
        evidence: {
          spans: [toolSpan()],
          prompts: [{ promptIndex: 0, missing: [{ toolName: "x" }] }],
        },
      })
    );
    expect(meta.firstFailedStage).toBe("selection");
    expect(meta.failureCategory).toBe("selection");
  });
});
