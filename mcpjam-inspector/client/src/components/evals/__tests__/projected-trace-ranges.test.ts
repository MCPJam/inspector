import { describe, expect, it } from "vitest";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { projectChatTraceRanges } from "../projected-trace-ranges";

describe("projected chat trace ranges", () => {
  it("keeps approved calls attached to their IDs after assistant segments merge", () => {
    const spans: EvalTraceSpan[] = [
      { id: "call", category: "tool", name: "record_write", toolCallId: "allowed", startMs: 0, endMs: 1, promptIndex: 0, messageStartIndex: 4, messageEndIndex: 4 },
      { id: "answer", category: "llm", name: "model", startMs: 1, endMs: 2, promptIndex: 0, messageStartIndex: 5, messageEndIndex: 5 },
      { id: "legacy", category: "tool", name: "record_write", startMs: 2, endMs: 3, promptIndex: 0, messageStartIndex: 5 },
    ];
    const result = projectChatTraceRanges(spans, [
      { role: "user", content: "Write allowed" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "allowed" }, { type: "text", text: "Recorded" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "allowed", output: "Recorded" }] },
      { role: "user", content: "Write denied" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "denied" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "denied", output: "Denied" }] },
    ]);
    expect(result.userIndices).toEqual([0, 3]);
    expect(result.spans[0]).toMatchObject({ messageStartIndex: 1, messageEndIndex: 2 });
    for (const span of result.spans.slice(1)) {
      expect(span.messageStartIndex).toBeUndefined();
      expect(span.messageEndIndex).toBeUndefined();
    }
    expect(spans[0].messageStartIndex).toBe(4);
  });
});
