import { describe, it, expect } from "vitest";
import {
  appendToolCallsForPrompt,
  type ToolCall,
} from "@/shared/eval-matching";
import type { PromptTurn } from "@/shared/steps";
import { evaluateMultiTurnResults } from "../types";

/**
 * Regression coverage for the "Show me a redbull" bug: a widget `ui/message`
 * follow-up turn (clicking the cart → model calls `view-cart`) reuses its
 * parent authored turn's `promptIndex`. The runner must FOLD those calls into
 * the parent bucket so `evaluateMultiTurnResults` (which maps only over
 * authored `promptTurns`) credits them. Before the fix the follow-up's calls
 * were pushed to an orphan slot the grader never read, so `view-cart` showed
 * as missing and the iteration failed even though the deterministic predicate
 * for `view-cart` passed.
 */
describe("widget follow-up tool-call attribution", () => {
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
    toolName: name,
    arguments: args,
  });

  // One authored prompt ("Show me a redbull") that expects search-products and
  // (via the post-interaction assert) view-cart.
  const turns: PromptTurn[] = [
    {
      id: "turn-1",
      prompt: "Show me a redbull",
      expectedToolCalls: [
        { toolName: "search-products", arguments: { query: "redbull" } },
        { toolName: "view-cart", arguments: {} },
      ],
    },
  ];

  it("credits a folded follow-up call so the single authored turn passes", () => {
    // Simulate the runner accumulator: the authored turn drive records
    // search-products at promptIndex 0; the cart-click follow-up drive records
    // view-cart, ALSO at promptIndex 0 (it reuses the parent's ordinal).
    const toolsCalledByPrompt: ToolCall[][] = [];
    appendToolCallsForPrompt(toolsCalledByPrompt, 0, [
      call("search-products", { query: "redbull" }),
    ]);
    appendToolCallsForPrompt(toolsCalledByPrompt, 0, [call("view-cart")]);

    const result = evaluateMultiTurnResults(turns, toolsCalledByPrompt, false, {
      argumentMatching: "partial",
    });

    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.toolsCalled.map((c) => c.toolName)).toEqual([
      "search-products",
      "view-cart",
    ]);
  });

  it("documents the orphan-slot failure the fold prevents", () => {
    // The OLD `push()` behavior: the follow-up's view-cart lands at a fresh
    // bucket index (1) with no authored turn → the grader never reads it.
    const orphaned: ToolCall[][] = [
      [call("search-products", { query: "redbull" })],
      [call("view-cart")], // orphan slot, no authored turn at index 1
    ];

    const result = evaluateMultiTurnResults(turns, orphaned, false, {
      argumentMatching: "partial",
    });

    expect(result.passed).toBe(false);
    expect(result.missing.map((c) => c.toolName)).toContain("view-cart");
  });
});
