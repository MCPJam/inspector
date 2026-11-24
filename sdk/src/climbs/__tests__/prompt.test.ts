import { describe, expect, it } from "vitest";
import { climbPrompt } from "../prompt.js";
import type { KeptRound } from "../types.js";

const round = (number: number, over: Partial<KeptRound> = {}): KeptRound => ({
  number,
  overruled: false,
  changes: [
    {
      target: "tool",
      name: "search",
      kind: "changed",
      summary: 'Changed the description of "search"',
      details: [{ path: "description", kind: "changed", before: "Find things.", after: "Search the index by keyword.", summary: 'Changed the description of "search"' }],
    },
  ],
  ...over,
});

describe("climbPrompt", () => {
  it("lists the changes that also helped on validation first, then the rest in round order", () => {
    const prompt = climbPrompt({
      serverName: "Echo",
      kept: [round(1, { validation: "unchanged" }), round(2, { validation: "better" }), round(4, { validation: "unchanged" }), round(3, { validation: "better" })],
    });
    const order = [...prompt.matchAll(/^\d+\. Round (\d+)/gm)].map((match) => Number(match[1]));
    expect(order).toEqual([2, 3, 1, 4]);
    expect(prompt).toContain("1. Round 2 (also better on validation cases)");
    expect(prompt).toContain("3. Round 1 (validation cases did not move)");
  });

  it("gives each change's old and new value so the edit can be made without reading the mock", () => {
    const prompt = climbPrompt({ serverName: "Echo", kept: [round(1)] });
    expect(prompt).toContain('- Changed the description of "search" (description of the tool "search")');
    expect(prompt).toContain("Was: Find things.");
    expect(prompt).toContain("Now: Search the index by keyword.");
    expect(prompt).toContain("call verify_climb with the commit");
  });

  it("marks a round kept by an overrule, and cuts a very long value", () => {
    const long = "x".repeat(5000);
    const prompt = climbPrompt({
      serverName: "Echo",
      kept: [round(1, { overruled: true, changes: [{ target: "server", kind: "changed", summary: "s", details: [{ path: "instructions", kind: "changed", before: "a", after: long, summary: "Changed the instructions" }] }] })],
    });
    expect(prompt).toContain("(kept by an overrule)");
    expect(prompt).toContain("(cut at 4000 characters)");
    expect(prompt).not.toContain("x".repeat(4001));
  });

  it("says there is nothing to apply when no round stands", () => {
    expect(climbPrompt({ serverName: "Echo", kept: [] })).toBe("No round of this climb stands as kept, so there is nothing to apply to Echo.");
  });
});
