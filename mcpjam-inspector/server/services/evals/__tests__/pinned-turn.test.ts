import { describe, expect, it, vi } from "vitest";
import {
  buildPinnedTurnAccounting,
  runPinnedTurn,
  type PinnedTurnResult,
} from "../pinned-turn";
import { evaluateMultiTurnResults } from "../types";
import { legacyProbeToPinnedTurn } from "@/shared/steps";
import type { ProbeConfig } from "@/shared/probe-config";

const probe: ProbeConfig = {
  serverName: "Weather",
  toolName: "show_map",
  arguments: { city: "SF" },
};

function fakeBrowser() {
  return { renderPinnedToolResult: vi.fn().mockResolvedValue(undefined) };
}

describe("runPinnedTurn", () => {
  it("executes the pinned tool and renders on success", async () => {
    const browser = fakeBrowser();
    const executeTool = vi.fn().mockResolvedValue({ content: [], isError: false });
    const result = await runPinnedTurn({
      pinned: probe,
      resolvedServerKey: "srv-1",
      mcpClientManager: { executeTool } as any,
      browser,
      promptIndex: 0,
    });
    expect(executeTool).toHaveBeenCalledWith("srv-1", "show_map", { city: "SF" });
    expect(browser.renderPinnedToolResult).toHaveBeenCalledOnce();
    expect(result.toolCall).toEqual({ toolName: "show_map", arguments: { city: "SF" } });
    expect(result.toolError).toBeUndefined();
  });

  it("records a content-error and does NOT render", async () => {
    const browser = fakeBrowser();
    const executeTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
    const result = await runPinnedTurn({
      pinned: probe,
      resolvedServerKey: "srv-1",
      mcpClientManager: { executeTool } as any,
      browser,
      promptIndex: 0,
    });
    expect(browser.renderPinnedToolResult).not.toHaveBeenCalled();
    expect(result.toolError).toEqual({
      toolName: "show_map",
      kind: "content-error",
      message: "boom",
    });
    // Still recorded as an attempted call (predicate visibility).
    expect(result.toolCall).toEqual({ toolName: "show_map", arguments: { city: "SF" } });
  });

  it("records a protocol-error when executeTool throws", async () => {
    const browser = fakeBrowser();
    const executeTool = vi.fn().mockRejectedValue(new Error("transport down"));
    const result = await runPinnedTurn({
      pinned: probe,
      resolvedServerKey: "srv-1",
      mcpClientManager: { executeTool } as any,
      browser,
      promptIndex: 0,
    });
    expect(result.toolError).toEqual({
      toolName: "show_map",
      kind: "protocol-error",
      message: "transport down",
    });
  });

  it("reports a not-connected iteration error and no phantom call", async () => {
    const browser = fakeBrowser();
    const executeTool = vi.fn();
    const result = await runPinnedTurn({
      pinned: probe,
      resolvedServerKey: undefined,
      mcpClientManager: { executeTool } as any,
      browser,
      promptIndex: 0,
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.toolCall).toBeNull();
    expect(result.iterationError).toContain("not connected");
  });
});

describe("buildPinnedTurnAccounting", () => {
  const successResult: PinnedTurnResult = {
    toolCall: { toolName: "show_map", arguments: { city: "SF" } },
    toolCallId: "pinned-0-123",
    toolResult: { content: [] },
    summary: "Pinned tool call show_map executed",
  };

  it("derives the message pair and tool call on success", () => {
    const accounting = buildPinnedTurnAccounting(probe, successResult);
    expect(accounting.prompt).toBe('Pinned tool call: show_map on "Weather"');
    expect(accounting.userMessage).toEqual({
      role: "user",
      content: 'Pinned tool call: show_map on "Weather"',
    });
    expect(accounting.assistantMessage).toEqual({
      role: "assistant",
      content: "Pinned tool call show_map executed",
    });
    expect(accounting.summary).toBe("Pinned tool call show_map executed");
    expect(accounting.toolCalls).toEqual([
      { toolName: "show_map", arguments: { city: "SF" } },
    ]);
    expect(accounting.toolErrors).toEqual([]);
    expect(accounting.iterationError).toBeUndefined();
    expect(accounting.setupFailure).toBe(false);
  });

  it("carries a content-error as a toolError without setup failure", () => {
    const accounting = buildPinnedTurnAccounting(probe, {
      ...successResult,
      toolResultIsError: true,
      toolError: {
        toolName: "show_map",
        kind: "content-error",
        message: "boom",
      },
      summary: "Pinned tool call show_map failed: boom",
    });
    expect(accounting.toolErrors).toEqual([
      { toolName: "show_map", kind: "content-error", message: "boom" },
    ]);
    expect(accounting.toolCalls).toHaveLength(1);
    expect(accounting.iterationError).toBeUndefined();
    expect(accounting.setupFailure).toBe(false);
  });

  it("carries a protocol-error as a toolError without setup failure", () => {
    const accounting = buildPinnedTurnAccounting(probe, {
      ...successResult,
      toolResultIsError: true,
      toolError: {
        toolName: "show_map",
        kind: "protocol-error",
        message: "transport down",
      },
      summary: "Pinned tool call show_map failed: transport down",
    });
    expect(accounting.toolErrors[0]?.kind).toBe("protocol-error");
    expect(accounting.setupFailure).toBe(false);
  });

  it("maps not-connected to iterationError + setupFailure and no phantom call", () => {
    const accounting = buildPinnedTurnAccounting(probe, {
      toolCall: null,
      iterationError:
        'pinned_server_not_connected: "Weather" is not connected in this run\'s environment',
      summary: 'Pinned tool call skipped: server "Weather" not connected',
    });
    expect(accounting.toolCalls).toEqual([]);
    expect(accounting.toolErrors).toEqual([]);
    expect(accounting.iterationError).toContain("not connected");
    expect(accounting.setupFailure).toBe(true);
    // The transcript pair is still produced (transcript honesty on failure).
    expect(accounting.userMessage.role).toBe("user");
    expect(accounting.assistantMessage.content).toContain("skipped");
  });
});

describe("evaluateMultiTurnResults — pinned exclusion", () => {
  const pinnedTurn = legacyProbeToPinnedTurn(probe);

  it("passes a pinned turn regardless of strict/no-extra match options", () => {
    const result = evaluateMultiTurnResults(
      [pinnedTurn],
      [[{ toolName: "show_map", arguments: { city: "SF" } }]],
      false,
      { toolCallOrder: "strict", maxExtraToolCalls: 0, argumentMatching: "exact" },
    );
    expect(result.passed).toBe(true);
    // The pinned call still surfaces in toolsCalled for predicate visibility.
    expect(result.toolsCalled).toEqual([
      { toolName: "show_map", arguments: { city: "SF" } },
    ]);
    // ...but contributes nothing to the matching denominator.
    expect(result.expectedToolCalls).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  it("a model turn alongside a pinned turn is still matched normally", () => {
    const modelTurn = {
      id: "t2",
      prompt: "do it",
      expectedToolCalls: [{ toolName: "save", arguments: {} }],
    };
    const result = evaluateMultiTurnResults(
      [pinnedTurn, modelTurn],
      [
        [{ toolName: "show_map", arguments: { city: "SF" } }],
        [], // model failed to call `save`
      ],
      false,
    );
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual([{ toolName: "save", arguments: {} }]);
  });
});
