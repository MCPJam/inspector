import { describe, expect, it, vi } from "vitest";
import { loadBaselineEvidence } from "../evidence.js";
import { readClimbInFull } from "../read-climb.js";
import { CLIMB, SUITE } from "./helpers.js";
import { REAL_SERVER, climbBackend, climbRow, fakeClient, iteration } from "./climb-fixtures.js";

const ORIGIN = "https://app.test";
const scope = (listed: string[] = ["search", "fetch"]) => ({ projectId: "proj1", appOrigin: ORIGIN, listedTools: new Set(listed) });

function deps(iterations: any[], backend = climbBackend(), readServer: any = async () => REAL_SERVER) {
  return {
    convex: backend.convex,
    client: fakeClient(iterations),
    hashListing: vi.fn(async () => "h"),
    readServer: vi.fn(readServer),
    appOrigin: ORIGIN,
  };
}

describe("loadBaselineEvidence", () => {
  it("reads only steering cases and gives each iteration its page", async () => {
    const d = deps([
      iteration("it1", "search-basic"),
      iteration("it2", "validation-only-case"),
      iteration("it3", "fetch-one", { result: "passed", firstFailedStage: undefined, failureCategory: undefined, stageResults: [] }),
      iteration("it4", "search-basic", { infraError: { layer: "model" } }),
    ]);
    const { evidence, available } = await loadBaselineEvidence(d, climbRow() as never, scope());
    expect(available).toBe(true);
    expect(evidence.map((item) => [item.iterationId, item.outcome, item.tool])).toEqual([
      ["it1", "failed", "search"],
      ["it3", "passed", "fetch"],
      ["it4", "lost", "search"],
    ]);
    expect(evidence[0]).toMatchObject({
      environmentId: "env_a",
      runId: "run_a",
      failedStage: { stage: "selection", reason: "missingToolCall" },
      failureCategory: "selection",
      link: `${ORIGIN}/evaluate/suite/${SUITE}/runs/run_a?iteration=it1&project=proj1`,
    });
    expect(JSON.stringify(evidence)).not.toContain("validation-only-case");
  });

  it("finds the steering cases of a suite built over REST, whose keys are generated and iterations carry only the stored row id", async () => {
    const d = deps(
      Array.from({ length: 20 }, (_, index) =>
        iteration(`it${index}`, "ui_Aof40t4hiL", index < 18 ? { result: "passed", firstFailedStage: undefined, failureCategory: undefined, stageResults: [] } : {}),
      ),
    );
    const row = climbRow({ groups: { ...climbRow().groups, steeringCases: [{ key: "ui_Aof40t4hiL", tool: "no_tools" }] } });
    const { evidence } = await loadBaselineEvidence(d, row as never, scope());
    expect(evidence).toHaveLength(20);
    expect(evidence.filter((item) => item.outcome === "passed")).toHaveLength(18);
    const read = await readClimbInFull(d, row as never);
    expect(read.climbFor!.find((option) => option.id === "tokens")!.number).toMatchObject({ value: 1000, unit: "tokens" });
    expect(read.climbFor!.find((option) => option.id === "pass_rate")!.failedRuns).toHaveLength(2);
  });

  it("marks a tool a case expects that the server no longer lists", async () => {
    const d = deps([iteration("it1", "search-basic")]);
    const { evidence } = await loadBaselineEvidence(d, climbRow() as never, scope(["fetch"]));
    expect(evidence[0]!.expectedToolNotListed).toBe(true);
  });

  it("reads past the first page", async () => {
    const d = deps([iteration("a", "search-basic"), iteration("b", "fetch-one")]);
    d.client.listEvalRunIterations = vi
      .fn()
      .mockResolvedValueOnce({ items: [iteration("a", "search-basic")], nextCursor: "c2" })
      .mockResolvedValueOnce({ items: [iteration("b", "fetch-one")] }) as never;
    const { evidence } = await loadBaselineEvidence(d, climbRow() as never, scope());
    expect(evidence.map((item) => item.iterationId)).toEqual(["a", "b"]);
  });

  it("reports that failed runs are not available when the backend cannot say which runs the baseline made", async () => {
    const backend = climbBackend({
      "climbs:getClimbRunGroups": () => {
        throw new Error("Could not find public function for 'climbs:getClimbRunGroups'");
      },
    });
    expect(await loadBaselineEvidence(deps([], backend), climbRow() as never, scope())).toEqual({ evidence: [], available: false });
  });
});

describe("readClimbInFull", () => {
  it("adds the suite check, what to climb for with failed runs, and the ranked list of what can change", async () => {
    const d = deps([
      iteration("it1", "search-basic"),
      iteration("it2", "fetch-one", { failureCategory: "arguments", firstFailedStage: "call", stageResults: [{ stage: "call", state: "failed", reason: "argumentMismatch" }] }),
    ]);
    const read = await readClimbInFull(d, climbRow() as never);
    expect(read.suiteCheck).toMatchObject({ ready: true, canShowChange: true });
    expect(read.climbFor![0]).toMatchObject({ id: "pass_rate", number: { value: 2 } });
    expect(read.climbFor!.find((option) => option.id === "tool_descriptions")!.failedRuns[0]).toMatchObject({
      caseKey: "search-basic",
      reason: expect.stringContaining("Failed at Selection"),
    });
    expect(read.whatCanChange![0]).toMatchObject({ where: { mockPath: "tools.search.description" }, failedIterations: 1, current: "Find things." });
    expect(read.notes).toEqual([]);
    // MCPJam's own loop ignores a title: it sorts below what a client reads.
    const title = read.whatCanChange!.find((entry) => entry.where.mockPath === "tools.search.title")!;
    expect(title.readByAnyClient).toBe(false);
  });

  it("is not ready, and reads nothing else, before the baseline settles", async () => {
    const backend = climbBackend();
    const d = deps([]);
    const read = await readClimbInFull({ ...d, convex: backend.convex }, climbRow({ baseline: undefined, state: "baselining" }) as never);
    expect(read.suiteCheck.ready).toBe(false);
    expect(read.climbFor).toBeUndefined();
    expect(d.readServer).not.toHaveBeenCalled();
    expect(read.notes[0]).toContain("baseline has not settled");
  });

  it("still answers when the real server cannot be read, and says so", async () => {
    const d = deps([iteration("it1", "search-basic")], climbBackend(), async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:443");
    });
    const read = await readClimbInFull(d, climbRow() as never);
    expect(read.whatCanChange).toBeUndefined();
    expect(read.climbFor).toBeDefined();
    expect(read.notes.join(" ")).toContain("could not read the real server");
    // The cause names an address: it stays in the log, not in the answer.
    expect(JSON.stringify(read)).not.toContain("10.0.0.5");
  });

  it("says no failed runs are shown on a backend that cannot return the baseline's runs", async () => {
    const backend = climbBackend({
      "climbs:getClimbRunGroups": () => {
        throw new Error("Could not find public function for 'climbs:getClimbRunGroups'");
      },
    });
    const read = await readClimbInFull(deps([], backend), climbRow() as never);
    expect(read.notes.join(" ")).toContain("no failed runs are shown");
    expect(read.climbFor!.every((option) => option.failedRuns.length === 0)).toBe(true);
  });

  it("lists what a climb tried at each place", async () => {
    const backend = climbBackend({
      "mockServers:getMock": (args) => ({
        definitionJson: JSON.stringify(args.mockId === "s_baseline" ? {} : { tools: { search: { description: "Search the index." } } }),
      }),
    });
    const read = await readClimbInFull(
      deps([], backend),
      climbRow({ rounds: [{ number: 1, status: "settled", serverId: "s_round", serverVersion: "2", verdict: "reverted", standing: "reverted", reasons: [] }] }) as never,
    );
    expect(read.whatCanChange!.find((entry) => entry.where.mockPath === "tools.search.description")!.tried).toEqual([
      { round: 1, verdict: "reverted" },
    ]);
  });
});
