import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { settleHistoryBatch } from "../suspended-history-settlements.js";

describe("suspended history settlement", () => {
  it("batches independent calls, deduplicates ids, and skips completed calls", async () => {
    const history: ModelMessage[] = [
      {
        role: "assistant",
        content: ["one", "two", "one", "done"].map((id) => ({
          type: "tool-call",
          toolCallId: id,
          toolName: "read",
          input: {},
        })),
      },
    ];
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = settleHistoryBatch(
      history,
      new Set(["done"]),
      async ({ toolCallId }) => {
        started.push(toolCallId);
        if (toolCallId === "one") await gate;
        return toolCallId;
      },
    );
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    release();
    expect([...(await pending)]).toEqual([
      ["one", "one"],
      ["two", "two"],
    ]);
  });
});
