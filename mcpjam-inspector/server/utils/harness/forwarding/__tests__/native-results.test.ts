import { describe, expect, it, vi } from "vitest";
import {
  nativeToolCallId,
  readNativeToolResult,
  withoutHostCorrelation,
} from "../native-results.js";

it("uses only the runtime-selected metadata key for result correlation", () => {
  const params = { _meta: { callId: "codex-call", "claudecode/toolUseId": "claude-call" } };
  expect(nativeToolCallId(params, "callId")).toBe("codex-call");
  expect(nativeToolCallId(params)).toBe("claude-call");
  expect(nativeToolCallId({ _meta: { "claudecode/toolUseId": "other" } }, "callId")).toBeUndefined();
  expect(nativeToolCallId({ _meta: { callId: 42 } }, "callId")).toBeUndefined();
});
import type { ExecutionControl } from "../execution-control.js";
import { ExecutionControlError } from "../execution-control.js";

function fixture() {
  const result = {
    content: [
      { type: "text", text: "Original text" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ],
    structuredContent: { value: "Different structured result" },
    _meta: { private: "Widget only" },
    isError: false,
  };
  const receipt = {
    _id: "execution",
    method: "tools/call",
    turnId: "turn",
    params: null,
    authority: {
      userId: "user",
      projectId: "project",
      sessionId: "lane",
      serverId: "server",
      accountId: "account",
    },
    state: "settled" as const,
    outcome: "success",
    complete: true,
    result: {
      json: JSON.stringify({ jsonrpc: "2.0", id: 4, result }),
      url: null,
      bytes: 100,
      truncated: false,
    },
  };
  const control = {
    nativeResult: vi
      .fn<ExecutionControl["nativeResult"]>()
      .mockResolvedValue(receipt),
  };
  return { result, receipt, control };
}

describe("native tool result correlation", () => {
  it.each(["control_409", "control_403", "invalid_control_response"])(
    "does not claim a dispatched tool was refused when result lookup fails (%s)",
    async (code) => {
      const f = fixture();
      const onReceipt = vi.fn();
      f.control.nativeResult.mockRejectedValueOnce(new ExecutionControlError(code));
      await expect(
        readNativeToolResult(f.control, "turn", "native-call", onReceipt),
      ).rejects.toThrow("The tool may have run, but its final result could not be confirmed.");
      expect(f.control.nativeResult).toHaveBeenCalledExactlyOnceWith("turn", "native-call");
      expect(onReceipt).not.toHaveBeenCalled();
    },
  );
  it("reads only the native metadata identity, not matching arguments", () => {
    expect(
      nativeToolCallId({
        _meta: { "claudecode/toolUseId": "toolu_one", progressToken: 3 },
      }),
    ).toBe("toolu_one");
    expect(
      nativeToolCallId({ arguments: { toolUseId: "toolu_one" } }),
    ).toBeUndefined();
    expect(
      nativeToolCallId({ _meta: { "claudecode/toolUseId": 1 } }),
    ).toBeUndefined();
    expect(
      nativeToolCallId({ _meta: { "claudecode/toolUseId": "x".repeat(513) } }),
    ).toBeUndefined();
  });
  it("preserves original content, image shape, structured content and private metadata", async () => {
    const f = fixture();
    expect(await readNativeToolResult(f.control, "turn", "toolu_one")).toEqual(
      f.result,
    );
    expect(f.control.nativeResult).toHaveBeenCalledExactlyOnceWith(
      "turn",
      "toolu_one",
    );
  });
  it("preserves a server tool error but does not hydrate denied operations", async () => {
    const f = fixture();
    f.control.nativeResult.mockResolvedValueOnce({
      ...f.receipt,
      outcome: "tool_error",
      result: {
        ...f.receipt.result,
        json: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          result: { ...f.result, isError: true },
        }),
      },
    });
    expect(
      await readNativeToolResult(f.control, "turn", "toolu_error"),
    ).toEqual({ ...f.result, isError: true });
    f.control.nativeResult.mockResolvedValueOnce({
      ...f.receipt,
      outcome: "denied",
      result: null,
      complete: false,
    });
    expect(
      await readNativeToolResult(f.control, "turn", "toolu_denied"),
    ).toBeUndefined();
  });
  it("does not replace an unavailable, ambiguous or incomplete result with Claude's projection", async () => {
    const f = fixture();
    f.control.nativeResult.mockRejectedValueOnce(
      new Error("ambiguous_native_tool_call"),
    );
    await expect(
      readNativeToolResult(f.control, "turn", "toolu_duplicate"),
    ).rejects.toThrow("ambiguous");
    f.control.nativeResult.mockResolvedValueOnce({
      ...f.receipt,
      complete: false,
    });
    await expect(
      readNativeToolResult(f.control, "turn", "toolu_incomplete"),
    ).rejects.toThrow("unavailable");
  });
});

describe("MCPJam's own correlation key", () => {
  const call = (meta: Record<string, unknown>) => {
    const message = {
      jsonrpc: "2.0" as const,
      id: 4,
      method: "tools/call",
      params: { _meta: meta, arguments: { note: "one" }, name: "record_write" },
    };
    return { body: JSON.stringify(message), message };
  };

  it("is read for correlation and left out of the forwarded request", () => {
    const forwarded = call({ "mcpjam/toolCallId": "call_1", progressToken: 1 });
    expect(nativeToolCallId(forwarded.message.params, "mcpjam/toolCallId")).toBe("call_1");
    const sent = withoutHostCorrelation(forwarded, "mcpjam/toolCallId");
    expect(sent.message).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { _meta: { progressToken: 1 }, arguments: { note: "one" }, name: "record_write" },
    });
    expect(sent.body).toBe(JSON.stringify(sent.message));
  });

  it("drops a metadata object that held only the key", () => {
    const sent = withoutHostCorrelation(call({ "mcpjam/toolCallId": "call_1" }), "mcpjam/toolCallId");
    expect(sent.message?.params).toEqual({ arguments: { note: "one" }, name: "record_write" });
  });

  it("forwards a runtime's own key and an unstamped request byte for byte", () => {
    const codex = call({ callId: "codex-call" });
    expect(withoutHostCorrelation(codex, "callId")).toBe(codex);
    const unstamped = call({ progressToken: 1 });
    expect(withoutHostCorrelation(unstamped, "mcpjam/toolCallId")).toBe(unstamped);
    expect(withoutHostCorrelation({ body: "", message: undefined }, "mcpjam/toolCallId").body).toBe("");
  });
});
