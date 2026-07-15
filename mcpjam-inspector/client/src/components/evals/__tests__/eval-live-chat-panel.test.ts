import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UIMessage } from "ai";
import { messagesToCapturedTurns } from "../eval-live-chat-panel";

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistantToolMsg(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId: `${id}-call`,
        state: "output-available",
        input,
        output: {},
      },
    ],
  } as unknown as UIMessage;
}

describe("messagesToCapturedTurns", () => {
  it("folds each user message + its following tool calls into a turn", () => {
    const turns = messagesToCapturedTurns([
      userMsg("u1", "Show me a redbull"),
      assistantToolMsg("a1", "search-products", { q: "redbull" }),
      userMsg("u2", "Now a coke"),
      assistantToolMsg("a2", "search-products", { q: "coke" }),
      assistantToolMsg("a3", "view-cart", {}),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe("Show me a redbull");
    expect(turns[0].expectedToolCalls.map((t) => t.toolName)).toEqual([
      "search-products",
    ]);
    expect(turns[1].prompt).toBe("Now a coke");
    expect(turns[1].expectedToolCalls.map((t) => t.toolName)).toEqual([
      "search-products",
      "view-cart",
    ]);
  });

  it("dedupes repeated tool names within a single turn", () => {
    const turns = messagesToCapturedTurns([
      userMsg("u1", "search twice"),
      assistantToolMsg("a1", "search-products", { q: "a" }),
      assistantToolMsg("a2", "search-products", { q: "b" }),
    ]);
    expect(turns[0].expectedToolCalls.map((t) => t.toolName)).toEqual([
      "search-products",
    ]);
  });

  it("ignores assistant tool calls before any user turn", () => {
    const turns = messagesToCapturedTurns([
      assistantToolMsg("a0", "orphan-tool", {}),
      userMsg("u1", "hi"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].expectedToolCalls).toEqual([]);
  });
});

describe("EvalLiveChatPanel is ungraded (no runner in the path)", () => {
  it("does not import the eval runner / grading API", () => {
    const src = readFileSync(
      resolve(
        process.cwd(),
        "client/src/components/evals/eval-live-chat-panel.tsx",
      ),
      "utf8",
    );
    // The live Record panel uses the chat engine only — grading lives in the
    // eval runner (`streamEvalTestCase` / `evals-api`), which must never be in
    // this path. If this fails, recording a click could trigger a graded run.
    expect(src).not.toMatch(/streamEvalTestCase/);
    expect(src).not.toMatch(/evals-api/);
    expect(src).not.toMatch(/executeTestCase/);
  });
});
