/**
 * Reconciling narration against evidence.
 *
 * Two ideas are on trial in every case below. First, that neither record is
 * allowed to overwrite the other: the narration is the only account of the
 * model's intent, and the evidence is the only account of what the servers
 * actually received. Second, that when the merger cannot tell what happened it
 * says so, rather than guessing — because a guess here becomes a verdict.
 */
import { describe, expect, test } from "vitest";
import {
  assessCompleteness,
  buildEvidenceToolResultMessage,
  evidenceToolCallId,
  mergeHarnessEvidence,
  type EvidenceRow,
  type NarratedToolCall,
} from "../harness-evidence-merge";

function row(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    requestId: "req-1",
    turnId: "turn-1",
    serverId: "server-1",
    toolName: "search",
    argumentsJson: JSON.stringify({ q: "x" }),
    status: "settled",
    outcomeKind: "success",
    responseJson: JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
    startedAtMs: 1_000,
    settledAtMs: 1_050,
    payloadsReadable: true,
    ...over,
  };
}

function narrated(over: Partial<NarratedToolCall> = {}): NarratedToolCall {
  return {
    toolCallId: "toolu_1",
    toolName: "search",
    serverId: "server-1",
    arguments: { q: "x" },
    ...over,
  };
}

const complete = { readExhausted: true };

describe("matching", () => {
  test("matches on server, tool and argument VALUE, not key order", () => {
    // The harness serializes its arguments and the proxy re-serializes what it
    // received; key order is not stable between them while the value is. A
    // digest that cared about order would report every call as unmatched.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [row({ argumentsJson: JSON.stringify({ b: 2, a: 1 }) })],
      narratedCalls: [narrated({ arguments: { a: 1, b: 2 } })],
    });

    expect(result.matchedByToolCallId.get("toolu_1")?.requestId).toBe("req-1");
    expect(result.wireOnlyCalls).toHaveLength(0);
    expect(result.narrationOnlyToolCallIds.size).toBe(0);
  });

  test("pairs repeated identical calls by ORDINAL, one to one", () => {
    // Three identical calls are three calls. Matching them as a set would let
    // one wire row stand in for all three, and a dropped repeat would vanish.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [
        row({ requestId: "req-a", startedAtMs: 1 }),
        row({ requestId: "req-b", startedAtMs: 2 }),
        row({ requestId: "req-c", startedAtMs: 3 }),
      ],
      narratedCalls: [
        narrated({ toolCallId: "t1" }),
        narrated({ toolCallId: "t2" }),
        narrated({ toolCallId: "t3" }),
      ],
    });

    expect(
      ["t1", "t2", "t3"].map(
        (id) => result.matchedByToolCallId.get(id)?.requestId,
      ),
    ).toEqual(["req-a", "req-b", "req-c"]);
  });

  test("a narrated call the proxy never saw stays narration-only", () => {
    // The hallucination case. It is retained (it is what the model believed)
    // but never given someone else's result.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [row()],
      narratedCalls: [
        narrated({ toolCallId: "real" }),
        narrated({ toolCallId: "invented", arguments: { q: "never sent" } }),
      ],
    });

    expect(result.matchedByToolCallId.has("real")).toBe(true);
    expect([...result.narrationOnlyToolCallIds]).toEqual(["invented"]);
  });

  test("a wire call the narration never mentioned stays wire-only", () => {
    // The dropped-call case, and the reason the evidence exists: the model
    // really did call this, and the narration lost it.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [
        row({ requestId: "narrated-one" }),
        row({
          requestId: "dropped-one",
          toolName: "write_file",
          argumentsJson: JSON.stringify({ path: "/tmp/x" }),
          startedAtMs: 2_000,
        }),
      ],
      narratedCalls: [narrated()],
    });

    expect(result.wireOnlyCalls.map((c) => c.requestId)).toEqual([
      "dropped-one",
    ]);
  });

  test("never attaches one call's result to another when arguments differ", () => {
    // Strict matching, no "close enough" tier. Pairing these would hand a
    // possibly-hallucinated narration a possibly-dropped call's result — worse
    // than leaving both unmatched, because the mistake is invisible.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [row({ argumentsJson: JSON.stringify({ q: "actual" }) })],
      narratedCalls: [narrated({ arguments: { q: "claimed" } })],
    });

    expect(result.matchedByToolCallId.size).toBe(0);
    expect(result.narrationOnlyToolCallIds.size).toBe(1);
    expect(result.wireOnlyCalls).toHaveLength(1);
  });

  test("a native harness tool is not evidence of anything missing", () => {
    // Bash and Read never cross the proxy, so their absence from the evidence
    // is expected rather than suspicious.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [row()],
      narratedCalls: [
        narrated(),
        { toolCallId: "bash-1", toolName: "Bash", arguments: { cmd: "ls" } },
      ],
    });

    expect(result.narrationOnlyToolCallIds.size).toBe(0);
  });

  test("a policy-blocked call is excluded from reconciliation entirely", () => {
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [],
      narratedCalls: [narrated({ toolCallId: "blocked", policyBlocked: true })],
    });

    expect(result.narrationOnlyToolCallIds.size).toBe(0);
    expect(result.completeness.status).toBe("complete");
  });
});

describe("ordering", () => {
  test("wire-only calls order by start time, with request id breaking ties", () => {
    // The merger never invents an order it cannot observe: two calls started
    // in the same millisecond get a stable order, not an arbitrary one.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [
        row({ requestId: "b", startedAtMs: 5, toolName: "t2" }),
        row({ requestId: "a", startedAtMs: 5, toolName: "t3" }),
        row({ requestId: "c", startedAtMs: 1, toolName: "t1" }),
      ],
      narratedCalls: [],
    });

    expect(result.wireOnlyCalls.map((c) => c.requestId)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("completeness", () => {
  test("all rows settled and readable is complete", () => {
    expect(
      assessCompleteness({
        ...complete,
        rows: [row(), row({ requestId: "req-2" })],
        narratedCalls: [narrated()],
      }),
    ).toEqual({ status: "complete" });
  });

  test("a started row with no settlement makes the turn incomplete", () => {
    // The durable marker of a lost tail — one unsettled row is enough, however
    // many others landed.
    expect(
      assessCompleteness({
        ...complete,
        rows: [
          row(),
          row({ requestId: "lost", status: "started", settledAtMs: null }),
        ],
        narratedCalls: [],
      }),
    ).toEqual({ status: "incomplete", reason: "unsettled_row" });
  });

  test("a settled row whose payload cannot be read is incomplete", () => {
    expect(
      assessCompleteness({
        ...complete,
        rows: [row({ payloadsReadable: false })],
        narratedCalls: [],
      }),
    ).toEqual({ status: "incomplete", reason: "unreadable_payload" });
  });

  test("an unfinished read is incomplete, even if every row seen is settled", () => {
    expect(
      assessCompleteness({
        readExhausted: false,
        rows: [row()],
        narratedCalls: [narrated()],
      }),
    ).toEqual({ status: "incomplete", reason: "read_incomplete" });
  });

  test("ZERO rows with narrated MCP calls is incomplete, not vacuously complete", () => {
    // The signature of capture that never armed. Reading it as complete would
    // flip every narrated call to "hallucinated" on a run where the RECORDER
    // was at fault, which is the worst possible way to be wrong here.
    expect(
      assessCompleteness({
        ...complete,
        rows: [],
        narratedCalls: [narrated()],
      }),
    ).toEqual({
      status: "incomplete",
      reason: "no_evidence_for_narrated_calls",
    });
  });

  test("zero rows with no MCP calls at all is genuinely complete", () => {
    // A prose-only turn, and a turn whose only tools were native ones. There
    // is nothing missing here.
    expect(
      assessCompleteness({ ...complete, rows: [], narratedCalls: [] }),
    ).toEqual({ status: "complete" });

    expect(
      assessCompleteness({
        ...complete,
        rows: [],
        narratedCalls: [
          { toolCallId: "bash", toolName: "Bash", arguments: {} },
        ],
      }),
    ).toEqual({ status: "complete" });
  });

  test("zero rows with only POLICY-BLOCKED calls is complete", () => {
    // A blocked call is refused before the bridge, so it legitimately leaves
    // no row. Counting it would downgrade every policy-exercising turn.
    expect(
      assessCompleteness({
        ...complete,
        rows: [],
        narratedCalls: [narrated({ policyBlocked: true })],
      }),
    ).toEqual({ status: "complete" });
  });

  test("an evidence-unavailable refusal marks the turn incomplete", () => {
    // A refused call leaves NO row — the proxy stopped before writing one — so
    // the narration is the only place it exists. Without this arm the turn
    // would look complete while missing a call the model tried to make.
    expect(
      assessCompleteness({
        ...complete,
        rows: [row()],
        narratedCalls: [narrated()],
        sawEvidenceUnavailableMarker: true,
      }),
    ).toEqual({
      status: "incomplete",
      reason: "evidence_unavailable_marker",
    });
  });

  test("an unreadable or unsettled row is never parsed into a partial call", () => {
    // A half-populated call would let a grader read a value that was never
    // really there.
    const result = mergeHarnessEvidence({
      ...complete,
      rows: [
        row({ requestId: "unsettled", status: "started", settledAtMs: null }),
        row({ requestId: "unreadable", payloadsReadable: false }),
      ],
      narratedCalls: [],
    });

    expect(result.canonicalCalls).toHaveLength(0);
  });
});

describe("trace projection", () => {
  test("a wire-only success gets the emulated shape and an evidence id", () => {
    const call = {
      requestId: "abc-123",
      serverId: "server-1",
      toolName: "search",
      arguments: { q: "x" },
      response: { content: [{ type: "text", text: "ok" }] },
      outcomeKind: "success" as const,
      startedAtMs: 1,
      settledAtMs: 2,
    };

    const part = buildEvidenceToolResultMessage(call).content[0];

    expect(part.toolCallId).toBe(evidenceToolCallId("abc-123"));
    expect(part.toolCallId).toBe("evidence:abc-123");
    expect(part.toolName).toBe("search");
    expect(part.serverId).toBe("server-1");
    // The raw result is what widget hydration and evidence-graded assertions
    // read; the transcript would be useless without it.
    expect(part.result).toEqual(call.response);
  });

  test("a JSON-RPC error gets the error shape, with no result or origin", () => {
    const part = buildEvidenceToolResultMessage({
      requestId: "abc",
      serverId: "server-1",
      toolName: "search",
      arguments: {},
      response: { error: { code: -32000, message: "upstream exploded" } },
      outcomeKind: "jsonrpc_error",
      startedAtMs: 1,
      settledAtMs: 2,
    }).content[0];

    expect(part.output).toEqual({
      type: "error-text",
      value: "upstream exploded",
    });
    expect(part).not.toHaveProperty("result");
    expect(part).not.toHaveProperty("serverId");
  });

  test("an isError result keeps the SUCCESS shape and its raw result", () => {
    // A domain error the model read and reacted to. Giving it the error shape
    // would strip the result an assertion needs to see.
    const part = buildEvidenceToolResultMessage({
      requestId: "abc",
      serverId: "server-1",
      toolName: "search",
      arguments: {},
      response: { content: [{ type: "text", text: "no rows" }], isError: true },
      outcomeKind: "call_tool_error",
      startedAtMs: 1,
      settledAtMs: 2,
    }).content[0];

    expect(part.result).toMatchObject({ isError: true });
    expect(part.output).toMatchObject({ type: "json" });
  });
});
