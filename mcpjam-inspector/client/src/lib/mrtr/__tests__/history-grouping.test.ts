import { describe, expect, it } from "vitest";
import {
  groupMrtrRounds,
  isInputRequiredResultPayload,
  isMrtrRequestPayload,
  type RpcFrame,
} from "../history-grouping";

let seq = 0;
function frame(
  direction: "SEND" | "RECV",
  method: string,
  payload: unknown,
): RpcFrame {
  return {
    id: `frame-${seq++}`,
    direction,
    method,
    timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
    payload,
  };
}

const req = (method: string, params: Record<string, unknown> = {}) =>
  frame("SEND", method, { jsonrpc: "2.0", id: seq, method, params });
const inputRequiredResult = (method: string) =>
  frame("RECV", method, {
    jsonrpc: "2.0",
    id: seq,
    result: { resultType: "input_required", inputRequests: { q: {} }, requestState: "s" },
  });
const completeResult = (method: string) =>
  frame("RECV", method, {
    jsonrpc: "2.0",
    id: seq,
    result: { content: [{ type: "text", text: "done" }] },
  });

describe("isInputRequiredResultPayload", () => {
  it("detects an input_required result inside a JSON-RPC envelope", () => {
    expect(
      isInputRequiredResultPayload({ result: { resultType: "input_required" } }),
    ).toBe(true);
  });
  it("detects a bare input_required result body", () => {
    expect(isInputRequiredResultPayload({ resultType: "input_required" })).toBe(true);
  });
  it("is false for a normal complete result", () => {
    expect(
      isInputRequiredResultPayload({ result: { content: [] } }),
    ).toBe(false);
  });
  it("is false for a JSON-RPC error and non-objects", () => {
    expect(isInputRequiredResultPayload({ error: { code: -32000 } })).toBe(false);
    expect(isInputRequiredResultPayload(null)).toBe(false);
    expect(isInputRequiredResultPayload("input_required")).toBe(false);
  });
});

describe("isMrtrRequestPayload", () => {
  it("matches the three MRTR verbs", () => {
    for (const m of ["tools/call", "prompts/get", "resources/read"]) {
      expect(isMrtrRequestPayload({ method: m, params: {} })).toBe(true);
    }
    expect(isMrtrRequestPayload({ method: "ping" })).toBe(false);
  });
});

describe("groupMrtrRounds", () => {
  it("groups one logical op (request → interim → retry → final) into ONE entry", () => {
    seq = 0;
    const frames = [
      req("tools/call", { name: "confirm", arguments: { topic: "x" } }),
      inputRequiredResult("tools/call"),
      req("tools/call", {
        name: "confirm",
        arguments: { topic: "x" },
        inputResponses: { q: { action: "accept", content: {} } },
        requestState: "s",
      }),
      completeResult("tools/call"),
    ];
    const groups = groupMrtrRounds(frames);
    expect(groups).toHaveLength(1);
    const op = groups[0];
    expect(op.method).toBe("tools/call");
    expect(op.rounds).toBe(1);
    expect(op.awaitingInput).toBe(false);
    // All four raw child frames are preserved, in order, with their fresh ids.
    expect(op.frames.map((f) => f.frame.id)).toEqual([
      "frame-0",
      "frame-1",
      "frame-2",
      "frame-3",
    ]);
    expect(op.frames.map((f) => f.role)).toEqual([
      "original-request",
      "interim-result",
      "retry-request",
      "final-result",
    ]);
  });

  it("NEVER classifies the interim input_required as a failure", () => {
    seq = 0;
    const frames = [req("tools/call"), inputRequiredResult("tools/call")];
    const groups = groupMrtrRounds(frames);
    const interim = groups[0].frames.find((f) => f.role === "interim-result");
    expect(interim).toBeDefined();
    // The role is an interim result and the op is awaiting input — not errored.
    expect(groups[0].awaitingInput).toBe(true);
    expect(groups[0].frames.some((f) => f.role === "final-result")).toBe(false);
  });

  it("counts multiple rounds of the same op", () => {
    seq = 0;
    const frames = [
      req("prompts/get"),
      inputRequiredResult("prompts/get"),
      req("prompts/get", { inputResponses: {} }),
      inputRequiredResult("prompts/get"),
      req("prompts/get", { inputResponses: {} }),
      completeResult("prompts/get"),
    ];
    const groups = groupMrtrRounds(frames);
    expect(groups).toHaveLength(1);
    expect(groups[0].rounds).toBe(2);
    expect(groups[0].frames).toHaveLength(6);
  });

  it("keeps unrelated interleaved traffic as its own singleton group in place", () => {
    seq = 0;
    const frames = [
      req("tools/call"),
      frame("SEND", "ping", { jsonrpc: "2.0", id: 99, method: "ping" }),
      inputRequiredResult("tools/call"),
      req("tools/call", { inputResponses: {} }),
      completeResult("tools/call"),
    ];
    const groups = groupMrtrRounds(frames);
    // The op group + the ping singleton.
    expect(groups.some((g) => g.method === "ping")).toBe(true);
    const op = groups.find((g) => g.method === "tools/call")!;
    expect(op.rounds).toBe(1);
    expect(op.frames.map((f) => f.role)).toEqual([
      "original-request",
      "interim-result",
      "retry-request",
      "final-result",
    ]);
  });

  it("does not mutate its input frames", () => {
    seq = 0;
    const frames = [req("tools/call"), completeResult("tools/call")];
    const snapshot = JSON.stringify(frames);
    groupMrtrRounds(frames);
    expect(JSON.stringify(frames)).toBe(snapshot);
  });
});
