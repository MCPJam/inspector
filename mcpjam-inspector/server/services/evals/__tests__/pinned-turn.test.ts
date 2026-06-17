import { describe, expect, it, vi } from "vitest";
import { runPinnedTurn } from "../pinned-turn";
import { evaluateMultiTurnResults } from "../types";
import { legacyProbeToPinnedTurn } from "@/shared/prompt-turns";
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
