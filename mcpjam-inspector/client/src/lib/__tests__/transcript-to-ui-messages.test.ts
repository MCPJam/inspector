import { describe, expect, it } from "vitest";
import { transcriptToUIMessages } from "../transcript-to-ui-messages";

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

  it("skips tool role messages", () => {
    const transcript = [
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          { type: "tool-call", toolName: "search", args: { q: "cats" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", result: { results: [] } }],
      },
      { role: "assistant", content: "No results found." },
    ];

    const messages = transcriptToUIMessages(transcript);
    expect(messages).toHaveLength(3); // user, assistant, assistant (no tool)
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
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
