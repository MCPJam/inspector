import { describe, expect, it } from "vitest";
import { changeCountLabel, changesOf } from "../mock-changes";

describe("changesOf", () => {
  it("lists server-wide settings first, then one entry per item", () => {
    const changes = changesOf({
      instructions: "Be brief.",
      tools: { "lookup.ticket": { description: "x", answer: { from: "saved", cases: [] } } },
      prompts: { triage: { messages: [] } },
    });
    expect(changes).toEqual([
      { kind: "Server", label: "Instructions revised" },
      { kind: "Tool", label: "lookup.ticket", detail: "description, answer" },
      { kind: "Prompt", label: "triage", detail: "messages" },
    ]);
  });

  it("is empty for an empty or unreadable definition", () => {
    expect(changesOf({})).toEqual([]);
    expect(changesOf(null)).toEqual([]);
    expect(changesOf([])).toEqual([]);
  });
});

describe("changeCountLabel", () => {
  it("pluralizes", () => {
    expect(changeCountLabel(0)).toBe("0 changes");
    expect(changeCountLabel(1)).toBe("1 change");
    expect(changeCountLabel(3)).toBe("3 changes");
  });
});
