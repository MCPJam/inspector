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

describe("evaluateMultiTurnResults — skill-tool exemption (PR-E1)", () => {
  const zeroExpectTurn = { id: "t1", prompt: "answer me", expectedToolCalls: [] };
  const noExtras = { maxExtraToolCalls: 0 } as const;
  const load = { toolName: "loadSkill", arguments: { name: "pdf" } };
  const list = { toolName: "listSkills", arguments: {} };

  it("exempts skill-tool calls from a maxExtraToolCalls:0 turn when active", () => {
    const result = evaluateMultiTurnResults(
      [zeroExpectTurn],
      [[list, load]],
      false,
      noExtras,
      { skillToolsActive: true },
    );
    expect(result.passed).toBe(true);
    expect(result.unexpected).toEqual([]);
    // ...but the loads STAY visible in the summary for trace/judge/adherence.
    expect(result.toolsCalled).toEqual([list, load]);
  });

  it("still FAILS on a non-skill extra call even with skills active", () => {
    const result = evaluateMultiTurnResults(
      [zeroExpectTurn],
      [[load, { toolName: "save", arguments: {} }]],
      false,
      noExtras,
      { skillToolsActive: true },
    );
    expect(result.passed).toBe(false);
    // Only the non-skill call is charged as unexpected; the load is exempt.
    expect(result.unexpected).toEqual([{ toolName: "save", arguments: {} }]);
  });

  it("does NOT exempt when skillToolsActive is false (byte-identical legacy)", () => {
    const result = evaluateMultiTurnResults(
      [zeroExpectTurn],
      [[load]],
      false,
      noExtras,
      { skillToolsActive: false },
    );
    expect(result.passed).toBe(false);
    expect(result.unexpected).toEqual([load]);
  });

  it("a skill tool NAMED in expectedToolCalls is matched, not exempted", () => {
    // Skill-CI case: expecting loadSkill and it IS called → passes.
    const expectTurn = {
      id: "t1",
      prompt: "use the skill",
      expectedToolCalls: [load],
    };
    const ok = evaluateMultiTurnResults([expectTurn], [[load]], false, noExtras, {
      skillToolsActive: true,
    });
    expect(ok.passed).toBe(true);

    // Expecting loadSkill but it is NOT called → missing (exemption must not hide it).
    const missing = evaluateMultiTurnResults(
      [expectTurn],
      [[list]],
      false,
      noExtras,
      { skillToolsActive: true },
    );
    expect(missing.passed).toBe(false);
    expect(missing.missing).toEqual([load]);
  });

  it("a negative test is not tripped by an unexpected skill load when active", () => {
    const result = evaluateMultiTurnResults(
      [zeroExpectTurn],
      [[load]],
      true, // isNegativeTest
      undefined,
      { skillToolsActive: true },
    );
    expect(result.passed).toBe(true);
    expect(result.unexpected).toEqual([]);
    expect(result.toolsCalled).toEqual([load]);
  });
});
