import { describe, expect, it } from "vitest";
import {
  bestSoFarLabel,
  changeTitle,
  roundResult,
  startingVersion,
  submittedByLabel,
} from "../round-model";
import { makeClimb, makeRound } from "./fixtures";

describe("roundResult", () => {
  it("reads the standing verdict, so an overrule wins", () => {
    expect(roundResult(makeRound({ verdict: "kept", standing: "reverted" }))).toBe("reverted");
  });
  it("names a round that is running, not decided, or did not finish", () => {
    expect(roundResult(makeRound({ status: "running", verdict: undefined, standing: undefined }))).toBe("running");
    expect(roundResult(makeRound({ verdict: "not_decided", standing: "not_decided" }))).toBe("undecided");
    expect(roundResult(makeRound({ status: "failed" }))).toBe("failed");
  });
});

describe("submittedByLabel", () => {
  it("says MCPJam when MCPJam picked the change", () => {
    expect(submittedByLabel(makeClimb({ picker: "mcpjam" }), makeRound({ pickedBy: "mcpjam" }))).toBe("MCPJam");
  });
  it("says You for a round from the app, and the agent's name through MCP or the CLI", () => {
    expect(submittedByLabel(makeClimb(), makeRound({ submittedVia: "api" }))).toBe("You");
    expect(submittedByLabel(makeClimb({ picker: "agent" }), makeRound({ submittedVia: "mcp", submittedBy: "Claude Code" }))).toBe("Claude Code");
    expect(submittedByLabel(makeClimb({ picker: "agent" }), makeRound({ submittedVia: "mcp", submittedBy: " " }))).toBe("Your agent");
  });
});

describe("bestSoFarLabel", () => {
  it("lists the kept rounds", () => {
    const rounds = [
      makeRound({ number: 1 }),
      makeRound({ number: 2, standing: "reverted" }),
      makeRound({ number: 3 }),
      makeRound({ number: 4 }),
    ];
    expect(bestSoFarLabel(makeClimb({ rounds: [] }))).toBe("Baseline");
    expect(bestSoFarLabel(makeClimb({ rounds: rounds.slice(0, 1) }))).toBe("Baseline + round 1");
    expect(bestSoFarLabel(makeClimb({ rounds }))).toBe("Baseline + rounds 1, 3 and 4");
  });
});

describe("startingVersion", () => {
  it("starts the first round from the baseline's first version", () => {
    const climb = makeClimb({ rounds: [makeRound({ number: 1, serverVersion: "2" })] });
    expect(startingVersion(climb, climb.rounds[0])).toBe(1);
  });
  it("starts a later round from the last kept round before it, skipping reverted ones", () => {
    const climb = makeClimb({
      rounds: [
        makeRound({ number: 1, serverVersion: "2" }),
        makeRound({ number: 2, serverVersion: "3", standing: "reverted" }),
        makeRound({ number: 3, serverVersion: "4" }),
      ],
    });
    expect(startingVersion(climb, climb.rounds[2])).toBe(2);
  });
  it("makes no comparison across two different mocks", () => {
    const climb = makeClimb({
      rounds: [makeRound({ number: 1 }), makeRound({ number: 2, serverId: "other", serverVersion: "5" })],
    });
    expect(startingVersion(climb, climb.rounds[1])).toBeNull();
  });
  it("makes no comparison for a version it cannot read", () => {
    const climb = makeClimb({ rounds: [makeRound({ serverVersion: undefined })] });
    expect(startingVersion(climb, climb.rounds[0])).toBeNull();
  });
});

describe("changeTitle", () => {
  const change = (summary: string) => ({ target: "tool" as const, kind: "changed" as const, summary, details: [] });
  it("is the first change, with a count of the rest", () => {
    expect(changeTitle([change("Hid the tool \"a\"")], 1)).toBe('Hid the tool "a"');
    expect(changeTitle([change("A"), change("B"), change("C")], 1)).toBe("A, and 2 more changes");
  });
  it("falls back to the round's number", () => {
    expect(changeTitle(undefined, 4)).toBe("Round 4");
    expect(changeTitle(null, 4)).toBe("Round 4");
    expect(changeTitle([], 4)).toBe("Round 4");
  });
});
