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
import { STAGE_REASON_LABELS } from "../src/contract/decision-labels.js";
import { finalizePassedForEval } from "../src/eval-tool-execution";
import {
  GRADER_PRESENTATION_GROUP,
  GRADER_STAGE,
  MAX_EVIDENCE_REASONS,
  MAX_EVIDENCE_REASON_CHARS,
  PREDICATE_KINDS,
  PREDICATE_STAGE,
  STAGE_ANALYZER_VERSION,
  STAGE_REASONS,
  USER_VALUE_STAGES,
  deriveStageResults,
  isSelectionPredicateKind,
  isSelectionStagePredicateKind,
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
  passed: true,
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

  test("no spans and no signals is `noEvidenceCaptured`, not a failure", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceLacksSpanChannel: true },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "notMeasured",
      reason: "noEvidenceCaptured",
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "notMeasured",
      reason: "noEvidenceCaptured",
    });
  });

  test("`noSpanChannel` stays in the vocabulary for old producers", () => {
    expect(STAGE_REASONS).toContain("noSpanChannel");
  });

  test("signal ok ⇒ connection passed/observed", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: { connection: { outcome: "ok" } },
      },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "passed",
      reason: "observed",
    });
  });

  test("failed + theirs + egressVerified ⇒ connection failed/connectFailed", () => {
    const { stageResults, firstFailedStage, failureCategory } =
      deriveStageResults({
        authored: modelDrivenCase,
        evidence: {
          setupSignals: {
            connection: {
              outcome: "failed",
              attribution: "theirs",
              egressVerified: true,
              spanIds: ["run-connect-s1"],
            },
          },
        },
        iteration: { status: "failed" },
      });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "failed",
      reason: "connectFailed",
      evidence: { spanIds: ["run-connect-s1"] },
    });
    expect(firstFailedStage).toBe("connection");
    expect(failureCategory).toBe("setup");
  });

  test("failed + theirs without canary ⇒ notMeasured/egressUnverified", () => {
    const { stageResults, firstFailedStage } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          connection: {
            outcome: "failed",
            attribution: "theirs",
          },
        },
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "notMeasured",
      reason: "egressUnverified",
    });
    expect(firstFailedStage).toBeUndefined();
  });

  test("unknown attribution ⇒ notMeasured/egressUnverified", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          connection: { outcome: "failed", attribution: "unknown" },
        },
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "notMeasured",
      reason: "egressUnverified",
    });
  });

  test("ours attribution ⇒ notMeasured/setupAborted", () => {
    const { stageResults, failureCategory } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        traceAbsent: true,
        setupSignals: {
          connection: { outcome: "failed", attribution: "ours" },
        },
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "notMeasured",
      reason: "setupAborted",
    });
    expect(failureCategory).toBe("setup");
  });

  test("later tool spans outrank a contradictory failed classification", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        spans: [toolSpan()],
        setupSignals: {
          connection: {
            outcome: "failed",
            attribution: "theirs",
            egressVerified: true,
          },
        },
      },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "passed",
      reason: "impliedByLaterEvidence",
    });
  });

  test("toolsTotalBefore outranks a failed classification", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        toolSignals: { toolsTotalBefore: 3 },
        setupSignals: {
          connection: {
            outcome: "failed",
            attribution: "theirs",
            egressVerified: true,
          },
        },
      },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "passed",
      reason: "impliedByLaterEvidence",
    });
  });

  test("discovery signal ok ⇒ passed/observed", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          connection: { outcome: "ok" },
          discovery: { outcome: "ok" },
        },
      },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "passed",
      reason: "observed",
    });
  });

  test("discovery failed + reached + theirs ⇒ failed/toolsListFailed", () => {
    const { stageResults, firstFailedStage, failureCategory } =
      deriveStageResults({
        authored: modelDrivenCase,
        evidence: {
          setupSignals: {
            connection: { outcome: "ok" },
            discovery: {
              outcome: "failed",
              attribution: "theirs",
              spanIds: ["run-toolslist-s1"],
            },
          },
        },
        iteration: { status: "failed" },
      });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "failed",
      reason: "toolsListFailed",
      evidence: { spanIds: ["run-toolslist-s1"] },
    });
    expect(firstFailedStage).toBe("discovery");
    expect(failureCategory).toBe("setup");
  });

  test("discovery failed + reached + theirs ignores a failed canary stamp", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          connection: { outcome: "ok" },
          discovery: {
            outcome: "failed",
            attribution: "theirs",
            egressVerified: false,
          },
        },
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "failed",
      reason: "toolsListFailed",
    });
  });

  test("discovery failed + reached + unknown ⇒ notMeasured", () => {
    const { stageResults, firstFailedStage } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          connection: { outcome: "ok" },
          discovery: { outcome: "failed", attribution: "unknown" },
        },
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "notMeasured",
      reason: "egressUnverified",
    });
    expect(firstFailedStage).toBeUndefined();
  });

  test("discovery failed + ours ⇒ notMeasured/setupAborted", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          connection: { outcome: "ok" },
          discovery: { outcome: "failed", attribution: "ours" },
        },
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "notMeasured",
      reason: "setupAborted",
    });
  });

  test("discovery failed without a reached connection ⇒ egressUnverified", () => {
    const { stageResults } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          discovery: { outcome: "failed", attribution: "theirs" },
        },
      },
      iteration: { status: "failed" },
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "notMeasured",
      reason: "egressUnverified",
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

  test("an unexpected call the turn ADJUDICATED as failing fails it", () => {
    const { stageResults } = derive({
      authored: { ...modelDrivenCase, isNegativeTest: true },
      evidence: {
        spans: [toolSpan()],
        prompts: [
          {
            promptIndex: 0,
            unexpected: [{ toolName: "delete_all" }],
            passed: false,
          },
        ],
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "failed",
      reason: "unexpectedToolCall",
    });
  });

  /**
   * The regression this gate exists for.
   *
   * `unexpected` is populated whenever an actual call went unmatched, but
   * `maxExtraToolCalls` DEFAULTS to `null` — extras are reported and tolerated.
   * Reading the raw field reported a PASSING agentic run (a search call before
   * the expected one) as `failed` at `selection`, and then blanked `call`,
   * `response` and `userValue` behind an `earlierStageFailed` that never
   * happened. That is the common shape of a multi-turn case, not an edge one.
   */
  test("an unexpected call the turn TOLERATED does not fail it", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [
          {
            promptIndex: 0,
            missing: [],
            unexpected: [{ toolName: "search" }],
            argumentMismatches: [],
            passed: true,
          },
        ],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "passed",
      reason: "observed",
    });
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBeUndefined();
    // …and the stages behind it keep their measured verdicts.
    expect(stateOf(stageResults, "call").state).toBe("passed");
    expect(stateOf(stageResults, "userValue").state).toBe("passed");
  });

  test("extras with NO reported verdict are notMeasured, never failed", () => {
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [{ promptIndex: 0, unexpected: [{ toolName: "search" }] }],
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "notMeasured",
      reason: "matchVerdictUnavailable",
      evidence: { promptIndexes: [0] },
    });
    expect(firstFailedStage).toBeUndefined();
  });

  test("a failing turn carrying BOTH extras and argument mismatches is left to `call`", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [
          {
            promptIndex: 0,
            unexpected: [{ toolName: "search" }],
            argumentMismatches: [{ toolName: "list_files" }],
            passed: false,
          },
        ],
      },
    });
    // The verdict cannot say WHICH of the two sank the turn, so the earlier
    // stage is not blamed on a guess.
    expect(stateOf(stageResults, "selection").state).not.toBe("failed");
    expect(firstFailedStage).toBe("call");
    expect(failureCategory).toBe("arguments");
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

// ── UVH-IN2: a model-call failure is OURS, not the server's ──────────────────
//
// 20 prod trials failed on "credit balance too low… Anthropic API": the step
// errored, asserts were skipped, and the chain ended `noEvidenceCaptured` with
// NO failure category — an outage filed as an unattributed server failure.

describe("a model-call failure is attributed, not left blank", () => {
  const providerDied = { stepError: { source: "model" as const } };

  test("blank stages read as providerError, and the run is categorised setup", () => {
    const { stageResults, failureCategory, firstFailedStage } = derive({
      evidence: { traceAbsent: true, ...providerDied },
    });

    // Every applicable stage says the same true thing: we never got to ask.
    for (const r of stageResults.filter((x) => x.state === "notMeasured")) {
      expect(r.reason).toBe("providerError");
    }
    // `setup` is the existing bucket for our own side breaking, so no new
    // category was needed — but a category there MUST be.
    expect(failureCategory).toBe("setup");
    // Never `failed`: our provider's bad day is not the server's defect.
    expect(firstFailedStage).toBeUndefined();
    expect(stageResults.some((r) => r.state === "failed")).toBe(false);
  });

  test("stages that DID measure something keep their own rows", () => {
    // A provider dying at turn 4 does not un-observe turns 1-3. Only the
    // blank rows are re-labelled.
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        ...providerDied,
      },
    });
    expect(stateOf(stageResults, "call").state).toBe("passed");
    expect(stateOf(stageResults, "selection").state).toBe("passed");
  });

  test("a missing call the provider never let us make is not a selection defect", () => {
    // THE CASE THIS REASON EXISTS FOR, and the one the first version missed.
    //
    // A case expecting a tool call whose provider died has
    // `selection: failed / missingToolCall` written by the matcher before the
    // chain is derived. Re-labelling only BLANK rows left that standing, so
    // `firstFailedStage` stayed `selection` and the outage was filed as a
    // model-selection defect — the exact misattribution this whole reason was
    // built to remove, on the commonest shape in the corpus.
    const { stageResults, failureCategory, firstFailedStage } = derive({
      evidence: {
        prompts: [{ promptIndex: 0, missing: [{ toolName: "search" }] }],
        ...providerDied,
      },
    });

    const selection = stateOf(stageResults, "selection");
    expect(selection.state).toBe("notMeasured");
    expect(selection.reason).toBe("providerError");
    // The evidence went with the verdict it supported: a notMeasured row must
    // not still be arguing for a failure it no longer claims.
    expect(selection.evidence).toBeUndefined();
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBe("setup");
  });

  test("the reason speaks for its own stage, not for the run", () => {
    // Review finding on the label. `providerError` is applied PER ROW, so a
    // multi-turn iteration whose provider died late keeps its earlier measured
    // rows — and a run-level "the run never reached the server" would sit
    // directly beside a `call: passed` that disproves it.
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        ...providerDied,
      },
    });
    // The precondition that makes the label's scope matter: the server WAS
    // reached on this run.
    expect(stateOf(stageResults, "call").state).toBe("passed");
    expect(STAGE_REASON_LABELS.providerError).not.toContain(
      "never reached the server"
    );
    expect(STAGE_REASON_LABELS.providerError).toContain("this stage");
  });

  test("the chain does not argue with itself after a withdrawal", () => {
    // Review finding on the withdrawal itself. The positional cascade reads
    // `failed` rows to decide which later stages "never ran", so withdrawing
    // the failure AFTER it ran left `call`, `response` and `userValue` saying
    // `earlierStageFailed` while no stage failed and no firstFailedStage
    // existed — three rows citing a failure the chain no longer records.
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        prompts: [{ promptIndex: 0, missing: [{ toolName: "search" }] }],
        ...providerDied,
      },
    });

    expect(firstFailedStage).toBeUndefined();
    expect(stageResults.some((r) => r.state === "failed")).toBe(false);
    // Nothing may still be blaming a stage that is no longer failed.
    expect(stageResults.some((r) => r.reason === "earlierStageFailed")).toBe(
      false
    );
    // And the later stages say the true thing about why they are blank.
    for (const stage of ["call", "response", "userValue"] as const) {
      const r = stateOf(stageResults, stage);
      if (r.state === "notMeasured") expect(r.reason).toBe("providerError");
    }
  });

  test("a failure the provider did NOT explain still cascades", () => {
    // The other side. An unexpected call survives the withdrawal, so it stays
    // the first failed row and the stages after it still read `notReached` —
    // the cascade is repaired, not disabled.
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [
          {
            promptIndex: 0,
            unexpected: [{ toolName: "delete_all" }],
            passed: false,
          },
        ],
        ...providerDied,
      },
    });
    expect(firstFailedStage).toBe("selection");
    const after = stageResults.slice(
      stageResults.findIndex((r) => r.stage === "selection") + 1
    );
    expect(after.some((r) => r.state === "notReached")).toBe(true);
  });

  test("a call that really was made wrongly still counts against the server", () => {
    // The other side of that line, and the one that keeps this honest. An
    // UNEXPECTED call was actually observed — a presence, not an absence — so
    // a provider dying afterwards does not un-observe it. Withdrawing this too
    // would let any provider blip launder a genuine server defect.
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [
          {
            promptIndex: 0,
            unexpected: [{ toolName: "delete_all" }],
            passed: false,
          },
        ],
        ...providerDied,
      },
    });
    const selection = stateOf(stageResults, "selection");
    expect(selection.state).toBe("failed");
    expect(selection.reason).toBe("unexpectedToolCall");
  });

  test("a server that would not connect is never excused by a later outage", () => {
    // `connection` fails BEFORE any model call, so a provider error that came
    // afterwards cannot explain it. This is the failure mode that would be
    // most damaging to launder away.
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        setupSignals: {
          connection: {
            outcome: "failed",
            attribution: "theirs",
            egressVerified: true,
            spanIds: ["run-connect-s1"],
          },
        },
        ...providerDied,
      },
    });
    expect(stateOf(stageResults, "connection").state).toBe("failed");
    expect(firstFailedStage).toBe("connection");
  });

  test("a SETUP-layer error is not a provider error", () => {
    // Pre-turn setup never reached the model, and `setupAborted` already says
    // so precisely. Widening `providerError` over it would lose that.
    const { stageResults } = derive({
      evidence: { traceAbsent: true, stepError: { source: "setup" } },
    });
    expect(stageResults.every((r) => r.reason !== "providerError")).toBe(true);
  });

  test("an unclassified error changes nothing", () => {
    // Callers that cannot say which layer broke leave `stepError` absent, and
    // the chain reports exactly what it did before.
    const before = derive({ evidence: { traceAbsent: true } });
    expect(before.stageResults.every((r) => r.reason !== "providerError")).toBe(
      true
    );
    expect(before.failureCategory).toBeUndefined();
  });

  test("a broken grader still outranks it", () => {
    // `evaluator` is never folded into another category — a grader bug is not
    // an infrastructure outage, and counting it as one poisons both rates.
    const { failureCategory } = derive({
      evidence: {
        traceAbsent: true,
        evaluatorErrored: true,
        ...providerDied,
      },
    });
    expect(failureCategory).toBe("evaluator");
  });
});

// ── UVH-IN7: an observed tool error makes `response` measurable ──────────────
//
// The disagreement class this closes: a case authors only transcript
// predicates, so `call` and `response` were `notApplicable`; a tool errors on
// the server during the run; `failOnToolError` fails the legacy verdict. Every
// applicable stage green, the verdict red, and no row able to say why.

describe("an observed tool error reaches response, even unauthored", () => {
  /** Authors predicates only — nothing about tools at all. */
  const predicateOnlyCase = {
    mode: "model_driven" as const,
    expectsToolCall: false,
    assertionCount: 1,
  };

  const erroredToolSpan = () => ({
    ...toolSpan(),
    id: "span-err",
    status: "error",
  });

  test("a recovered tool error fails response as toolError / serverData", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      authored: predicateOnlyCase,
      evidence: {
        spans: [erroredToolSpan()],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });

    expect(stateOf(stageResults, "response")).toMatchObject({
      state: "failed",
      reason: "toolError",
    });
    expect(firstFailedStage).toBe("response");
    expect(failureCategory).toBe("serverData");
  });

  test("the chain no longer goes all-green while the verdict fails", () => {
    // The exact shape of the 8 prod trials: every stage the case authored
    // passed, so nothing in the chain contradicted a red verdict.
    const { stageResults } = derive({
      authored: predicateOnlyCase,
      evidence: {
        spans: [erroredToolSpan()],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(stageResults.some((r) => r.state === "failed")).toBe(true);
  });

  test("the chain reports the error even when POLICY passes the trial", () => {
    // The other half of the disagreement, and the one that shows why the
    // chain is not just a mirror of the verdict. With `failOnToolError: false`
    // the legacy verdict PASSES on the very run whose tool errored — so if the
    // chain also went all-green, a suite run entirely under that policy would
    // report a clean funnel over servers that were failing calls.
    //
    // Both halves are exercised against the SAME scenario rather than asserted
    // separately, because the property is the relationship between them: the
    // verdict answers "did policy fail this trial", the chain answers "what
    // happened", and those are allowed to differ.
    const erroredSpan = erroredToolSpan();

    const passed = finalizePassedForEval({
      matchPassed: true,
      trace: { spans: [erroredSpan] },
      failOnToolError: false,
      predicateResults: [{ passed: true }],
    });
    expect(passed).toBe(true);

    const { stageResults } = derive({
      authored: predicateOnlyCase,
      evidence: {
        spans: [erroredSpan],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(stateOf(stageResults, "response")).toMatchObject({
      state: "failed",
      reason: "toolError",
    });

    // And the control: the same span DOES fail the trial under the default
    // policy, so the test above is about the policy and not about a span that
    // was never failure-worthy.
    expect(
      finalizePassedForEval({
        matchPassed: true,
        trace: { spans: [erroredSpan] },
        predicateResults: [{ passed: true }],
      })
    ).toBe(false);
  });

  test("a transport-local error does NOT turn the stage on", () => {
    // A span carrying an MCP error code never reached the server's handler,
    // so it is a setup fact rather than the server's answer — and turning
    // `response` on for it would attribute our own failure to the server.
    const { stageResults } = derive({
      authored: predicateOnlyCase,
      evidence: {
        spans: [{ ...erroredToolSpan(), mcpErrorCode: -32601 }],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(stateOf(stageResults, "response").state).toBe("notApplicable");
  });

  test("no errored span leaves an unauthored response inapplicable", () => {
    // The floor is unchanged: a case that authors nothing about tools and saw
    // no tool failure still has nothing for `response` to decide.
    const { stageResults } = derive({
      authored: predicateOnlyCase,
      evidence: {
        spans: [toolSpan()],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(stateOf(stageResults, "response").state).toBe("notApplicable");
  });

  test("an authored case is unaffected — it was already applicable", () => {
    const { stageResults } = derive({
      evidence: {
        spans: [erroredToolSpan()],
        prompts: [cleanTurn],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(stateOf(stageResults, "response")).toMatchObject({
      state: "failed",
      reason: "toolError",
    });
  });
});

// ── UVH-IN1: tool-call predicates are SELECTION evidence ─────────────────────
//
// `stepsToPromptTurns` promotes only `toolCalledWith` into `expectedToolCalls`,
// so these three kinds arrive as predicate results and used to be graded as
// user value — the chain saying the user did not get what they asked for, when
// what happened is the model picked the wrong tool.

// =============================================================================
// The grader → stage map (B7).
//
// This map is what lets a settings page say "your suite measures selection and
// user value, and nothing checks the response" — a sentence no surface could
// form before, because the routing lived inside the analyzer. Exporting it
// creates exactly one hazard worth testing: a second copy that drifts.
//
// So the properties here are about AGREEMENT, not about any individual
// mapping. Which stage `noToolErrors` belongs to is a product judgement; that
// the map and the analyzer agree about it is a correctness property.
// =============================================================================
describe("the grader→stage map is total and agrees with the analyzer", () => {
  test("every predicate the schema admits has a stage", () => {
    // Derived from the schema rather than listed, so the next predicate
    // someone adds fails HERE rather than rendering as a stage that looks
    // unmeasured on a settings page.
    for (const kind of PREDICATE_KINDS) {
      expect(
        PREDICATE_STAGE[kind],
        `${kind} has no stage in PREDICATE_STAGE`
      ).toBeDefined();
      expect(USER_VALUE_STAGES).toContain(PREDICATE_STAGE[kind]);
    }
    expect(PREDICATE_KINDS.length).toBe(Object.keys(PREDICATE_STAGE).length);
  });

  test("the map names no predicate the schema does not", () => {
    // The other direction. An entry for a kind nobody can author is a row a
    // settings page would render for a grader that cannot exist.
    for (const kind of Object.keys(PREDICATE_STAGE)) {
      expect(PREDICATE_KINDS as readonly string[]).toContain(kind);
    }
  });

  test("a selection-routed predicate really does fail at selection", () => {
    // The agreement property, exercised through the analyzer rather than
    // asserted against the table: each kind the map calls `selection` is made
    // to fail, and the chain must file it there.
    //
    // `toolCalledWith` is excluded deliberately and is covered separately
    // below: it is matcher-graded, so it never arrives as a predicate row.
    const selectionKinds = (PREDICATE_KINDS as readonly string[]).filter(
      (kind) =>
        PREDICATE_STAGE[kind as keyof typeof PREDICATE_STAGE] === "selection" &&
        kind !== "toolCalledWith"
    );
    expect(selectionKinds.length).toBeGreaterThan(0);

    for (const kind of selectionKinds) {
      const { firstFailedStage } = derive({
        evidence: {
          spans: [toolSpan()],
          predicateResults: [
            {
              passed: false,
              reason: `${kind} says so`,
              predicate: { type: kind, toolName: "get_project" },
            },
          ],
        },
      });
      expect(firstFailedStage, `${kind} must file at its mapped stage`).toBe(
        PREDICATE_STAGE[kind as keyof typeof PREDICATE_STAGE]
      );
    }
  });

  test("toolCalledWith is mapped to selection but graded by the matcher", () => {
    // The one entry that is a claim about AUTHORING intent rather than about a
    // predicate row: `stepsToPromptTurns` promotes it into `expectedToolCalls`.
    // The map says so because an author who wrote it is measuring selection;
    // the analyzer must still route it through the matcher, and reading its
    // raw predicate row would let a residual contradict the adjudicated
    // verdict.
    expect(PREDICATE_STAGE.toolCalledWith).toBe("selection");
    expect(isSelectionPredicateKind("toolCalledWith")).toBe(false);
    expect(isSelectionStagePredicateKind("toolCalledWith")).toBe(true);
  });

  test("the analyzer's selection routing is a subset of the map", () => {
    // The invariant that makes the derivation safe: the analyzer may route
    // FEWER kinds than the map (the matcher case above), but never a kind the
    // map files somewhere else — that would be the silent disagreement this
    // whole step exists to make impossible.
    for (const kind of PREDICATE_KINDS) {
      if (!isSelectionPredicateKind(kind)) continue;
      expect(PREDICATE_STAGE[kind], `${kind} disagrees`).toBe("selection");
    }
  });

  test("non-predicate graders are placed too", () => {
    // A suite whose only user-value grader is the judge would otherwise render
    // as "nothing measures whether the person got what they wanted".
    expect(GRADER_STAGE["toolCalls:match"]).toBe("selection");
    expect(GRADER_STAGE["judge:goalCompletion"]).toBe("userValue");
  });

  test("presentation grouping carries no analytical weight", () => {
    // Budgets group together for reading, and are still filed where the
    // analyzer files them. If these two ever disagreed, a settings page would
    // be quietly redefining what a stage means.
    for (const kind of Object.keys(GRADER_PRESENTATION_GROUP)) {
      expect(PREDICATE_STAGE[kind as keyof typeof PREDICATE_STAGE]).toBe(
        "userValue"
      );
    }
  });

  test("the derivation routes exactly the three kinds it routed before", () => {
    // The refactor's own ratchet. `SELECTION_PREDICATE_REASONS` is now
    // COMPUTED from the map, so a mistake in the derivation would silently
    // widen or narrow what the analyzer routes — and the 93 behavioural tests
    // above would still pass if it only widened. Naming the set makes either
    // direction a failure.
    const routed = (PREDICATE_KINDS as readonly string[])
      .filter((kind) => isSelectionPredicateKind(kind))
      .sort();
    expect(routed).toEqual([
      "firstToolWas",
      "toolCalledAtLeastOnce",
      "toolNeverCalled",
    ]);
  });

  test("the analyzer version did not move", () => {
    // B7 is a REFACTOR of where the routing lives, not a change to it. A bump
    // here would mean historical failures are attributed differently, which is
    // a re-derivation, not a refactor.
    expect(STAGE_ANALYZER_VERSION).toBe(8);
  });
});

describe("tool-call predicates route to selection", () => {
  /** One predicate row, with the discriminator the producer now preserves. */
  const pred = (type: string, passed: boolean, reason = `${type} says so`) => ({
    passed,
    reason,
    predicate: { type, toolName: "get_project" },
  });

  /** No matcher evidence at all — the predicate is the only selection signal. */
  const predicateOnly = (rows: ReturnType<typeof pred>[]) =>
    derive({
      evidence: { spans: [toolSpan()], predicateResults: rows },
    });

  test.each([
    ["toolCalledAtLeastOnce", "missingToolCall"],
    ["firstToolWas", "unexpectedToolCall"],
    ["toolNeverCalled", "unexpectedToolCall"],
  ])("%s fails at selection with %s", (kind, reason) => {
    const { stageResults, firstFailedStage, failureCategory } = predicateOnly([
      pred(kind, false),
    ]);

    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "failed",
      reason,
      evidence: { predicateReasons: [`${kind} says so`] },
    });
    expect(firstFailedStage).toBe("selection");
    // The D7 metadata judge gates on exactly this, so routing here widens its
    // candidate population — intended, and named in the PR.
    expect(failureCategory).toBe("selection");
    // Routed, not copied: filing it in both places would double-count one
    // defect and make `firstFailedStage` depend on read order.
    expect(stateOf(stageResults, "userValue").reason).not.toBe(
      "predicateFailed"
    );
  });

  test.each(["toolCalledAtLeastOnce", "firstToolWas", "toolNeverCalled"])(
    "%s that PASSED is selection evidence, not silence",
    (kind) => {
      const { stageResults } = predicateOnly([pred(kind, true)]);
      expect(stateOf(stageResults, "selection")).toMatchObject({
        state: "passed",
        reason: "observed",
      });
    }
  );

  test("a missing required call outranks a forbidden one that fired", () => {
    // Both can fail at once. "The tool you needed was never called" is the
    // more specific and more actionable of the two.
    const { stageResults } = predicateOnly([
      pred("toolNeverCalled", false),
      pred("toolCalledAtLeastOnce", false),
    ]);
    expect(stateOf(stageResults, "selection").reason).toBe("missingToolCall");
  });

  test("a row with NO discriminator is still graded as user value", () => {
    // Backward compatibility, and the reason this bump changed no recorded
    // row in the parity corpus: producers that never carried the predicate —
    // and every row stored before UVH-IN1 — grade exactly as before.
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        predicateResults: [{ passed: false, reason: "no discriminator" }],
      },
    });
    expect(stateOf(stageResults, "userValue")).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
    });
  });

  test("toolCalledWith is deliberately left to the matcher", () => {
    // It is already promoted to `expectedToolCalls` and adjudicated there.
    // Re-reading its point-in-time predicate row here would let a raw residual
    // contradict the verdict the matcher path produced.
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        predicateResults: [pred("toolCalledWith", false)],
      },
    });
    expect(stateOf(stageResults, "selection").state).toBe("passed");
    expect(stateOf(stageResults, "userValue")).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
    });
  });

  test("MIXED: a matcher `missing` outranks a predicate failure", () => {
    // The matcher's verdict is the most specific signal about selection, and
    // it is fatal in every match mode.
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [
          {
            ...cleanTurn,
            missing: [{ toolName: "fetch_order" }],
            passed: false,
          },
        ],
        predicateResults: [pred("toolNeverCalled", false)],
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "failed",
      reason: "missingToolCall",
      evidence: { promptIndexes: [0] },
    });
  });

  test("MIXED: a predicate failure surfaces even when every turn passed", () => {
    // The conflicting case. The turn tolerated its extras, so the matcher path
    // would have reported `selection: passed` and the authored assertion would
    // have been filed as a user-value failure instead.
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        predicateResults: [pred("firstToolWas", false)],
      },
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "failed",
      reason: "unexpectedToolCall",
    });
    expect(firstFailedStage).toBe("selection");
  });

  test("user-value predicates still reach userValue alongside a routed one", () => {
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        predicateResults: [
          pred("toolNeverCalled", true),
          { passed: false, reason: "expected 'Refunded' on screen" },
        ],
      },
    });
    expect(stateOf(stageResults, "selection").state).toBe("passed");
    expect(stateOf(stageResults, "userValue")).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
      evidence: { predicateReasons: ["expected 'Refunded' on screen"] },
    });
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

  test("POSITION: a stage after the failure that measured NOTHING is notReached", () => {
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        spans: [],
        traceLacksSpanChannel: true,
        prompts: [
          { promptIndex: 0, missing: [{ toolName: "search" }], passed: false },
        ],
      },
    });
    expect(firstFailedStage).toBe("selection");
    // Nothing downstream produced a verdict of its own, so the chain breaking
    // upstream IS why we know nothing about them.
    expect(stateOf(stageResults, "call")).toMatchObject({
      state: "notReached",
      reason: "earlierStageFailed",
    });
    expect(stateOf(stageResults, "response").state).toBe("notReached");
    expect(stateOf(stageResults, "userValue").state).toBe("notReached");
    // Stages BEFORE the failure keep their own verdicts.
    expect(stateOf(stageResults, "connection").state).toBe("notMeasured");
  });

  /**
   * The other half of the same rule, and the reason it is narrow.
   *
   * A case whose `selection` failed on a stray call still made the expected
   * call and still ran its predicates. Overwriting those MEASURED rows with
   * "never ran" states something the run itself disproves, and throws away the
   * evidence an operator needs to see that the server was fine.
   * `firstFailedStage` already carries where the chain broke.
   */
  test("POSITION: a stage after the failure that WAS measured keeps its verdict", () => {
    const { stageResults, firstFailedStage } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [
          { promptIndex: 0, missing: [{ toolName: "search" }], passed: false },
        ],
        predicateResults: [{ passed: true, reason: "ok" }],
      },
    });
    expect(firstFailedStage).toBe("selection");
    expect(stateOf(stageResults, "call")).toMatchObject({
      state: "passed",
      reason: "observed",
    });
    expect(stateOf(stageResults, "response").state).toBe("passed");
    expect(stateOf(stageResults, "userValue").state).toBe("passed");
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

  test("no-signals failed+traceAbsent is byte-identical to v1 (modulo version)", () => {
    const {
      stageResults,
      firstFailedStage,
      failureCategory,
      stageAnalyzerVersion,
    } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceAbsent: true },
      iteration: { status: "failed", error: "server not connected" },
    });
    // v3 added judge evidence and v4 added metadata attribution; neither
    // changes the rows this fixture emits with no judge/attribution evidence
    // present, which are the v1/v2 rows unchanged — that is what this pins.
    expect(stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
    const applicable = stageResults.filter((r) => r.state !== "notApplicable");
    expect(
      applicable.map((r) => ({
        stage: r.stage,
        state: r.state,
        reason: r.reason,
      }))
    ).toEqual(
      applicable.map((r) => ({
        stage: r.stage,
        state: "notMeasured",
        reason: "setupAborted",
      }))
    );
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBe("setup");
  });

  test("failed+traceAbsent WITH signals measures the top two stages", () => {
    const { stageResults, firstFailedStage, failureCategory } =
      deriveStageResults({
        authored: modelDrivenCase,
        evidence: {
          traceAbsent: true,
          setupSignals: {
            connection: {
              outcome: "failed",
              attribution: "theirs",
              egressVerified: true,
              spanIds: ["run-connect-s1"],
            },
          },
        },
        iteration: { status: "failed", error: "connection refused" },
      });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "failed",
      reason: "connectFailed",
    });
    expect(stateOf(stageResults, "discovery")).toMatchObject({
      state: "notReached",
      reason: "earlierStageFailed",
    });
    expect(stateOf(stageResults, "selection")).toMatchObject({
      state: "notReached",
      reason: "earlierStageFailed",
    });
    expect(firstFailedStage).toBe("connection");
    expect(failureCategory).toBe("setup");
  });

  test("setup_failed WITH signals still names whose side refused", () => {
    const { stageResults, firstFailedStage, failureCategory } =
      deriveStageResults({
        authored: modelDrivenCase,
        evidence: {
          traceAbsent: true,
          setupSignals: {
            connection: {
              outcome: "failed",
              attribution: "theirs",
              egressVerified: true,
              spanIds: ["run-connect-s1"],
            },
          },
        },
        iteration: { status: "setup_failed", error: "connection refused" },
      });
    expect(stateOf(stageResults, "connection")).toMatchObject({
      state: "failed",
      reason: "connectFailed",
    });
    expect(firstFailedStage).toBe("connection");
    expect(failureCategory).toBe("setup");
  });

  test("setup_failed with no signals stays an unattributed abort", () => {
    const { stageResults, firstFailedStage } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceAbsent: true },
      iteration: { status: "setup_failed", error: "server not connected" },
    });
    const applicable = stageResults.filter((r) => r.state !== "notApplicable");
    expect(applicable.every((r) => r.reason === "setupAborted")).toBe(true);
    expect(firstFailedStage).toBeUndefined();
  });

  test("a `failed` row with no trace is read as a setup abort", () => {
    // An older writer spelled a setup abort `failed`; the shape, not the
    // status, is what identifies those rows.
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

// ── contracts a downstream aggregator has to know about ──────────────────────

describe("failureCategory without a failed stage", () => {
  /**
   * PINNED, because it decides how every rate built on this field must be
   * written. `failureCategory` answers "why is there no good outcome", NOT
   * "which stage failed" — a setup abort and an evaluator error are both real
   * answers with no failed row, and omitting the category would lose them. A
   * rate that wants only MEASURED server failures filters on
   * `firstFailedStage`, not on the presence of a category.
   */
  test("a setup abort carries `setup` with no firstFailedStage", () => {
    const { firstFailedStage, failureCategory } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: { traceAbsent: true },
      iteration: { status: "setup_failed" },
    });
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBe("setup");
  });

  test("a broken grader carries `evaluator` with no firstFailedStage", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        evaluatorErrored: true,
      },
    });
    expect(stateOf(stageResults, "userValue")).toMatchObject({
      state: "notMeasured",
      reason: "evaluatorError",
    });
    expect(firstFailedStage).toBeUndefined();
    expect(failureCategory).toBe("evaluator");
  });
});

describe("negative cases", () => {
  /**
   * `applicability` turns `call` on for a negative case because proving no
   * call happened IS the assertion. Reporting `notMeasured` when it holds
   * would call the case's central assertion unmeasured on every passing run —
   * the applicability rule and the derivation have to agree.
   */
  test("a negative case whose assertion HELD passes `call`", () => {
    const { stageResults, firstFailedStage } = deriveStageResults({
      authored: {
        mode: "model_driven",
        isNegativeTest: true,
        expectsToolCall: false,
        assertionCount: 1,
      },
      evidence: {
        spans: [],
        traceLacksSpanChannel: true,
        prompts: [cleanTurn],
        predicateResults: [{ passed: true, reason: "no call made" }],
      },
      iteration: { status: "completed" },
    });
    expect(stateOf(stageResults, "call")).toMatchObject({
      state: "passed",
      reason: "observed",
      evidence: { promptIndexes: [0] },
    });
    expect(firstFailedStage).toBeUndefined();
  });
});

describe("evidence is bounded at the producer", () => {
  /**
   * A predicate `reason` is a judge rationale — graded CONTENT of no fixed
   * length, already stored once under `metadata.predicates`. Copying it whole
   * into a second key doubles what the row retains and gives the redaction
   * contract a second place to reach.
   */
  test("predicate reasons are capped in count and in length", () => {
    const { stageResults } = derive({
      evidence: {
        spans: [toolSpan()],
        prompts: [cleanTurn],
        predicateResults: Array.from({ length: 9 }, (_, i) => ({
          passed: false,
          reason: `${i}`.repeat(4000),
        })),
      },
    });
    const reasons =
      stateOf(stageResults, "userValue").evidence?.predicateReasons ?? [];
    expect(reasons).toHaveLength(MAX_EVIDENCE_REASONS);
    for (const reason of reasons) {
      expect(reason.length).toBeLessThanOrEqual(MAX_EVIDENCE_REASON_CHARS);
    }
  });
});
