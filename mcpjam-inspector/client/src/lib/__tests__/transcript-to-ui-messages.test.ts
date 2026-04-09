import { convertToModelMessages } from "ai";
import { describe, expect, it } from "vitest";
import {
  mergeTranscriptToolResults,
  transcriptToUIMessages,
} from "../transcript-to-ui-messages";

describe("transcriptToUIMessages", () => {
  it("converts basic user/assistant transcript to UIMessages", () => {
    const transcript = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    const messages = transcriptToUIMessages(transcript);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts).toEqual([{ type: "text", text: "Hi there!" }]);
  });

  it("handles array content parts", () => {
    const transcript = [
      {
        role: "user",
        content: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      },
    ];

    const messages = transcriptToUIMessages(transcript);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(2);
    expect(messages[0].parts[0]).toEqual({ type: "text", text: "First" });
    expect(messages[0].parts[1]).toEqual({ type: "text", text: "Second" });
  });

  it("merges role:tool tool-result rows into the matching assistant tool-call", () => {
    const transcript = [
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          {
            type: "tool-call",
            toolCallId: "call-search-1",
            toolName: "search",
            args: { q: "cats" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-search-1",
            result: { results: [] },
          },
        ],
      },
      { role: "assistant", content: "No results found." },
    ];

    const merged = mergeTranscriptToolResults(transcript);
    expect(merged).toHaveLength(3);
    expect((merged[1] as { role?: string }).role).toBe("assistant");
    const assistantContent = (merged[1] as { content: unknown[] }).content;
    const toolCallPart = assistantContent.find(
      (p) => (p as { type?: string }).type === "tool-call",
    ) as { result?: unknown };
    expect(toolCallPart.result).toEqual({ results: [] });

    const messages = transcriptToUIMessages(transcript);
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);

    const toolPart = messages[1].parts.find((p) => p.type === "dynamic-tool") as
      | { type: "dynamic-tool"; toolCallId: string; output: unknown }
      | undefined;
    expect(toolPart).toBeDefined();
    expect(toolPart!.output).toEqual({ results: [] });
  });

  it("merges multiple tool-result parts from one tool message", () => {
    const transcript = [
      { role: "user", content: "run two tools" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "foo",
            args: {},
          },
          {
            type: "tool-call",
            toolCallId: "b",
            toolName: "bar",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "a", output: { x: 1 } },
          { type: "tool-result", toolCallId: "b", output: { y: 2 } },
        ],
      },
      { role: "assistant", content: "done" },
    ];

    const messages = transcriptToUIMessages(transcript);
    const invocations = messages[1].parts.filter((p) => p.type === "dynamic-tool") as Array<{
      toolCallId: string; output: unknown;
    }>;
    expect(invocations).toHaveLength(2);
    expect(invocations[0].output).toEqual({ x: 1 });
    expect(invocations[1].output).toEqual({ y: 2 });
  });

  it("matches tool-call id fallback to tool-result toolCallId", () => {
    const transcript = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "legacy-id",
            toolName: "t",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "legacy-id", result: { ok: true } },
        ],
      },
    ];

    const messages = transcriptToUIMessages(transcript);
    const toolPart = messages[0].parts[0] as {
      type: string;
      output: unknown;
    };
    expect(toolPart.type).toBe("dynamic-tool");
    expect(toolPart.output).toEqual({ ok: true });
  });

  it("merged tool history converts with convertToModelMessages", async () => {
    const transcript = [
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            args: { q: "cats" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            result: { hits: 0 },
          },
        ],
      },
      { role: "assistant", content: "No hits." },
    ];

    const messages = transcriptToUIMessages(transcript);
    const modelMessages = await convertToModelMessages(messages);
    expect(Array.isArray(modelMessages)).toBe(true);
    expect(modelMessages.length).toBeGreaterThanOrEqual(3);
  });

  it("generates IDs when not present", () => {
    const transcript = [{ role: "user", content: "Hi" }];
    const messages = transcriptToUIMessages(transcript);
    expect(messages[0].id).toBeTruthy();
    expect(typeof messages[0].id).toBe("string");
  });

  it("preserves existing IDs", () => {
    const transcript = [{ id: "msg-123", role: "user", content: "Hi" }];
    const messages = transcriptToUIMessages(transcript);
    expect(messages[0].id).toBe("msg-123");
  });

  it("returns empty array for non-array input", () => {
    expect(transcriptToUIMessages(null as any)).toEqual([]);
    expect(transcriptToUIMessages(undefined as any)).toEqual([]);
    expect(transcriptToUIMessages("not an array" as any)).toEqual([]);
  });

  it("handles empty transcript", () => {
    expect(transcriptToUIMessages([])).toEqual([]);
  });

  it("handles string content on messages", () => {
    const transcript = [
      { role: "assistant", content: "Simple string response" },
    ];
    const messages = transcriptToUIMessages(transcript);
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Simple string response" },
    ]);
  });
});
