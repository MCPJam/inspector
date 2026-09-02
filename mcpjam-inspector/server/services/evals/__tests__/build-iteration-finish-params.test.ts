import { describe, expect, test } from "vitest";
import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { StageAuthoredCase, StageResultRow } from "@mcpjam/sdk/contract";
import { STAGE_ANALYZER_VERSION } from "@mcpjam/sdk/contract";
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
    expect(metadata.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
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

  test("the effective tool policy is snapshotted so a replay can recover it", () => {
    // The run row cannot carry the policy yet (backend field is Lane B), and a
    // replay re-dials the ORIGINAL servers with the ORIGINAL credentials — so
    // this snapshot is the only thing standing between a replay and executing
    // for real the calls the source run blocked.
    const params = build({
      stageCase: authoredCase,
      toolPolicy: { mode: "readOnly", deny: ["write_file"] },
    });
    const metadata = params.metadata as Record<string, any>;
    expect(metadata.toolPolicy).toEqual({
      mode: "readOnly",
      deny: ["write_file"],
    });
  });

  test("no policy means no snapshot key at all", () => {
    const params = build({ stageCase: authoredCase });
    expect(
      Object.hasOwn(params.metadata as Record<string, unknown>, "toolPolicy")
    ).toBe(false);
  });

  test("an independent stage tool error retains ordinary failure attribution", () => {
    const params = build({
      stageCase: authoredCase,
      status: "failed",
      stageToolErrors: [{ kind: "protocol-error", toolName: "write_file" }],
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
    expect(metadata.stageResults).toBeDefined();
    expect(metadata.failureCategory).toBe("serverData");
    expect(metadata.firstFailedStage).toBe("call");
    expect(
      (metadata.stageResults as StageResultRow[]).some(
        (row) => row.state === "failed" && row.reason === "protocolError"
      )
    ).toBe(true);
  });
});

describe("buildIterationFinishParams — selectionToolCatalog (D7)", () => {
  const selectionTools = {
    get_weather: {
      description: "Look up the current weather for a city.",
      inputSchema: { jsonSchema: { type: "object", properties: { city: {} } } },
    },
    delete_all_files: {
      description: "Deletes every file on the sandbox filesystem.",
    },
  };

  test("is written when selection failed and the live tool set is supplied", () => {
    const params = build({
      stageCase: authoredCase,
      gradingMode: "dual_write",
      prompts: [
        {
          promptIndex: 0,
          expectedToolCalls: [{ toolName: "get_weather" }],
          actualToolCalls: [{ toolName: "delete_all_files" }],
          missing: [{ toolName: "get_weather" }],
          unexpected: [],
          argumentMismatches: [],
          passed: false,
        },
      ],
      selectionTools,
    });
    const metadata = params.metadata as Record<string, unknown>;
    expect(stage(params, "selection")).toMatchObject({
      state: "failed",
      reason: "missingToolCall",
    });
    // Both the expected tool AND the tool the model called INSTEAD are
    // captured — under the default `maxExtraToolCalls: null`, a call made
    // in place of (not in addition to) an expected one never lands in
    // `unexpected`, so the catalog has to read the full `actualToolCalls`
    // set to see what the model actually picked.
    expect(metadata.selectionToolCatalog).toEqual([
      {
        name: "get_weather",
        role: "expected",
        description: "Look up the current weather for a city.",
        inputSchemaSummary: JSON.stringify({
          type: "object",
          properties: { city: {} },
        }),
      },
      {
        name: "delete_all_files",
        role: "actual",
        description: "Deletes every file on the sandbox filesystem.",
      },
    ]);
  });

  test("is absent when selection did not fail, even with tools supplied", () => {
    const params = build({
      stageCase: authoredCase,
      gradingMode: "dual_write",
      spans: [okToolSpan],
      selectionTools,
    });
    expect(stage(params, "selection").state).not.toBe("failed");
    expect(
      Object.hasOwn(
        params.metadata as Record<string, unknown>,
        "selectionToolCatalog"
      )
    ).toBe(false);
  });

  test("is absent when no live tool set is supplied, even on a selection failure", () => {
    const params = build({
      stageCase: authoredCase,
      gradingMode: "dual_write",
      prompts: [
        {
          promptIndex: 0,
          missing: [{ toolName: "get_weather" }],
          unexpected: [],
          argumentMismatches: [],
          passed: false,
        },
      ],
    });
    expect(stage(params, "selection").state).toBe("failed");
    expect(
      Object.hasOwn(
        params.metadata as Record<string, unknown>,
        "selectionToolCatalog"
      )
    ).toBe(false);
  });

  test("is absent outside dual_write, even on a selection failure with tools supplied", () => {
    const params = build({
      stageCase: authoredCase,
      prompts: [
        {
          promptIndex: 0,
          missing: [{ toolName: "get_weather" }],
          unexpected: [],
          argumentMismatches: [],
          passed: false,
        },
      ],
      selectionTools,
    });
    expect(stage(params, "selection").state).toBe("failed");
    expect(
      Object.hasOwn(
        params.metadata as Record<string, unknown>,
        "selectionToolCatalog"
      )
    ).toBe(false);
  });

  test("captures both roles for an unexpectedToolCall failure, deduped", () => {
    const params = build({
      stageCase: authoredCase,
      gradingMode: "dual_write",
      prompts: [
        {
          promptIndex: 0,
          missing: [],
          actualToolCalls: [
            { toolName: "delete_all_files" },
            { toolName: "delete_all_files" },
          ],
          unexpected: [
            { toolName: "delete_all_files" },
            { toolName: "delete_all_files" },
          ],
          argumentMismatches: [],
          passed: false,
        },
      ],
      selectionTools,
    });
    const metadata = params.metadata as Record<string, unknown>;
    expect(stage(params, "selection")).toMatchObject({
      state: "failed",
      reason: "unexpectedToolCall",
    });
    expect(metadata.selectionToolCatalog).toEqual([
      {
        name: "delete_all_files",
        role: "actual",
        description: "Deletes every file on the sandbox filesystem.",
      },
    ]);
  });

  test("an earlier successful turn's tool calls never enter the catalog, even under the cap", () => {
    // Turn 0 succeeds (calls a tool cleanly); turn 1 is the actual selection
    // failure. Only turn 1's actual/expected names should ever be catalogued
    // — turn 0's successful call has nothing to do with why selection failed.
    const params = build({
      stageCase: authoredCase,
      gradingMode: "dual_write",
      prompts: [
        {
          promptIndex: 0,
          missing: [],
          unexpected: [],
          actualToolCalls: [{ toolName: "list_files" }],
          argumentMismatches: [],
          passed: true,
        },
        {
          promptIndex: 1,
          missing: [{ toolName: "get_weather" }],
          unexpected: [],
          actualToolCalls: [{ toolName: "delete_all_files" }],
          argumentMismatches: [],
          passed: false,
        },
      ],
      selectionTools: {
        ...selectionTools,
        list_files: { description: "an unrelated, successfully-called tool" },
      },
    });
    const metadata = params.metadata as Record<string, unknown>;
    expect(stage(params, "selection")).toMatchObject({
      state: "failed",
      reason: "missingToolCall",
    });
    const names = (
      metadata.selectionToolCatalog as Array<{ name: string }>
    ).map((e) => e.name);
    expect(names).not.toContain("list_files");
    expect(names).toEqual(
      expect.arrayContaining(["get_weather", "delete_all_files"])
    );
  });

  test("an unexpected tool is never crowded out of the cap by correctly-called expected tools", () => {
    // maxExtraToolCalls: 0 style failure — six tools called correctly
    // (nothing missing) plus one prohibited extra, with the prohibited call
    // LAST in call order. The cap (6) must not fill entirely on the
    // correctly-called tools before the one that actually caused
    // unexpectedToolCall is ever considered.
    const correctlyCalledNames = Array.from(
      { length: 6 },
      (_, i) => `expected_ok_${i}`
    );
    const params = build({
      stageCase: authoredCase,
      gradingMode: "dual_write",
      prompts: [
        {
          promptIndex: 0,
          missing: [],
          unexpected: [{ toolName: "prohibited_tool" }],
          actualToolCalls: [
            ...correctlyCalledNames.map((toolName) => ({ toolName })),
            { toolName: "prohibited_tool" },
          ],
          argumentMismatches: [],
          passed: false,
        },
      ],
      selectionTools: {
        ...Object.fromEntries(correctlyCalledNames.map((n) => [n, {}])),
        prohibited_tool: { description: "the tool that caused the failure" },
      },
    });
    const metadata = params.metadata as Record<string, unknown>;
    expect(stage(params, "selection")).toMatchObject({
      state: "failed",
      reason: "unexpectedToolCall",
    });
    const names = (
      metadata.selectionToolCatalog as Array<{ name: string }>
    ).map((e) => e.name);
    expect(names).toContain("prohibited_tool");
  });
});

describe("buildStageMetadata — the seam a setup abort finalizes through", () => {
  // `persistSetupFailedIteration` writes its own minimal iteration row for a
  // case that threw before the prompt loop started, so it never reaches
  // `buildIterationFinishParams`. These pin what that path now reports.

  test("no authored case ⇒ no stage keys at all", () => {
    expect(buildStageMetadata({ status: "failed", error: "boom" })).toEqual({});
  });

  test("records the model-layer classification beside the chain it produced", () => {
    // The WRITE half of the persisted attribution. Without it the judge second
    // pass has to infer the classification from the chain, and the chain does
    // not always carry it: a model-call failure where nothing failed gets a
    // `setup` category with no row relabelled.
    //
    // Asserted here rather than only where it is read, because a test that
    // hands the reader a hand-built metadata bag passes whether or not this
    // function ever writes one.
    const metadata = buildStageMetadata({
      stageCase: authoredCase,
      status: "failed",
      error: "provider outage",
      stepError: { source: "model" },
    });
    expect(metadata.stageStepErrorSource).toBe("model");
  });

  test("writes no classification marker when the failure was not the model's", () => {
    // `setup` is our own layer and needs no marker: it changes no derivation
    // the second pass would otherwise get wrong, and writing it would invite a
    // reader to treat the absence of a marker as meaningful.
    expect(
      buildStageMetadata({
        stageCase: authoredCase,
        status: "failed",
        error: "our own preparation broke",
        stepError: { source: "setup" },
      }).stageStepErrorSource,
    ).toBeUndefined();
    expect(
      buildStageMetadata({
        stageCase: authoredCase,
        status: "completed",
      }).stageStepErrorSource,
    ).toBeUndefined();
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
    expect(metadata.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
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
