import { describe, expect, it } from "vitest";
import {
  formatMockCalls,
  mockAnswerSpan,
  observeMockAnswered,
  MOCK_CALLS_HEADER,
  parseMockCalls,
  withMockAnswerSink,
} from "../answer-marks.js";
import { mockAnswerOf } from "../../../../shared/mock-answer-span.js";
import type { MockCallMark } from "../../../../shared/mock-answer-span.js";

const marks: MockCallMark[] = [
  { mockId: "m1", version: 3, tool: "a,b=c", source: "saved" },
  { mockId: "m1", version: 3, tool: "find", source: "forwarded", realServerId: "s1", realTool: "search" },
  { mockId: "m1", version: 3, tool: "x", source: "blocked", realTool: "x", refusal: "blocked_by_policy" },
  { mockId: "m1", version: 3, tool: "counter", source: "state" },
  { mockId: "m1", version: 3, tool: "echo", source: "saved", caseIndex: 1 },
  { mockId: "m1", version: 3, tool: "echo", source: "saved", caseIndex: 0, catchAll: true },
];

describe("mock call marks", () => {
  it("round trip through a header, even for names with commas and equals signs", () => {
    expect(parseMockCalls(formatMockCalls(marks))).toEqual(marks);
  });

  it("leave out an entry that does not parse", () => {
    expect(parseMockCalls("garbage,m=1&v=x&t=a&s=saved,m=1&v=1&t=a&s=model")).toEqual([]);
    expect(parseMockCalls(null)).toEqual([]);
  });

  it("go from a response to the running tool call and nowhere else", async () => {
    const fetchWith = observeMockAnswered(
      (async () => new Response("{}", { headers: { [MOCK_CALLS_HEADER]: formatMockCalls(marks) } })) as typeof fetch,
    );
    const seen: MockCallMark[] = [];
    await withMockAnswerSink((m) => seen.push(...m), () => fetchWith("http://x"));
    await fetchWith("http://x");
    expect(seen).toEqual(marks);
  });

  it("become a span under the tool call that says what happened", () => {
    const span = mockAnswerSpan(marks.slice(1, 2), { id: "mock-1", parentId: "tool-1", startMs: 1, endMs: 2 });
    expect(span.toolName).toBeUndefined();
    const tool = { id: "tool-1" } as never;
    expect(mockAnswerOf(tool, [span])).toBe("forwarded to search on server s1 (mock m1, version 3)");
    const state = mockAnswerSpan(marks.slice(3, 4), { id: "mock-2", parentId: "tool-2", startMs: 1, endMs: 2 });
    expect(mockAnswerOf({ id: "tool-2" } as never, [state])).toBe("its records (mock m1, version 3)");
  });

  it("say which saved case answered, and flag a catch-all", () => {
    const text = (i: number) =>
      mockAnswerOf(
        { id: "t" } as never,
        [mockAnswerSpan(marks.slice(i, i + 1), { id: "s", parentId: "t", startMs: 1, endMs: 2 })],
      );
    expect(text(0)).toBe("its saved answer (mock m1, version 3)");
    expect(text(4)).toBe("its saved answer (case 2) (mock m1, version 3)");
    expect(text(5)).toBe("its catch-all answer (case 1, which matches any input) (mock m1, version 3)");
  });

  it("carry the case and catch-all flag on the header, and ignore a bad case number", () => {
    expect(formatMockCalls(marks.slice(5))).toContain("c=0&a=1");
    expect(parseMockCalls("m=m1&v=1&t=a&s=saved&c=-1&a=0")).toEqual([
      { mockId: "m1", version: 1, tool: "a", source: "saved" },
    ]);
  });
});
