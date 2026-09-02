/**
 * Span provenance.
 *
 * The claim each stamped span makes has to be exactly as strong as what the
 * merge actually established — no stronger. The sharpest case is
 * `wireCorroborated: false`: on a complete turn it means "the proxy never saw
 * this call", and on an incomplete one it would mean "we could not look".
 * Those are different facts, and only one of them is evidence of a
 * hallucination.
 */
import { describe, expect, test } from "vitest";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { annotateSpansWithEvidence } from "../harness-evidence-spans";
import type { CanonicalMcpCall, MergeResult } from "../harness-evidence-merge";

function toolSpan(over: Partial<EvalTraceSpan> = {}): EvalTraceSpan {
  return {
    id: "span-1",
    name: "search",
    category: "tool",
    startMs: 0,
    endMs: 10,
    toolCallId: "toolu_1",
    toolName: "search",
    serverId: "server-1",
    ...over,
  } as EvalTraceSpan;
}

function call(requestId: string): CanonicalMcpCall {
  return {
    requestId,
    serverId: "server-1",
    toolName: "search",
    arguments: {},
    response: {},
    outcomeKind: "success",
    startedAtMs: 0,
    settledAtMs: 1,
  };
}

function mergeResult(over: Partial<MergeResult> = {}): MergeResult {
  return {
    completeness: { status: "complete" },
    canonicalCalls: [],
    matchedByToolCallId: new Map(),
    wireOnlyCalls: [],
    narrationOnlyToolCallIds: new Set(),
    ...over,
  };
}

describe("a matched call", () => {
  test("keeps its narrated output and gains corroboration plus the join key", () => {
    const [span] = annotateSpansWithEvidence(
      [toolSpan()],
      mergeResult({
        matchedByToolCallId: new Map([["toolu_1", call("req-1")]]),
      }),
    );

    expect(span).toMatchObject({
      // The model still saw the narrated output; the wire adds the raw result
      // behind it, not a different output.
      outputSource: "narration",
      wireCorroborated: true,
      evidenceRequestId: "req-1",
      evidenceStatus: "complete",
    });
  });
});

describe("a wire-only call", () => {
  test("is marked reconstructed and carries its request id", () => {
    const [span] = annotateSpansWithEvidence(
      [toolSpan({ id: "span-2", toolCallId: "evidence:req-9" })],
      mergeResult({ wireOnlyCalls: [call("req-9")] }),
    );

    expect(span).toMatchObject({
      outputSource: "reconstructed",
      wireCorroborated: true,
      evidenceRequestId: "req-9",
    });
  });
});

describe("a narration-only call", () => {
  test("on a COMPLETE turn is stated as uncorroborated", () => {
    // The hallucination signal, and the only place it is a fact.
    const [span] = annotateSpansWithEvidence(
      [toolSpan()],
      mergeResult({ narrationOnlyToolCallIds: new Set(["toolu_1"]) }),
    );

    expect(span).toMatchObject({
      outputSource: "narration",
      wireCorroborated: false,
      evidenceStatus: "complete",
    });
  });

  test("on an INCOMPLETE turn says nothing about corroboration", () => {
    // "We could not look" is not "it did not happen". Stating false here
    // would turn a recording failure into an accusation against the model.
    const [span] = annotateSpansWithEvidence(
      [toolSpan()],
      mergeResult({
        completeness: { status: "incomplete", reason: "unsettled_row" },
        narrationOnlyToolCallIds: new Set(["toolu_1"]),
      }),
    );

    expect(span.outputSource).toBe("narration");
    expect(span).not.toHaveProperty("wireCorroborated");
    expect(span.evidenceStatus).toBe("incomplete");
  });
});

describe("spans that make no MCP claim", () => {
  test("a native harness tool gets the turn status and no corroboration verdict", () => {
    // Bash never crosses the proxy, so "was it corroborated?" has no answer.
    const [span] = annotateSpansWithEvidence(
      [
        toolSpan({
          toolCallId: "bash-1",
          toolName: "Bash",
          serverId: undefined,
        }),
      ],
      mergeResult(),
    );

    expect(span).not.toHaveProperty("wireCorroborated");
    expect(span).not.toHaveProperty("outputSource");
    expect(span.evidenceStatus).toBe("complete");
  });

  test("llm and step spans are left entirely alone", () => {
    // Stamping them would say something about a call they do not describe.
    const spans = annotateSpansWithEvidence(
      [
        { id: "s1", name: "LLM", category: "llm", startMs: 0, endMs: 1 },
        { id: "s2", name: "step", category: "step", startMs: 0, endMs: 1 },
      ] as EvalTraceSpan[],
      mergeResult(),
    );

    for (const span of spans) {
      expect(span).not.toHaveProperty("evidenceStatus");
      expect(span).not.toHaveProperty("outputSource");
    }
  });
});

describe("the input spans", () => {
  test("are not mutated", () => {
    // The accumulator holds these; editing in place would rewrite history that
    // has already been read.
    const original = toolSpan();
    annotateSpansWithEvidence(
      [original],
      mergeResult({
        matchedByToolCallId: new Map([["toolu_1", call("req-1")]]),
      }),
    );

    expect(original).not.toHaveProperty("evidenceRequestId");
  });
});
