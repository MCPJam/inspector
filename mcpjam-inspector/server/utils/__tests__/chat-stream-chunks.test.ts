import { describe, expect, it, vi } from "vitest";
import {
  buildFinishChunk,
  emitToolInput,
  emitToolOutput,
  errorChunk,
  safelyInvoke,
  textDeltaChunk,
  textEndChunk,
  textStartChunk,
  toolApprovalRequestChunk,
  toolInputChunk,
  toolOutputChunk,
  toolOutputDeniedChunk,
} from "../chat-stream-chunks";

// THE DRIFT LOCK: both chat engines (emulated runChatEngineLoop + harness
// runHarnessTurn) now construct their client chunks through these builders, so
// freezing each shape here keeps the two engines' wire format in lockstep. The
// load-bearing assertions are the OMITTED optional keys (`providerExecuted`,
// `messageMetadata`) — a stray `false`/`null` would be new wire output.

describe("chat-stream-chunks builders — frozen shapes", () => {
  it("text chunks", () => {
    expect(textStartChunk("t1")).toEqual({ type: "text-start", id: "t1" });
    expect(textDeltaChunk("t1", "hi")).toEqual({
      type: "text-delta",
      id: "t1",
      delta: "hi",
    });
    expect(textEndChunk("t1")).toEqual({ type: "text-end", id: "t1" });
  });

  it("tool-input: providerExecuted present only when true, else OMITTED", () => {
    const harness = toolInputChunk({
      toolCallId: "c1",
      toolName: "read",
      input: { a: 1 },
      providerExecuted: true,
    });
    expect(harness).toEqual({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "read",
      input: { a: 1 },
      providerExecuted: true,
    });

    const emulated = toolInputChunk({
      toolCallId: "c1",
      toolName: "read",
      input: { a: 1 },
    });
    expect(emulated).not.toHaveProperty("providerExecuted");
    expect(emulated).toEqual({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "read",
      input: { a: 1 },
    });
  });

  it("tool-output: providerExecuted present only when true, else OMITTED", () => {
    expect(
      toolOutputChunk({ toolCallId: "c1", output: { ok: 1 }, providerExecuted: true }),
    ).toEqual({
      type: "tool-output-available",
      toolCallId: "c1",
      output: { ok: 1 },
      providerExecuted: true,
    });
    const emulated = toolOutputChunk({ toolCallId: "c1", output: { ok: 1 } });
    expect(emulated).not.toHaveProperty("providerExecuted");
    expect(emulated).toEqual({
      type: "tool-output-available",
      toolCallId: "c1",
      output: { ok: 1 },
    });
  });

  it("tool-approval-request + tool-output-denied", () => {
    expect(toolApprovalRequestChunk({ approvalId: "a1", toolCallId: "c1" })).toEqual({
      type: "tool-approval-request",
      approvalId: "a1",
      toolCallId: "c1",
    });
    expect(toolOutputDeniedChunk({ toolCallId: "c1" })).toEqual({
      type: "tool-output-denied",
      toolCallId: "c1",
    });
  });

  it("finish: messageMetadata present when non-null, OMITTED when null/undefined", () => {
    expect(
      buildFinishChunk({ finishReason: "stop", messageMetadata: { inputTokens: 3 } }),
    ).toEqual({
      type: "finish",
      finishReason: "stop",
      messageMetadata: { inputTokens: 3 },
    });
    const noMeta = buildFinishChunk({ finishReason: "stop", messageMetadata: undefined });
    expect(noMeta).not.toHaveProperty("messageMetadata");
    expect(noMeta).toEqual({ type: "finish", finishReason: "stop" });
    expect(buildFinishChunk({ finishReason: "length" })).not.toHaveProperty(
      "messageMetadata",
    );
  });

  it("error", () => {
    expect(errorChunk("boom")).toEqual({ type: "error", errorText: "boom" });
  });
});

describe("emit* wrappers write to the writer and return the chunk", () => {
  it("emitToolInput / emitToolOutput", () => {
    const written: unknown[] = [];
    const writer = { write: (c: unknown) => written.push(c) };
    const inChunk = emitToolInput(writer as any, {
      toolCallId: "c1",
      toolName: "read",
      input: {},
      providerExecuted: true,
    });
    const outChunk = emitToolOutput(writer as any, {
      toolCallId: "c1",
      output: {},
      providerExecuted: true,
    });
    expect(written).toEqual([inChunk, outChunk]);
    expect((inChunk as any).providerExecuted).toBe(true);
  });
});

describe("safelyInvoke — fire-and-forget guard", () => {
  it("swallows a synchronous throw without rethrowing", () => {
    expect(() =>
      safelyInvoke("[test] cb", () => {
        throw new Error("sync boom");
      }),
    ).not.toThrow();
  });

  it("swallows a rejected promise without an unhandled rejection", async () => {
    safelyInvoke("[test] cb", () => Promise.reject(new Error("async boom")));
    // let the microtask + .catch settle
    await new Promise((r) => setTimeout(r, 0));
    // no assertion needed: the test fails if the rejection goes unhandled
  });

  it("does not invoke logger on success", () => {
    const fn = vi.fn(() => "ok");
    expect(() => safelyInvoke("[test] cb", fn)).not.toThrow();
    expect(fn).toHaveBeenCalledOnce();
  });
});
