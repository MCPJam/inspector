import { describe, expect, test } from "vitest";
import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { StageAuthoredCase, StageResultRow } from "@mcpjam/sdk/contract";
import {
  buildIterationFinishParams,
  buildStageMetadata,
} from "../finalize-iteration.js";

// =============================================================================
// `buildIterationFinishParams` is where the derived user-value chain joins the
// persisted metadata. The cases below pin the two things that decide whether
// the chain says anything true: that it is ABSENT when the caller cannot say
// what the case authored, and that every evidence channel the runner holds
// actually reaches the analyzer rather than being dropped on the way.
// =============================================================================

const usageZero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
const evaluation = {
  toolsCalled: [],
  turnCount: 1,
  failedTurnCount: 0,
  missing: [],
  unexpected: [],
  argumentMismatches: [],
};

const authoredCase: StageAuthoredCase = {
  mode: "model_driven",
  expectsToolCall: true,
  assertionCount: 1,
};

const okToolSpan = {
  id: "s1",
  name: "tool.list_files",
  category: "tool",
  startMs: 0,
  endMs: 5,
  status: "ok",
  toolName: "list_files",
} as unknown as EvalTraceSpan;

function build(over: Record<string, unknown> = {}) {
  return buildIterationFinishParams({
    iterationId: "iter1",
    passed: true,
    evaluation,
    usage: usageZero,
    messages,
    status: "completed",
    startedAt: 0,
    iterationMetadataBase: {},
    ...over,
  } as Parameters<typeof buildIterationFinishParams>[0]);
}

const rowsOf = (params: ReturnType<typeof build>) =>
  (params.metadata as Record<string, unknown>).stageResults as StageResultRow[];

const stage = (params: ReturnType<typeof build>, name: string) =>
  rowsOf(params).find((r) => r.stage === name)!;

describe("buildIterationFinishParams — stage derivation", () => {
  test("writes NO stage keys when the caller supplies no authored case", () => {
    // Without the authored case there is no way to tell `notApplicable` from
    // `notMeasured`, so writing a chain anyway would report stages the case
    // never exercised as evidence gaps.
    const metadata = build({ spans: [okToolSpan] }).metadata as Record<
      string,
      unknown
    >;
    expect(metadata.stageResults).toBeUndefined();
    expect(metadata.firstFailedStage).toBeUndefined();
    expect(metadata.failureCategory).toBeUndefined();
    expect(metadata.stageAnalyzerVersion).toBeUndefined();
  });

  test("writes a full chain when the authored case is supplied", () => {
    const params = build({ stageCase: authoredCase, spans: [okToolSpan] });
    const metadata = params.metadata as Record<string, unknown>;
    expect(metadata.stageAnalyzerVersion).toBe(2);
    expect(rowsOf(params)).toHaveLength(6);
    expect(stage(params, "call").state).toBe("passed");
  });

  test("a pinned tool error reaches the chain even with no spans", () => {
    // A pinned (model-free) tool call's failure never enters the trace — the
    // same blind spot `buildEvalIterationVerdict` compensates for explicitly.
    // Without `stageToolErrors` the chain would report `call` as unmeasured
    // for an iteration whose tool call demonstrably failed.
    const params = build({
      stageCase: authoredCase,
      status: "failed",
      stageToolErrors: [{ kind: "protocol-error", toolName: "list_files" }],
    });
    expect(stage(params, "call")).toMatchObject({
      state: "failed",
      reason: "protocolError",
    });
    expect((params.metadata as Record<string, unknown>).firstFailedStage).toBe(
      "call"
    );
  });

  test("a content error is attributed to `response`, not `call`", () => {
    const params = build({
      stageCase: authoredCase,
      spans: [okToolSpan],
      stageToolErrors: [{ kind: "content-error", toolName: "list_files" }],
    });
    expect(stage(params, "call").state).toBe("passed");
    expect(stage(params, "response")).toMatchObject({
      state: "failed",
      reason: "toolError",
    });
  });

  test("a failed iteration that captured nothing degrades to a setup abort", () => {
    const params = build({
      stageCase: authoredCase,
      status: "failed",
      error: "server not connected",
      messages: [],
    });
    const applicable = rowsOf(params).filter(
      (r) => r.state !== "notApplicable"
    );
    expect(applicable.every((r) => r.state === "notMeasured")).toBe(true);
    expect(applicable.every((r) => r.reason === "setupAborted")).toBe(true);
    expect((params.metadata as Record<string, unknown>).failureCategory).toBe(
      "setup"
    );
  });

  test("messages without spans are read as a span-less executor, not silence", () => {
    const params = build({ stageCase: authoredCase });
    expect(stage(params, "call")).toMatchObject({
      state: "notMeasured",
      reason: "executorEmitsNoSpans",
    });
  });

  test("stage keys sit alongside stepResults without clobbering them", () => {
    const params = build({
      stageCase: authoredCase,
      spans: [okToolSpan],
      stepResults: [
        { stepId: "s1", stepIndex: 0, kind: "prompt", status: "ok" },
      ],
    });
    const metadata = params.metadata as Record<string, unknown>;
    expect(metadata.stepResults).toHaveLength(1);
    expect(metadata.stageResults).toHaveLength(6);
  });

  test("policy blocks are metadata, not failures, and block stage measurement", () => {
    const params = build({
      stageCase: authoredCase,
      policyBlocks: [
        {
          toolName: "write_file",
          reason: "destructiveDefaultDeny",
          classification: "destructive",
          at: 123,
        },
      ],
    });
    const metadata = params.metadata as Record<string, any>;
    expect(metadata.policyBlockCount).toBe(1);
    expect(metadata.policyBlocks).toHaveLength(1);
    expect(metadata.failureCategory).toBeUndefined();
    expect(metadata.firstFailedStage).toBeUndefined();
    const applicable = rowsOf(params).filter(
      (row) => row.state !== "notApplicable"
    );
    expect(applicable.every((row) => row.state === "notMeasured")).toBe(true);
    expect(applicable.every((row) => row.reason === "blockedByPolicy")).toBe(
      true
    );
  });
});

describe("buildStageMetadata — the seam a setup abort finalizes through", () => {
  // `persistSetupFailedIteration` writes its own minimal iteration row for a
  // case that threw before the prompt loop started, so it never reaches
  // `buildIterationFinishParams`. These pin what that path now reports.

  test("no authored case ⇒ no stage keys at all", () => {
    expect(buildStageMetadata({ status: "failed", error: "boom" })).toEqual({});
  });

  test("an authored case that captured nothing reports a setup abort", () => {
    const metadata = buildStageMetadata({
      stageCase: authoredCase,
      status: "failed",
      error: "prepareChatV2 rejected the tool set",
    });
    const rows = metadata.stageResults as StageResultRow[];
    expect(rows).toHaveLength(6);
    const applicable = rows.filter((r) => r.state !== "notApplicable");
    expect(applicable.every((r) => r.state === "notMeasured")).toBe(true);
    expect(applicable.every((r) => r.reason === "setupAborted")).toBe(true);
    expect(metadata.failureCategory).toBe("setup");
    expect(metadata.stageAnalyzerVersion).toBe(2);
    // Never a fabricated failure: nothing was measured, so nothing "failed".
    expect(metadata.firstFailedStage).toBeUndefined();
  });

  test("both callers derive identically for the same inputs", () => {
    // The whole reason the helper is shared: a setup abort persisted through
    // the minimal row must read the same as one persisted through the full
    // finish-params path.
    const viaHelper = buildStageMetadata({
      stageCase: authoredCase,
      status: "failed",
      error: "server not connected",
      messages: [],
    });
    const viaFinishParams = build({
      stageCase: authoredCase,
      status: "failed",
      error: "server not connected",
      messages: [],
    }).metadata as Record<string, unknown>;
    expect(viaHelper.stageResults).toEqual(viaFinishParams.stageResults);
    expect(viaHelper.failureCategory).toBe(viaFinishParams.failureCategory);
  });

  test("synthetic setup spans persist on the trace and stay out of evidence", () => {
    const setupSpan = {
      id: "run-connect-s1",
      name: "connect",
      category: "connection",
      startMs: 0,
      endMs: 12,
      status: "error",
      serverId: "s1",
    } as unknown as EvalTraceSpan;
    const params = build({
      stageCase: authoredCase,
      status: "failed",
      error: "connection refused",
      messages: [],
      setupSpans: [setupSpan],
      setupSignals: {
        connection: {
          outcome: "failed",
          attribution: "theirs",
          egressVerified: true,
          spanIds: ["run-connect-s1"],
        },
      },
    });
    expect(params.spans).toEqual([setupSpan]);
    expect(stage(params, "connection")).toMatchObject({
      state: "failed",
      reason: "connectFailed",
      evidence: { spanIds: ["run-connect-s1"] },
    });
    // The analyzer's `traceAbsent` fallback still fired — synthetic spans
    // never entered evidence — so later stages stay notReached, not implied.
    expect(stage(params, "selection")).toMatchObject({
      state: "notReached",
      reason: "earlierStageFailed",
    });
  });
});
