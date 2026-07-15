import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { PromptTurn } from "@/shared/steps";
import {
  extractActualToolCalls,
  extractActualToolCallsByTurn,
  gradeLiveToolCalls,
} from "../eval-live-grading";

function userTurn(prompt: string, expectedToolCalls: PromptTurn["expectedToolCalls"]): PromptTurn {
  return { id: prompt, prompt, expectedToolCalls };
}

function pinnedTurn(toolName: string): PromptTurn {
  return {
    id: `pinned-${toolName}`,
    prompt: "",
    expectedToolCalls: [],
    pinnedToolCall: { toolName, arguments: {} },
  } as unknown as PromptTurn;
}

function userText(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function widgetCheckTurn(
  prompt: string,
  expectedToolCalls: PromptTurn["expectedToolCalls"],
): PromptTurn {
  return {
    id: prompt,
    prompt,
    expectedToolCalls,
    widgetChecks: [{ kind: "assert" }],
  } as unknown as PromptTurn;
}

function assistantWithTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: { dynamic?: boolean } = {},
): UIMessage {
  const part = opts.dynamic
    ? { type: "dynamic-tool", toolName, toolCallId: `${toolName}-1`, state: "output-available", input }
    : { type: `tool-${toolName}`, toolCallId: `${toolName}-1`, state: "output-available", input };
  return { id: `a-${toolName}`, role: "assistant", parts: [part] } as unknown as UIMessage;
}

const userMessage: UIMessage = {
  id: "u-1",
  role: "user",
  parts: [{ type: "text", text: "show me a coke" }],
} as unknown as UIMessage;

describe("extractActualToolCalls", () => {
  it("pulls typed and dynamic tool parts from assistant messages only", () => {
    const calls = extractActualToolCalls([
      userMessage,
      assistantWithTool("search-products", { query: "Coca Cola" }),
      assistantWithTool("add-to-cart", { id: 7 }, { dynamic: true }),
    ]);
    expect(calls).toEqual([
      { toolName: "search-products", arguments: { query: "Coca Cola" } },
      { toolName: "add-to-cart", arguments: { id: 7 } },
    ]);
  });

  it("ignores user-side parts and non-tool parts", () => {
    expect(extractActualToolCalls([userMessage])).toEqual([]);
  });
});

describe("gradeLiveToolCalls", () => {
  const turns = [
    userTurn("show me a coke", [
      { toolName: "search-products", arguments: { query: "Coca Cola" } },
    ]),
  ];

  it("passes when the asserted tool call was made with matching args", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: turns,
      messages: [userMessage, assistantWithTool("search-products", { query: "Coca Cola" })],
    });
    expect(verdict).toBe("passed");
  });

  it("fails when the asserted tool was not called", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: turns,
      messages: [userMessage, assistantWithTool("browse", { page: 1 })],
    });
    expect(verdict).toBe("failed");
  });

  it("fails when a required argument mismatches under strict matching", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: turns,
      matchOptions: { argumentMatching: "exact" },
      messages: [userMessage, assistantWithTool("search-products", { query: "Pepsi" })],
    });
    expect(verdict).toBe("failed");
  });

  it("returns null when there are no model turns to grade", () => {
    // No model turns at all => not a negative test and nothing asserted => defer
    // to a full graded Run rather than claim a pass.
    const verdict = gradeLiveToolCalls({
      promptTurns: [],
      messages: [userMessage, assistantWithTool("search-products", { query: "x" })],
    });
    expect(verdict).toBeNull();
  });

  it("grades a negative test (all model turns assert no calls): passes when no tools were called", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: [userTurn("don't call anything", [])],
      messages: [userMessage],
    });
    expect(verdict).toBe("passed");
  });

  it("fails a negative test when a tool was called", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: [userTurn("don't call anything", [])],
      messages: [userMessage, assistantWithTool("search-products", { query: "x" })],
    });
    expect(verdict).toBe("failed");
  });
});

describe("extractActualToolCallsByTurn", () => {
  it("buckets tool calls under the preceding user turn", () => {
    const buckets = extractActualToolCallsByTurn([
      userText("u1", "turn 1"),
      assistantWithTool("search-products", { query: "Coca Cola" }),
      userText("u2", "turn 2"),
      assistantWithTool("add-to-cart", { id: 7 }, { dynamic: true }),
    ]);
    expect(buckets).toEqual([
      [{ toolName: "search-products", arguments: { query: "Coca Cola" } }],
      [{ toolName: "add-to-cart", arguments: { id: 7 } }],
    ]);
  });

  it("ignores tool calls before the first user message", () => {
    const buckets = extractActualToolCallsByTurn([
      assistantWithTool("search-products", { query: "x" }),
      userText("u1", "turn 1"),
    ]);
    expect(buckets).toEqual([[]]);
  });
});

describe("gradeLiveToolCalls — multi-turn per-turn attribution", () => {
  const turns = [
    userTurn("turn 1", [{ toolName: "tool-a", arguments: {} }]),
    userTurn("turn 2", [{ toolName: "tool-b", arguments: {} }]),
  ];

  it("fails when turn 2's expected tool was actually called on turn 1", () => {
    // Both tools fire on turn 1; turn 2 makes no call. A global merge of all
    // expected vs all actual would pass (order-agnostic), but per-turn grading
    // (matching the runner's evaluateMultiTurnResults) must fail because turn 2
    // is missing its expected tool.
    const verdict = gradeLiveToolCalls({
      promptTurns: turns,
      messages: [
        userText("u1", "turn 1"),
        assistantWithTool("tool-a", {}),
        assistantWithTool("tool-b", {}),
        userText("u2", "turn 2"),
      ],
    });
    expect(verdict).toBe("failed");
  });

  it("passes when each turn made its own expected call", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: turns,
      messages: [
        userText("u1", "turn 1"),
        assistantWithTool("tool-a", {}),
        userText("u2", "turn 2"),
        assistantWithTool("tool-b", {}),
      ],
    });
    expect(verdict).toBe("passed");
  });

  it("skips pinned (model-free) turns and grades model turns in order", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: [
        pinnedTurn("render-widget"),
        userTurn("turn 1", [{ toolName: "tool-a", arguments: {} }]),
      ],
      messages: [userText("u1", "turn 1"), assistantWithTool("tool-a", {})],
    });
    expect(verdict).toBe("passed");
  });
});

describe("gradeLiveToolCalls — defers when it can't match the runner", () => {
  it("defers (null) when a turn carries widget interaction checks", () => {
    // The runner folds widget→host tool calls into the turn's actuals, but the
    // live preview never executes authored widget steps, so a model-only verdict
    // could disagree with a graded Run. Defer rather than show a badge.
    const verdict = gradeLiveToolCalls({
      promptTurns: [
        widgetCheckTurn("show a coke", [
          { toolName: "search-products", arguments: { query: "Coca Cola" } },
        ]),
      ],
      messages: [
        userText("u1", "show a coke"),
        assistantWithTool("search-products", { query: "Coca Cola" }),
      ],
    });
    expect(verdict).toBeNull();
  });

  it("defers (null) when a synthetic follow-up user turn over-segments the thread", () => {
    // Two authored model turns, but three user turns in the thread (a widget
    // ui/message follow-up the runner would fold into its parent turn). The 1:1
    // mapping breaks, so attribution is unreliable — defer.
    const verdict = gradeLiveToolCalls({
      promptTurns: [
        userTurn("turn 1", [{ toolName: "tool-a", arguments: {} }]),
        userTurn("turn 2", [{ toolName: "tool-b", arguments: {} }]),
      ],
      messages: [
        userText("u1", "turn 1"),
        assistantWithTool("tool-a", {}),
        userText("u2", "turn 2"),
        assistantWithTool("tool-b", {}),
        userText("u3", "widget follow-up"),
        assistantWithTool("tool-c", {}),
      ],
    });
    expect(verdict).toBeNull();
  });

  it("defers (null) on a partial run (fewer user turns than authored model turns)", () => {
    const verdict = gradeLiveToolCalls({
      promptTurns: [
        userTurn("turn 1", [{ toolName: "tool-a", arguments: {} }]),
        userTurn("turn 2", [{ toolName: "tool-b", arguments: {} }]),
      ],
      messages: [userText("u1", "turn 1"), assistantWithTool("tool-a", {})],
    });
    expect(verdict).toBeNull();
  });

  it("defers (null) for a pinned-only case instead of vacuously passing", () => {
    // Every turn is pinned (model-free), but the pinned turn declares expected
    // calls so the early "nothing to grade" gate doesn't fire. With no model
    // turns the loop would run zero times and return "passed" without comparing
    // anything — the live preview doesn't execute pinned fixtures, so it must
    // defer to the graded Run.
    const verdict = gradeLiveToolCalls({
      promptTurns: [
        {
          id: "p1",
          prompt: "",
          expectedToolCalls: [{ toolName: "render-widget", arguments: {} }],
          pinnedToolCall: { toolName: "render-widget", arguments: {} },
        } as unknown as PromptTurn,
      ],
      messages: [],
    });
    expect(verdict).toBeNull();
  });
});
