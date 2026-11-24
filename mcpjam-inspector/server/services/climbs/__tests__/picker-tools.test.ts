/**
 * What a picker step may do: the tools it is given, the rule that stands where
 * approval would, and the fence on transcripts.
 */
import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import { buildPickerTools, createPickerRule, PICKER_TOOL_IDS } from "../picker-tools.js";
import { CLIMB, fakeConvex } from "./helpers.js";
import { climbRow } from "./climb-fixtures.js";

const PROJECT = "proj1";
const limits = (over: Record<string, number> = {}) => ({ roundLimit: 5, roundsStarted: 1, roundsLeft: 4, creditLimit: 500, creditsCommitted: 100, creditsLeft: 400, ...over });
const run = (over: Record<string, unknown> = {}) => ({ launchedRunIds: ["run_baseline"], unitKey: "baseline:1", role: "baseline_a", runGroupId: "g", status: "settled", environmentIds: ["env_a"], ...over });

function rig(options: { climb?: Record<string, unknown>; groups?: unknown; iterations?: Array<Record<string, unknown>> } = {}) {
  const { convex, called } = fakeConvex({
    "climbs:getClimb": () => climbRow({ limits: limits(), ...options.climb }),
    "climbs:getClimbRunGroups": () => {
      if (options.groups === null) throw new Error("Could not find public function for 'climbs:getClimbRunGroups'");
      return options.groups ?? [run()];
    },
  });
  const listEvalRunIterations = vi.fn(async () => ({
    items: options.iterations ?? [{ id: "it_steer", caseId: "search-basic" }, { id: "it_valid", caseId: "case_validation" }],
    nextCursor: undefined,
  }));
  const client = { listEvalRunIterations } as never;
  const rule = createPickerRule({ convex, client, projectId: PROJECT, climbId: CLIMB });
  return { rule, called, listEvalRunIterations };
}

describe("the rule that stands where approval would", () => {
  it("lets the reads run, whatever the limits", async () => {
    const { rule } = rig({ climb: { limits: limits({ roundsLeft: 0, creditsLeft: 0 }) } });
    for (const id of ["get_climb", "get_climb_round", "get_mock_server"]) expect(await rule(id, { climb: CLIMB })).toBeUndefined();
  });

  it.each(["create_mock_server", "update_mock_server", "submit_climb_round"])("lets %s run inside the climb's limits", async (id) => {
    const { rule } = rig();
    expect(await rule(id, { climb: CLIMB })).toBeUndefined();
  });

  it.each(["create_mock_server", "update_mock_server", "submit_climb_round"])("refuses %s with the reason once the rounds are used", async (id) => {
    const { rule } = rig({ climb: { limits: limits({ roundsLeft: 0, roundsStarted: 5 }) } });
    expect(await rule(id, {})).toMatch(/used its 5 rounds.*end your turn/);
  });

  it("refuses a write once the credits are used, and on a stopped climb", async () => {
    expect(await rig({ climb: { limits: limits({ creditsLeft: 0 }) } }).rule("submit_climb_round", {})).toMatch(/used its 500 credits/);
    expect(await rig({ climb: { state: "stopped" } }).rule("update_mock_server", {})).toMatch(/has stopped/);
  });

  it("keeps the step on its own climb", async () => {
    expect(await rig().rule("get_climb", { climb: "another" })).toMatch(/one climb/);
  });
});

describe("the fence on transcripts", () => {
  const read = (iterationId: string, runId = "run_baseline") => ({ runId, iterationId });

  it("lets a steering case's iteration be read", async () => {
    expect(await rig().rule("get_eval_iteration_trace", read("it_steer"))).toBeUndefined();
  });

  it("refuses an iteration of a validation or confirmation case, and one it cannot find", async () => {
    const { rule } = rig();
    expect(await rule("get_eval_iteration_trace", read("it_valid"))).toMatch(/steering cases/);
    expect(await rule("get_eval_iteration_trace", read("it_unknown"))).toMatch(/steering cases/);
  });

  it("refuses a run the climb did not launch, before it reads a single iteration", async () => {
    const { rule, listEvalRunIterations } = rig();
    expect(await rule("get_eval_iteration_trace", read("it_steer", "run_elsewhere"))).toMatch(/steering cases/);
    expect(listEvalRunIterations).not.toHaveBeenCalled();
  });

  it("refuses everything when the backend cannot say which runs the climb launched", async () => {
    expect(await rig({ groups: null }).rule("get_eval_iteration_trace", read("it_steer"))).toMatch(/steering cases/);
  });

  it("reads an iteration by the case's key or its id, as the failed runs name them", async () => {
    const { rule } = rig({ iterations: [{ id: "it_a", testCaseId: "fetch-one" }] });
    expect(await rule("get_eval_iteration_trace", read("it_a"))).toBeUndefined();
  });

  it("refuses a call with no ids", async () => {
    expect(await rig().rule("get_eval_iteration_trace", {})).toMatch(/steering cases/);
  });
});

describe("the tools", () => {
  function clientWith(answer: (url: URL, method: string) => unknown) {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new PlatformApiClient({
      baseUrl: "https://api.test/api/v1",
      getAuth: () => "t",
      fetch: (async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json(answer(url, init?.method ?? "GET"));
      }) as unknown as typeof fetch,
    });
    return { client, seen };
  }

  it("are the climb, round, trace and mock operations, and none of them asks a person", () => {
    const { convex } = fakeConvex({});
    const tools = buildPickerTools({ convex, client: clientWith(() => ({})).client, projectId: PROJECT, climbId: CLIMB });
    expect(Object.keys(tools)).toEqual([...PICKER_TOOL_IDS]);
    for (const [id, tool] of Object.entries(tools)) expect((tool as { needsApproval?: unknown }).needsApproval, id).toBe(false);
  });

  it("answer a write outside the limits with the reason, and make no call", async () => {
    const { convex } = fakeConvex({ "climbs:getClimb": () => climbRow({ limits: limits({ roundsLeft: 0 }) }) });
    const { client, seen } = clientWith(() => ({}));
    const tools = buildPickerTools({ convex, client, projectId: PROJECT, climbId: CLIMB });
    const result = await (tools.submit_climb_round as any).execute({ climb: CLIMB, server: "mock" }, { abortSignal: undefined });
    expect(result).toEqual({ error: expect.stringContaining("used its") });
    expect(seen).toEqual([]);
  });

  it("run a read inside the limits through the platform client, as the chat's project", async () => {
    const { convex } = fakeConvex({ "climbs:getClimb": () => climbRow({ limits: limits() }) });
    const { client, seen } = clientWith((url) => (url.pathname.endsWith("/projects") ? { items: [{ id: PROJECT, name: "Acme" }] } : { climbId: CLIMB }));
    const tools = buildPickerTools({ convex, client, projectId: PROJECT, climbId: CLIMB });
    await (tools.get_climb as any).execute({ climb: CLIMB }, { abortSignal: undefined });
    expect(seen.some((call) => call.path === `/api/v1/projects/${PROJECT}/climbs/${CLIMB}`)).toBe(true);
  });
});
