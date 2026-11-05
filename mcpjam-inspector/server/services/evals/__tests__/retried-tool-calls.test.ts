import { describe, expect, it } from "vitest";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { buildEvalIterationVerdict } from "../iteration-verdict.js";
import { evaluateMultiTurnResults, type ToolCall } from "../types.js";

// The F06 shape: the first export timed out, the model made the same call
// again and it worked, then it shared. The harness records the timeout as an
// errored tool span on that call's id.
const exportCall = (toolCallId: string) => ({
  toolName: "export_scene",
  arguments: { sceneId: "s1", format: "png" },
  toolCallId,
});
const shareCall = {
  toolName: "share_scene",
  arguments: { sceneId: "s1" },
  toolCallId: "call-3",
};
const timedOutExport = {
  messages: [],
  spans: [
    {
      id: "span-1",
      name: "export_scene",
      category: "tool" as const,
      startMs: 0,
      endMs: 30_000,
      status: "error" as const,
      toolCallId: "call-1",
    },
  ],
};

const turn = {
  id: "turn-1",
  prompt: "Export the scene and share it",
  expectedToolCalls: [
    { toolName: "export_scene", arguments: { sceneId: "s1" } },
    { toolName: "share_scene", arguments: { sceneId: "s1" } },
  ],
};

function verdict(
  matchOptions: EvalMatchOptions,
  calls: ToolCall[],
  failOnToolError = false,
) {
  return buildEvalIterationVerdict({
    promptTurns: [turn],
    toolsCalledByPrompt: [calls],
    isNegativeTest: false,
    matchOptions,
    turnCheckResults: [],
    effectivePredicates: undefined,
    trace: timedOutExport,
    usage: undefined,
    renderObservations: undefined,
    iterationError: undefined,
    failOnToolError,
    pinnedToolErrors: [],
    scriptedCheckFailures: [],
  });
}

describe("a failed call followed by the same call", () => {
  const retried = [exportCall("call-1"), exportCall("call-2"), shareCall];

  it.each([
    ["strict order", { toolCallOrder: "strict" } as const],
    ["zero extra calls", { maxExtraToolCalls: 0 }],
  ])("passes under %s and records the retry on the turn", (_, options) => {
    const { evaluation, passed } = verdict(options, retried);
    expect(passed).toBe(true);
    expect(evaluation.unexpected).toEqual([]);
    expect(evaluation.promptSummaries[0]!.retries).toEqual([
      {
        toolName: "export_scene",
        arguments: { sceneId: "s1", format: "png" },
        actualIndex: 0,
        retriedByIndex: 1,
      },
    ]);
  });

  it.each([
    ["strict order", { toolCallOrder: "strict" } as const],
    ["zero extra calls", { maxExtraToolCalls: 0 }],
  ])("still fails two successful identical calls under %s", (_, options) => {
    const { evaluation, passed } = verdict(options, [
      exportCall("call-4"),
      exportCall("call-5"),
      shareCall,
    ]);
    expect(passed).toBe(false);
    expect(evaluation.promptSummaries[0]!.retries).toBeUndefined();
  });

  it("never lets the failure mark reach a persisted call list", () => {
    const evaluation = evaluateMultiTurnResults(
      [{ ...turn, expectedToolCalls: [turn.expectedToolCalls[1]!] }],
      [[exportCall("call-1"), shareCall]],
      false,
      { maxExtraToolCalls: 0 },
      { toolErrors: [{ toolCallId: "call-1" }] },
    );
    // Not retried, so the failed export is an extra — reported as the
    // caller's own object, without the matcher's `failed` mark.
    expect(evaluation.passed).toBe(false);
    expect(evaluation.unexpected).toEqual([exportCall("call-1")]);
    expect(evaluation.toolsCalled).toEqual([exportCall("call-1"), shareCall]);
  });

  it("leaves the tool-error gate to fail the iteration when it is on", () => {
    const { evaluation, passed } = verdict(
      { maxExtraToolCalls: 0 },
      retried,
      true,
    );
    expect(evaluation.passed).toBe(true);
    expect(passed).toBe(false);
  });

  it("does not count a retried failure against a turn that expects no calls", () => {
    const evaluation = evaluateMultiTurnResults(
      [{ id: "turn-1", prompt: "Look around", expectedToolCalls: [] }],
      [[exportCall("call-1"), exportCall("call-2")]],
      false,
      { maxExtraToolCalls: 1 },
      { toolErrors: [{ toolCallId: "call-1" }] },
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.retries).toHaveLength(1);
  });
});
