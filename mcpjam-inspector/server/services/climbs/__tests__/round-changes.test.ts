import { describe, expect, it } from "vitest";
import { keptRoundsOf, loadRoundChanges } from "../round-changes.js";
import { fakeConvex } from "./helpers.js";

const round = (number: number, serverId: string, standing: string, extra = {}) => ({
  number,
  status: "settled",
  serverId,
  serverVersion: "1",
  submittedBy: "u",
  submittedVia: "mcp",
  openedAt: 1,
  verdict: standing,
  standing,
  reasons: [],
  ...extra,
});

const definitions: Record<string, object> = {
  m1: { tools: { search: { description: "A" } } },
  m2: { tools: { search: { description: "A" }, fetch: { description: "B" } } },
  m3: { tools: { search: { description: "C" } } },
};
const convex = () =>
  fakeConvex({ "mockServers:getMock": (args) => ({ definitionJson: JSON.stringify(definitions[args.mockId] ?? {}) }) }).convex;

describe("loadRoundChanges", () => {
  it("gives each round's change against the best that stood before it", async () => {
    const changes = await loadRoundChanges(convex(), {
      best: undefined,
      rounds: [round(1, "m1", "kept"), round(2, "m2", "kept"), round(3, "m3", "reverted")] as never,
    });
    expect(changes.map((entry) => [entry.round, entry.standing, entry.changes.map((change) => `${change.kind} ${change.name}`)])).toEqual([
      [1, "kept", ["added search"]],
      [2, "kept", ["added fetch"]],
      // Round 3 changes the description round 1 kept, against a best that holds both rounds.
      [3, "reverted", ["removed fetch", "changed search"]],
    ]);
  });

  it("leaves out a round that is still running and a server that is not a mock", async () => {
    const notAMock = fakeConvex({
      "mockServers:getMock": () => {
        throw Object.assign(new Error("x"), { data: { code: "MOCK_NOT_FOUND" } });
      },
    }).convex;
    expect(await loadRoundChanges(notAMock, { best: undefined, rounds: [round(1, "plain", "kept")] as never })).toEqual([]);
    expect(await loadRoundChanges(convex(), { best: undefined, rounds: [round(1, "m1", "kept", { status: "running" })] as never })).toEqual([]);
  });

  it("follows an overrule: a reverted round overruled to kept becomes the best", async () => {
    const changes = await loadRoundChanges(convex(), {
      best: undefined,
      rounds: [round(1, "m1", "reverted", { standing: "kept" }), round(2, "m2", "kept")] as never,
    });
    expect(changes[1]!.changes.map((change) => `${change.kind} ${change.name}`)).toEqual(["added fetch"]);
  });
});

describe("keptRoundsOf", () => {
  it("pairs the rounds that stand as kept with their change lists", async () => {
    const changes = await loadRoundChanges(convex(), { best: undefined, rounds: [round(1, "m1", "kept")] as never });
    expect(keptRoundsOf(changes, [{ number: 1, validation: "better", overruled: false }, { number: 7, overruled: true }])).toEqual([
      { number: 1, validation: "better", overruled: false, changes: changes[0]!.changes },
      { number: 7, overruled: true, changes: [] },
    ]);
  });
});
