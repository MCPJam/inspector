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

  it("tells the agent to keep the code of a kept code round, in order with the mock rounds", () => {
    const prompt = climbPrompt({
      serverName: "Echo",
      kept: [round(1), round(2, { changes: [], code: { serverId: "srv_2", serverName: "Echo (fast branch)" } }), round(3, { changes: [], code: { serverId: "srv_3" } })],
    });
    expect(prompt).toContain("2. Round 2\n- Ran Echo (fast branch), a saved server that runs your own code. Keep that code: merge the branch it runs.");
    expect(prompt).toContain("3. Round 3\n- Ran the saved server srv_3, a saved server that runs your own code.");
    expect(prompt).toContain("1. Round 1\n- Changed the description");
    expect(prompt).toContain("For mock edits, it checks the server's listing");
    expect(prompt).toContain("For a code change, it runs the server alone and sets its numbers beside the ones the climb recorded.");
  });

  it("names only what verification does for the kinds of change that are kept", () => {
    const onlyCode = climbPrompt({ serverName: "Echo", kept: [round(1, { changes: [], code: { serverId: "srv_2" } })] });
    expect(onlyCode).not.toContain("mock edits");
    expect(onlyCode).toContain("For a code change");
    expect(climbPrompt({ serverName: "Echo", kept: [round(1)] })).not.toContain("For a code change");
  });
});
