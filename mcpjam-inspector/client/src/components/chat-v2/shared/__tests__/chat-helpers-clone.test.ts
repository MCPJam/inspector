import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { cloneUiMessages } from "../chat-helpers";

describe("cloneUiMessages", () => {
  it("deep-clones so mutations do not affect the source", () => {
    const original: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "a" }],
      },
    ];
    const copy = cloneUiMessages(original);
    expect(copy).not.toBe(original);
    expect(copy[0]).not.toBe(original[0]);
    expect(copy[0]?.parts).not.toBe(original[0]?.parts);
    (copy[0]?.parts[0] as { text?: string }).text = "b";
    expect((original[0]?.parts[0] as { text?: string }).text).toBe("a");
  });
});
