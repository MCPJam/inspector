import { describe, it, expect } from "vitest";
import {
  extractToolErrors,
  finalizePassedForEval,
} from "../src/eval-tool-execution";
import { buildIterationTranscript } from "../src/predicates/transcript";

function toolResult(part: Record<string, unknown>) {
  return { role: "tool", content: [{ type: "tool-result", ...part }] };
}

describe("extractToolErrors — classification", () => {
  it("classifies MCP isError:true as content-error", () => {
    const trace = {
      messages: [toolResult({ toolName: "book", result: { isError: true } })],
    };
    expect(extractToolErrors(trace)).toEqual([
      { kind: "content-error", toolName: "book" },
    ]);
  });

  it("classifies an AI SDK error field as protocol-error", () => {
    const trace = {
      messages: [toolResult({ toolName: "book", error: "connection reset" })],
    };
    expect(extractToolErrors(trace)).toEqual([
      { kind: "protocol-error", toolName: "book" },
    ]);
  });

  it("classifies an error-text output as protocol-error", () => {
    const trace = {
      messages: [toolResult({ toolName: "s", output: { type: "error-text" } })],
    };
    expect(extractToolErrors(trace)).toEqual([
      { kind: "protocol-error", toolName: "s" },
    ]);
  });

  it("classifies an errored tool span as protocol-error", () => {
    const trace = {
      messages: [],
      spans: [{ category: "tool", status: "error", name: "search" }],
    };
    expect(extractToolErrors(trace as never)).toEqual([
      { kind: "protocol-error", toolName: "search" },
    ]);
  });

  it("returns [] for a clean trace and for absent traces", () => {
    expect(
      extractToolErrors({ messages: [toolResult({ toolName: "ok", result: { isError: false } })] }),
    ).toEqual([]);
    expect(extractToolErrors(undefined)).toEqual([]);
  });
});

describe("buildIterationTranscript", () => {
  it("assembles toolCalls, toolErrors, final message, and usage", () => {
    const transcript = buildIterationTranscript({
      trace: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "all done" }] },
        ],
      },
      toolCalls: [{ toolName: "search", arguments: { q: "x" } }],
      usage: { totalTokens: 42 },
    });
    expect(transcript.toolCalls).toEqual([
      { toolName: "search", arguments: { q: "x" } },
    ]);
    expect(transcript.toolErrors).toEqual([]);
    expect(transcript.finalAssistantMessage).toBe("all done");
    expect(transcript.usage).toEqual({ totalTokens: 42 });
  });

  it("surfaces classified tool errors from the trace", () => {
    const transcript = buildIterationTranscript({
      trace: {
        messages: [toolResult({ toolName: "book", result: { isError: true } })],
      },
      toolCalls: [{ toolName: "book", arguments: {} }],
    });
    expect(transcript.toolErrors).toEqual([
      { kind: "content-error", toolName: "book" },
    ]);
  });
});

describe("finalizePassedForEval — predicate AND-combine", () => {
  it("passes through when all predicates pass", () => {
    expect(
      finalizePassedForEval({
        matchPassed: true,
        predicateResults: [{ passed: true }, { passed: true }],
      }),
    ).toBe(true);
  });

  it("fails when any predicate fails", () => {
    expect(
      finalizePassedForEval({
        matchPassed: true,
        predicateResults: [{ passed: true }, { passed: false }],
      }),
    ).toBe(false);
  });

  it("predicate failure fails the case even with tool-error gating off", () => {
    expect(
      finalizePassedForEval({
        matchPassed: true,
        failOnToolError: false,
        predicateResults: [{ passed: false }],
      }),
    ).toBe(false);
  });

  it("a passing predicate set does not rescue a match failure", () => {
    expect(
      finalizePassedForEval({
        matchPassed: false,
        predicateResults: [{ passed: true }],
      }),
    ).toBe(false);
  });

  it("is unchanged when no predicates are supplied (back-compat)", () => {
    expect(finalizePassedForEval({ matchPassed: true })).toBe(true);
    expect(finalizePassedForEval({ matchPassed: false })).toBe(false);
  });
});
