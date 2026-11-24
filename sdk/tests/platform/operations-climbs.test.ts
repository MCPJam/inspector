import { describe, expect, it, vi } from "vitest";
import {
  OPERATION_FEATURES,
  PlatformApiClient,
  getClimbOperation,
  getClimbRoundOperation,
  isFeatureUnavailable,
  isOperationAvailable,
  listClimbsOperation,
  setClimbRoundDecisionOperation,
  startClimbOperation,
  stopClimbOperation,
  submitClimbRoundOperation,
  updateClimbOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const SUITE = { id: "suite-1", name: "Smoke", description: null, projectId: PROJECT.id, createdAt: 1, updatedAt: 2 };
const SERVER = { id: "server-1", name: "Echo", projectId: PROJECT.id, transportType: "http", url: "https://x.test/mcp" };
const ENVIRONMENTS = [
  { id: "env-stg", projectId: PROJECT.id, name: "Staging", hostId: "h", revision: 1, archived: false, createdAt: 1, updatedAt: 2 },
  { id: "env-prod", projectId: PROJECT.id, name: "Prod", hostId: "h", revision: 1, archived: false, createdAt: 1, updatedAt: 2 },
];
const CLIMB = { climbId: "climb-1", suiteId: SUITE.id, state: "baselining", limits: {} };

/** A client whose API answers from `routes` (a Response factory or a body), recording each body. */
function clientWith(routes: Record<string, unknown | (() => Response)>) {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (key.endsWith("/eval-suites")) return Response.json({ items: [SUITE] });
    if (key.endsWith("/servers")) return Response.json({ items: [SERVER] });
    if (key.endsWith("/environments")) return Response.json({ items: ENVIRONMENTS });
    if (key in routes) {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const answer = routes[key];
      return typeof answer === "function" ? (answer as () => Response)() : Response.json(answer);
    }
    throw new Error(`unexpected ${key}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
  return { client, bodies, lastUrl };
}

const CONTEXT = { signal: new AbortController().signal };
const CLIMBS = "/api/v1/projects/project-1/climbs";

describe("start_climb", () => {
  it("resolves names to ids and sends whole basis points", async () => {
    const { client, bodies } = clientWith({ [`POST ${CLIMBS}`]: { ...CLIMB, launch: { unitKey: "baseline:1" } } });
    const result = await startClimbOperation.execute(
      {
        suite: "Smoke",
        server: "echo",
        roundLimit: 3,
        creditLimit: 400,
        environments: ["Staging", "env-prod"],
        measure: "tokens",
        minImprovementPercent: 1.5,
        targetPercent: 5,
        groups: { steering: ["a", "b"], validation: ["c"] },
        seed: 7,
      },
      { client, ...CONTEXT }
    );
    expect(bodies).toEqual([
      {
        suiteId: "suite-1",
        serverId: "server-1",
        roundLimit: 3,
        creditLimit: 400,
        environmentIds: ["env-stg", "env-prod"],
        measure: "tokens",
        minImprovementBps: 150,
        targetBps: 500,
        groupLists: { steering: ["a", "b"], validation: ["c"] },
        seed: 7,
      },
    ]);
    expect(result).toMatchObject({ climbId: "climb-1", project: { id: "project-1" } });
  });

  it("omits what the caller did not choose, so the backend's defaults stand", async () => {
    const { client, bodies } = clientWith({ [`POST ${CLIMBS}`]: CLIMB });
    await startClimbOperation.execute({ suite: "suite-1", server: "server-1", roundLimit: 1, creditLimit: 10 }, { client, ...CONTEXT });
    expect(bodies).toEqual([{ suiteId: "suite-1", serverId: "server-1", roundLimit: 1, creditLimit: 10 }]);
  });

  it("requires both limits and takes sizes or lists, not both", () => {
    const parse = (input: object) => startClimbOperation.inputSchema.safeParse({ suite: "s", server: "x", ...input }).success;
    expect(parse({ roundLimit: 1, creditLimit: 5 })).toBe(true);
    expect(parse({ creditLimit: 5 })).toBe(false);
    expect(parse({ roundLimit: 1 })).toBe(false);
    expect(parse({ roundLimit: 0, creditLimit: 5 })).toBe(false);
    expect(parse({ roundLimit: 1, creditLimit: 0 })).toBe(false);
    expect(parse({ roundLimit: 1, creditLimit: 5, groupSizes: { steering: 1 }, groups: { steering: ["a"] } })).toBe(false);
    expect(parse({ roundLimit: 1, creditLimit: 5, targetPercent: 100 })).toBe(false);
  });

  it("names the environment it could not find, before any request to start", async () => {
    const { client, bodies } = clientWith({});
    await expect(
      startClimbOperation.execute({ suite: "Smoke", server: "Echo", roundLimit: 1, creditLimit: 5, environments: ["Nope"] }, { client, ...CONTEXT })
    ).rejects.toThrow(/Environment "Nope" was not found/);
    expect(bodies).toEqual([]);
  });

  it("answers FEATURE_UNAVAILABLE when the flag is off", async () => {
    const { client } = clientWith({
      [`POST ${CLIMBS}`]: () =>
        Response.json(
          { code: "FORBIDDEN", message: "Climbs are not available.", details: { code: "FEATURE_UNAVAILABLE", feature: "climbs" } },
          { status: 403 }
        ),
    });
    const error = await startClimbOperation
      .execute({ suite: "Smoke", server: "Echo", roundLimit: 1, creditLimit: 5 }, { client, ...CONTEXT })
      .catch((e) => e);
    expect(isFeatureUnavailable(error)).toBe(true);
  });

  it("passes a permission refusal through with the backend's words", async () => {
    const { client } = clientWith({
      [`POST ${CLIMBS}`]: () =>
        Response.json({ code: "FORBIDDEN", message: "Your role cannot start climbs on this suite." }, { status: 403 }),
    });
    await expect(
      startClimbOperation.execute({ suite: "Smoke", server: "Echo", roundLimit: 1, creditLimit: 5 }, { client, ...CONTEXT })
    ).rejects.toThrow("Your role cannot start climbs on this suite.");
  });
});

describe("update_climb, get_climb and list_climbs", () => {
  it("converts percents, clears a target with null, and refuses an update that changes nothing", async () => {
    const { client, bodies } = clientWith({ [`PATCH ${CLIMBS}/climb-1`]: CLIMB });
    await updateClimbOperation.execute({ climb: "climb-1", targetPercent: null, minImprovementPercent: 2 }, { client, ...CONTEXT });
    expect(bodies).toEqual([{ targetBps: null, minImprovementBps: 200 }]);
    await expect(updateClimbOperation.execute({ climb: "climb-1" }, { client, ...CONTEXT })).rejects.toThrow(/Nothing to change/);
  });

  it("reads one climb and lists a suite's climbs", async () => {
    const { client, lastUrl } = clientWith({
      [`GET ${CLIMBS}/climb-1`]: CLIMB,
      [`GET ${CLIMBS}`]: { items: [{ climbId: "climb-1", suiteId: "suite-1" }] },
    });
    expect(await getClimbOperation.execute({ climb: "climb-1" }, { client, ...CONTEXT })).toMatchObject({ climbId: "climb-1" });
    const list = await listClimbsOperation.execute({ suite: "Smoke", limit: 5 }, { client, ...CONTEXT });
    expect(lastUrl().searchParams.get("suiteId")).toBe("suite-1");
    expect(lastUrl().searchParams.get("limit")).toBe("5");
    expect(list.items).toHaveLength(1);
  });

  it("declares what each costs and puts every one behind climbs", () => {
    expect(startClimbOperation).toMatchObject({ readOnly: false, risk: "spend" });
    expect(updateClimbOperation).toMatchObject({ readOnly: false, risk: "none" });
    expect(getClimbOperation.readOnly).toBe(true);
    expect(listClimbsOperation.readOnly).toBe(true);
    for (const name of ["start_climb", "update_climb", "get_climb", "list_climbs"]) {
      expect(OPERATION_FEATURES[name]).toBe("climbs");
      expect(isOperationAvailable(name, {})).toBe(false);
      expect(isOperationAvailable(name, { climbs: true })).toBe(true);
    }
  });
});

describe("round operations", () => {
  const ROUND = { climbId: "climb-1", suiteId: "suite-1", number: 2, status: "settled", settled: true };

  it("submits a saved server by name and sends the retry handle", async () => {
    const { client, bodies } = clientWith({ [`POST ${CLIMBS}/climb-1/rounds`]: { climbId: "climb-1", suiteId: "suite-1", roundNumber: 2 } });
    const result = await submitClimbRoundOperation.execute(
      { climb: "climb-1", server: "echo", serverVersion: "3", idempotencyKey: "k" },
      { client, ...CONTEXT }
    );
    expect(bodies).toEqual([{ serverId: "server-1", serverVersion: "3", idempotencyKey: "k" }]);
    expect(result).toMatchObject({ roundNumber: 2, project: { id: "project-1" } });
  });

  it("reads a round, passing the wait the caller asked for", async () => {
    const { client, lastUrl } = clientWith({ [`GET ${CLIMBS}/climb-1/rounds/2`]: ROUND });
    const round = await getClimbRoundOperation.execute({ climb: "climb-1", round: 2, waitSeconds: 20 }, { client, ...CONTEXT });
    expect(lastUrl().pathname).toBe(`${CLIMBS}/climb-1/rounds/2`);
    expect(lastUrl().searchParams.get("wait")).toBe("20");
    expect(round.settled).toBe(true);
  });

  it("bounds the wait, so no call outlives what a surface allows", () => {
    const parse = (waitSeconds: number) => getClimbRoundOperation.inputSchema.safeParse({ climb: "c", round: 1, waitSeconds }).success;
    expect(parse(50)).toBe(true);
    expect(parse(51)).toBe(false);
    expect(parse(-1)).toBe(false);
  });

  it("overrules a round with a reason and stops a climb", async () => {
    const { client, bodies } = clientWith({
      [`POST ${CLIMBS}/climb-1/rounds/2/decision`]: { climbId: "climb-1", suiteId: "suite-1", round: ROUND, best: { roundNumber: 0 } },
      [`POST ${CLIMBS}/climb-1/stop`]: { climbId: "climb-1", suiteId: "suite-1", state: "stopped", kept: [] },
    });
    await setClimbRoundDecisionOperation.execute({ climb: "climb-1", round: 2, decision: "kept", reason: "Flaky case." }, { client, ...CONTEXT });
    expect(bodies).toEqual([{ decision: "kept", reason: "Flaky case." }]);
    expect(await stopClimbOperation.execute({ climb: "climb-1" }, { client, ...CONTEXT })).toMatchObject({ state: "stopped" });
  });

  it("requires a reason of at most 500 characters to overrule", () => {
    const parse = (reason: string) =>
      setClimbRoundDecisionOperation.inputSchema.safeParse({ climb: "c", round: 1, decision: "kept", reason }).success;
    expect(parse("because")).toBe(true);
    expect(parse("")).toBe(false);
    expect(parse("x".repeat(501))).toBe(false);
  });

  it("declares what each costs and puts every one behind climbs", () => {
    expect(submitClimbRoundOperation).toMatchObject({ readOnly: false, risk: "spend" });
    expect(setClimbRoundDecisionOperation).toMatchObject({ readOnly: false, risk: "none" });
    expect(stopClimbOperation).toMatchObject({ readOnly: false, risk: "destructive" });
    expect(getClimbRoundOperation.readOnly).toBe(true);
    for (const name of ["submit_climb_round", "get_climb_round", "set_climb_round_decision", "stop_climb"]) {
      expect(OPERATION_FEATURES[name]).toBe("climbs");
    }
  });

  it("answers FEATURE_UNAVAILABLE for a round when the flag is off", async () => {
    const { client } = clientWith({
      [`POST ${CLIMBS}/climb-1/rounds`]: () =>
        Response.json({ code: "FORBIDDEN", message: "Climbs are not available.", details: { code: "FEATURE_UNAVAILABLE", feature: "climbs" } }, { status: 403 }),
    });
    const error = await submitClimbRoundOperation.execute({ climb: "climb-1", server: "echo" }, { client, ...CONTEXT }).catch((e) => e);
    expect(isFeatureUnavailable(error)).toBe(true);
  });
});
