import { describe, expect, it, vi } from "vitest";
import { verifyClimb } from "../verify-climb.js";
import { runGroupIdFor } from "../run-group-id.js";
import { CLIMB, SUITE, fakeConvex, registered, startedReceipt } from "./helpers.js";
import { climbRow } from "./climb-fixtures.js";

const CLIMB_ROW = climbRow({
  state: "stopped",
  createdAt: 1000,
  best: { serverId: "s_best", serverVersion: "3", roundNumber: 2 },
  verifications: [],
}) as never;

const NEW_LISTING = { tools: [{ name: "search", description: "Search the index." }], instructions: "Use the tools." };
const OLD_LISTING = { tools: [{ name: "search", description: "Find things." }], instructions: "Use the tools." };

const group = (role: string) => {
  const idempotencyKey = `climb:${CLIMB}:verification:1:${role}`;
  return { ...registered(role, { serverId: role === "server" ? "m_server" : "m_restore" }), idempotencyKey, runGroupId: runGroupIdFor(SUITE, idempotencyKey) };
};

function setup(over: { listing?: object; revisions?: boolean; best?: object; handlers?: Record<string, (a: any) => unknown> } = {}) {
  const groups = [group("server"), group("restore")];
  const fake = fakeConvex({
    "climbFinish:planClimbFinish": () => ({ allowed: true, caseIds: ["c1"], environmentIds: ["env_a"], confirmationCasesUsedBy: [] }),
    "mockServers:getMock": () => ({ definitionJson: JSON.stringify(over.best ?? { tools: { search: { description: "Search the index." } } }) }),
    "testSuites:estimateSuiteRunCredits": () => ({ credits: 10, lowerBoundCredits: 8 }),
    "mockServers:createMock": (args) => ({ mockId: args.name.endsWith("restore)") ? "m_restore" : "m_server", version: 1, contentHash: "h" }),
    "climbFinish:beginClimbVerification": () => ({ unitKey: "verification:1", verificationIndex: 1, estimatedCredits: 20, groups }),
    "climbSettle:recordClimbRunLaunch": () => ({}),
    "climbSettle:failClimbUnit": () => ({}),
    "climbs:getClimb": () => ({ ...(CLIMB_ROW as object), verifications: [{ index: 1, unitKey: "verification:1", mode: "paired", status: "settled", verdict: "kept", startedBy: "u", result: { environments: [] } }] }),
    ...over.handlers,
  });
  const createEvalRunGroup = vi.fn(async ({ body }: any) => startedReceipt(groups.find((g) => g.idempotencyKey === body.idempotencyKey)!));
  const cancelEvalRun = vi.fn();
  const revision = { revisionNumber: 4, capturedAt: 500 };
  const deps = {
    convex: fake.convex,
    client: {
      createEvalRunGroup,
      cancelEvalRun,
      listServerRevisions: vi.fn(async () => ({ items: over.revisions === false ? [] : [revision] })),
      getServerRevision: vi.fn(async () => ({ discovery: { instructions: "Use the tools." }, tools: [{ name: "search", description: "Find things." }], droppedFields: [] })),
    } as never,
    hashListing: vi.fn(),
    readServer: vi.fn(async () => over.listing ?? NEW_LISTING),
    appOrigin: "https://app.test",
  };
  return { deps, fake, createEvalRunGroup, cancelEvalRun };
}
const args = { dryRun: false, runAnyway: false, waitSeconds: 0, commit: { sha: "abc", dirty: false } };
const clock = () => ({ now: () => 0, sleep: async () => {} });

describe("verifyClimb", () => {
  it("runs the server and the mock that puts the old values back, both through a mock, and records the commit", async () => {
    const { deps, fake, createEvalRunGroup } = setup();
    const result = await verifyClimb(deps, "proj1", CLIMB_ROW, args, clock());
    expect(result).toMatchObject({ ran: true, mode: "paired", verificationIndex: 1, listingCheck: { allApplied: true } });
    const made = fake.called("mockServers:createMock");
    expect(made.map((m) => [m.baseServerId, JSON.parse(m.definitionJson)])).toEqual([
      ["s_real", {}],
      ["s_real", { tools: { search: { description: "Find things." } } }],
    ]);
    const begin = fake.called("climbFinish:beginClimbVerification")[0]!;
    expect(begin).toMatchObject({ climbId: CLIMB, serverMockId: "m_server", restoreMockId: "m_restore", commitSha: "abc", dirty: false, estimatedCreditsPerGroup: 10 });
    // Masked listings of an unchanged server hash equal, so the pair is comparable.
    expect(begin.serverListingHash).toBe(begin.restoreListingHash);
    expect(createEvalRunGroup).toHaveBeenCalledTimes(2);
    expect(createEvalRunGroup.mock.calls.map(([call]) => call.body.serverReplacements[0].replacementServerId).sort()).toEqual(["m_restore", "m_server"]);
  });

  it("names a change missing and starts no run before the code is changed", async () => {
    const { deps, fake, createEvalRunGroup } = setup({ listing: OLD_LISTING });
    const result = await verifyClimb(deps, "proj1", CLIMB_ROW, args, clock());
    expect(result).toMatchObject({ ran: false, listingCheck: { missing: 1 } });
    expect(result.blockedBecause).toContain("Not applied on the server yet: tools.search.description");
    expect(fake.called("mockServers:createMock")).toEqual([]);
    expect(createEvalRunGroup).not.toHaveBeenCalled();
  });

  it("names a third wording as different and runs it only when asked", async () => {
    const listing = { tools: [{ name: "search", description: "Look things up." }] };
    const blocked = await verifyClimb(setup({ listing }).deps, "proj1", CLIMB_ROW, args, clock());
    expect(blocked).toMatchObject({ ran: false, listingCheck: { different: 1 } });
    const asked = setup({ listing });
    expect(await verifyClimb(asked.deps, "proj1", CLIMB_ROW, { ...args, runAnyway: true }, clock())).toMatchObject({ ran: true });
  });

  it("returns the check and the estimate for a dry run and creates nothing", async () => {
    const { deps, fake } = setup();
    const result = await verifyClimb(deps, "proj1", CLIMB_ROW, { ...args, dryRun: true }, clock());
    expect(result).toMatchObject({ dryRun: true, ran: false, estimate: { groups: 2 } });
    expect(fake.called("mockServers:createMock")).toEqual([]);
    expect(fake.called("climbFinish:beginClimbVerification")).toEqual([]);
  });

  it("runs only the server, and says why, when a kept change cannot be put back", async () => {
    const { deps, fake, createEvalRunGroup } = setup({
      best: { tools: { search: { hidden: true } } },
      listing: { tools: [] },
      handlers: { "climbFinish:beginClimbVerification": () => ({ unitKey: "verification:1", verificationIndex: 1, estimatedCredits: 10, groups: [group("server")] }) },
    });
    const result = await verifyClimb(deps, "proj1", CLIMB_ROW, args, clock());
    expect(result).toMatchObject({ ran: true, mode: "server_only", unrestorable: [{ path: "tools.search.hidden" }], estimate: { groups: 1 } });
    expect(fake.called("mockServers:createMock")).toHaveLength(1);
    expect(fake.called("climbFinish:beginClimbVerification")[0]).not.toHaveProperty("restoreMockId");
    expect(createEvalRunGroup).toHaveBeenCalledTimes(1);
  });

  it("runs the server alone when no capture of the server from before the climb exists", async () => {
    const result = await verifyClimb(setup({ revisions: false }).deps, "proj1", CLIMB_ROW, args, clock());
    expect(result.mode).toBe("server_only");
    expect(result.unrestorable[0]!.why).toContain("No stored capture");
  });

  it("says a kept code change cannot be put back by a mock, and runs the server alone", async () => {
    const notAMock = () => {
      throw Object.assign(new Error("x"), { data: { code: "MOCK_NOT_FOUND" } });
    };
    const { deps, fake, createEvalRunGroup } = setup({
      handlers: {
        "mockServers:getMock": notAMock,
        "climbFinish:beginClimbVerification": () => ({ unitKey: "verification:1", verificationIndex: 1, estimatedCredits: 10, groups: [group("server")] }),
      },
    });
    const result = await verifyClimb(deps, "proj1", CLIMB_ROW, args, clock());
    expect(result).toMatchObject({ ran: true, mode: "server_only", estimate: { groups: 1 } });
    expect(result.unrestorable).toHaveLength(1);
    expect(result.unrestorable[0]!.why).toContain("kept change is code");
    expect(result.unrestorable[0]!.why).not.toContain("No stored capture");
    expect(fake.called("climbFinish:beginClimbVerification")[0]).not.toHaveProperty("restoreMockId");
    expect(createEvalRunGroup).toHaveBeenCalledTimes(1);
  });

  it("verifies another saved server in place of the climbed one", async () => {
    const { deps, fake } = setup();
    await verifyClimb(deps, "proj1", CLIMB_ROW, { ...args, targetServerId: "s_new", serverVersion: "2.0.1" }, clock());
    expect(fake.called("mockServers:createMock").every((made) => made.baseServerId === "s_new")).toBe(true);
    expect(fake.called("climbFinish:beginClimbVerification")[0]).toMatchObject({ targetServerId: "s_new", serverVersion: "2.0.1" });
  });

  it("cancels the first group and says so when the second launch is refused", async () => {
    const { deps, createEvalRunGroup, cancelEvalRun, fake } = setup();
    createEvalRunGroup.mockImplementation(async ({ body }: any) => {
      if (body.idempotencyKey.endsWith("restore")) throw Object.assign(new Error("Too many concurrent eval runs"), { code: "RATE_LIMITED" });
      return startedReceipt(group("server"));
    });
    const error: any = await verifyClimb(deps, "proj1", CLIMB_ROW, args, clock()).catch((e) => e);
    expect(error.message).toContain("The restore run group did not start");
    expect(error.message).toContain("2 runs that had started were cancelled");
    expect(cancelEvalRun).toHaveBeenCalledTimes(2);
    expect(fake.called("climbSettle:failClimbUnit")).toHaveLength(1);
  });

  it("returns the report once the verification settles within the wait", async () => {
    const { deps } = setup();
    const result = await verifyClimb(deps, "proj1", CLIMB_ROW, { ...args, waitSeconds: 10 }, clock());
    expect(result).toMatchObject({ settled: true, report: { holds: true, commit: {} } });
  });

  it("refuses by the backend's code before anything is read or made", async () => {
    const { deps, fake } = setup({
      handlers: { "climbFinish:planClimbFinish": () => ({ allowed: false, refusal: { code: "CLIMB_VERIFICATION_LIMIT_REACHED", message: "This climb has had three verifications." }, caseIds: [], environmentIds: [], confirmationCasesUsedBy: [] }) },
    });
    const error: any = await verifyClimb(deps, "proj1", CLIMB_ROW, args, clock()).catch((e) => e);
    expect(error.details.code).toBe("CLIMB_VERIFICATION_LIMIT_REACHED");
    expect(fake.called("mockServers:createMock")).toEqual([]);
  });
});
