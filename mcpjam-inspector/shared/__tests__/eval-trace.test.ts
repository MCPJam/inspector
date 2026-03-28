import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  appendDedupedModelMessages,
  createOffsetInterval,
  evalTraceBlobV1Z,
  normalizeSpanInterval,
  stepResultHasToolActivity,
} from "../eval-trace";

describe("eval-trace helpers", () => {
  it("normalizeSpanInterval bumps zero-duration to 1ms", () => {
    expect(normalizeSpanInterval(5, 5)).toEqual({ startMs: 5, endMs: 6 });
    expect(normalizeSpanInterval(5, 3)).toEqual({ startMs: 5, endMs: 6 });
    expect(normalizeSpanInterval(5, 8)).toEqual({ startMs: 5, endMs: 8 });
  });

  it("createOffsetInterval uses runner-relative offsets", () => {
    const runStartedAt = 1000;
    expect(
      createOffsetInterval(runStartedAt, 1000, 1050),
    ).toEqual({ startMs: 0, endMs: 50 });
  });

  it("appendDedupedModelMessages dedupes by id and by json", () => {
    const acc: ModelMessage[] = [{ role: "user", content: "hi" }];
    appendDedupedModelMessages(acc, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", id: "m1" } as ModelMessage,
    ]);
    expect(acc).toHaveLength(2);
    appendDedupedModelMessages(acc, [
      { role: "assistant", content: "ok", id: "m1" } as ModelMessage,
    ]);
    expect(acc).toHaveLength(2);
  });

  it("stepResultHasToolActivity detects tool arrays", () => {
    expect(stepResultHasToolActivity({})).toBe(false);
    expect(stepResultHasToolActivity({ toolCalls: [{}] })).toBe(true);
    expect(stepResultHasToolActivity({ dynamicToolResults: [{}] })).toBe(true);
  });

  it("evalTraceBlobV1Z accepts envelope shape", () => {
    const parsed = evalTraceBlobV1Z.parse({
      traceVersion: 1,
      messages: [],
      spans: [
        {
          id: "a",
          name: "Step 1",
          category: "step",
          startMs: 0,
          endMs: 10,
        },
      ],
    });
    expect(parsed.traceVersion).toBe(1);
    expect(parsed.spans).toHaveLength(1);
  });
});
