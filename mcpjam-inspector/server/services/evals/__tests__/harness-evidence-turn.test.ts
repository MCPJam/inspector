/**
 * The per-turn evidence pass.
 *
 * Two failure modes are being guarded, and they pull in opposite directions.
 * One is doing nothing when capture is on — the run executes perfectly and
 * records nothing. The other is doing something when capture is OFF, which
 * would make a fully-off run stop being byte-identical to a pre-evidence one
 * and quietly cost every playground turn a network round trip.
 */
import { describe, expect, test, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  collectNarratedCalls,
  reconcileTurnEvidence,
  sawEvidenceUnavailableMarker,
} from "../harness-evidence-turn";
import type { EvidenceReadTransport } from "../../../utils/harness/harness-evidence-reader";

const toolSpan = (over: Partial<EvalTraceSpan> = {}): EvalTraceSpan =>
  ({
    id: "span-1",
    name: "search",
    category: "tool",
    startMs: 0,
    endMs: 5,
    toolCallId: "toolu_1",
    toolName: "search",
    serverId: "server-1",
    ...over,
  }) as EvalTraceSpan;

const assistantCall = (
  toolCallId: string,
  toolName: string,
  args: unknown,
): ModelMessage =>
  ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input: args }],
  }) as unknown as ModelMessage;

const evidenceRow = (over: Record<string, unknown> = {}) => ({
  requestId: "req-1",
  turnId: "turn_1",
  serverId: "server-1",
  toolName: "search",
  argumentsJson: JSON.stringify({ q: "x" }),
  status: "settled",
  outcomeKind: "success",
  responseJson: JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
  startedAtMs: 1,
  settledAtMs: 2,
  payloadsReadable: true,
  ...over,
});

function transportReturning(
  rows: Array<Record<string, unknown>>,
): EvidenceReadTransport {
  return async () => ({
    status: 200,
    body: { ok: true, rows, isDone: true, cursor: null },
  });
}

const armed = {
  iterationId: "iter_1",
  turnId: "turn_1",
  captureEnabled: true,
};

describe("when capture is off", () => {
  test("reads nothing and returns the spans untouched", async () => {
    const transport = vi.fn<EvidenceReadTransport>();
    const spans = [toolSpan()];

    const result = await reconcileTurnEvidence({
      captureEnabled: false,
      iterationId: "iter_1",
      turnId: "turn_1",
      spans,
      newMessages: [assistantCall("toolu_1", "search", { q: "x" })],
      transport,
    });

    expect(transport).not.toHaveBeenCalled();
    expect(result.spans).toEqual(spans);
    expect(result.completeness).toBeUndefined();
    expect(result.traceMessages).toBeUndefined();
  });

  test("stays inert when there is no iteration or turn to record against", async () => {
    const transport = vi.fn<EvidenceReadTransport>();

    for (const scope of [
      { captureEnabled: true, turnId: "turn_1" },
      { captureEnabled: true, iterationId: "iter_1" },
    ]) {
      const result = await reconcileTurnEvidence({
        ...scope,
        spans: [toolSpan()],
        newMessages: [],
        transport,
      });
      expect(result.completeness).toBeUndefined();
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("when capture is on", () => {
  test("annotates a matched call and leaves the transcript alone", async () => {
    const result = await reconcileTurnEvidence({
      ...armed,
      spans: [toolSpan()],
      newMessages: [assistantCall("toolu_1", "search", { q: "x" })],
      transport: transportReturning([evidenceRow()]),
    });

    expect(result.completeness).toEqual({ status: "complete" });
    expect(result.spans[0]).toMatchObject({
      outputSource: "narration",
      wireCorroborated: true,
      evidenceRequestId: "req-1",
      evidenceStatus: "complete",
    });
    // Nothing synthetic: every call was narrated, so the trace transcript is
    // the narration.
    expect(result.traceMessages).toHaveLength(1);
  });

  test("appends a wire-only call the narration never mentioned", async () => {
    // The dropped-call case — the reason this whole path exists.
    const result = await reconcileTurnEvidence({
      ...armed,
      spans: [toolSpan()],
      newMessages: [assistantCall("toolu_1", "search", { q: "x" })],
      transport: transportReturning([
        evidenceRow(),
        evidenceRow({
          requestId: "req-dropped",
          toolName: "write_file",
          argumentsJson: JSON.stringify({ path: "/tmp/x" }),
          startedAtMs: 9,
        }),
      ]),
    });

    expect(result.traceMessages).toHaveLength(2);
    const appended = (result.traceMessages ?? [])[1] as unknown as {
      content: Array<Record<string, unknown>>;
    };
    expect(appended.content[0]).toMatchObject({
      toolCallId: "evidence:req-dropped",
      toolName: "write_file",
    });
  });

  test("an INCOMPLETE turn gets no synthetic messages at all", async () => {
    // Its record is known to have a hole. Adding reconstructed calls to a
    // transcript that is missing others produces one that is wrong in a new
    // way rather than honestly partial.
    const result = await reconcileTurnEvidence({
      ...armed,
      spans: [toolSpan()],
      newMessages: [assistantCall("toolu_1", "search", { q: "x" })],
      transport: transportReturning([
        evidenceRow({
          requestId: "lost",
          status: "started",
          settledAtMs: null,
        }),
        evidenceRow({ requestId: "wire-only", toolName: "write_file" }),
      ]),
    });

    expect(result.completeness).toEqual({
      status: "incomplete",
      reason: "unsettled_row",
    });
    expect(result.traceMessages).toHaveLength(1);
    expect(result.spans[0].evidenceStatus).toBe("incomplete");
  });

  test("a failed read makes the turn incomplete rather than empty", async () => {
    const result = await reconcileTurnEvidence({
      ...armed,
      spans: [toolSpan()],
      newMessages: [assistantCall("toolu_1", "search", { q: "x" })],
      transport: async () => ({ status: 500, body: null }),
    });

    expect(result.completeness).toEqual({
      status: "incomplete",
      reason: "read_incomplete",
    });
  });

  test("zero rows against narrated MCP calls is incomplete, not complete", async () => {
    // Capture that never armed. Grading this as complete would call every
    // narrated call a hallucination.
    const result = await reconcileTurnEvidence({
      ...armed,
      spans: [toolSpan()],
      newMessages: [assistantCall("toolu_1", "search", { q: "x" })],
      transport: transportReturning([]),
    });

    expect(result.completeness).toEqual({
      status: "incomplete",
      reason: "no_evidence_for_narrated_calls",
    });
  });
});

describe("collectNarratedCalls", () => {
  test("joins arguments from the messages with serverId from the spans", () => {
    // Neither source has both: spans do not carry arguments, and the message
    // projection does not resolve a server.
    const calls = collectNarratedCalls({
      newMessages: [assistantCall("toolu_1", "search", { q: "x" })],
      spans: [toolSpan()],
    });

    expect(calls).toEqual([
      {
        toolCallId: "toolu_1",
        toolName: "search",
        serverId: "server-1",
        arguments: { q: "x" },
      },
    ]);
  });

  test("marks the calls a policy refused", () => {
    const calls = collectNarratedCalls({
      newMessages: [assistantCall("toolu_1", "search", {})],
      spans: [toolSpan()],
      policyBlockedToolCallIds: new Set(["toolu_1"]),
    });

    expect(calls[0].policyBlocked).toBe(true);
  });

  test("drops a call with no id, which nothing could be matched against", () => {
    const calls = collectNarratedCalls({
      newMessages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolName: "search", input: {} }],
        } as unknown as ModelMessage,
      ],
      spans: [],
    });

    expect(calls).toEqual([]);
  });
});

describe("sawEvidenceUnavailableMarker", () => {
  test("finds the proxy's refusal in a flattened tool result", () => {
    // The harness flattens tool results to strings, so this is read out of the
    // text — the same channel the policy-block reader uses, and the only place
    // a refused call exists at all, since it left no row.
    expect(
      sawEvidenceUnavailableMarker([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              output: {
                type: "error-text",
                value:
                  "MCPJam could not record this tool call, so it was not executed. No action was taken on the server.",
              },
            },
          ],
        } as unknown as ModelMessage,
      ]),
    ).toBe(true);
  });

  test("does not fire on an ordinary tool failure", () => {
    expect(
      sawEvidenceUnavailableMarker([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              output: { type: "error-text", value: "upstream exploded" },
            },
          ],
        } as unknown as ModelMessage,
      ]),
    ).toBe(false);
  });
});
