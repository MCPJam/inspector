/** A settled-baseline climb and the fakes a full read of it needs. */
import { vi } from "vitest";
import { CLIMB, SUITE, fakeConvex } from "./helpers.js";

export const baselineGroup = (over: Record<string, unknown> = {}) => ({
  counted: 12,
  passed: 9,
  lost: 0,
  passRateBps: [7500, 7500],
  passRateNoiseBps: 833,
  smallestChangeBps: { pass_rate: 833 },
  ...over,
});

export const climbRow = (over: Record<string, unknown> = {}) => ({
  climbId: CLIMB,
  suiteId: SUITE,
  projectId: "proj1",
  serverId: "s_real",
  serverName: "Echo",
  environmentIds: ["env_a"],
  state: "ready",
  measure: "pass_rate",
  groups: {
    steering: 2,
    validation: 1,
    confirmation: 0,
    steeringCases: [{ key: "search-basic", tool: "search" }, { key: "fetch-one", tool: "fetch" }],
    steeringToolsWithoutValidation: ["fetch"],
  },
  baseline: {
    settledAt: 1,
    environments: [
      {
        environmentId: "env_a",
        recorded: { tokens: true, cost: true, tool_calls: true },
        noRoomToImprove: false,
        flippedSteeringCaseKeys: [],
        flippedValidationCount: 0,
        lostIterations: 0,
        countedIterations: 12,
        steering: baselineGroup(),
      },
    ],
  },
  best: { serverId: "s_baseline", serverVersion: "1", roundNumber: 0 },
  rounds: [],
  verifications: [],
  ...over,
});

export const iteration = (id: string, caseId: string, over: Record<string, unknown> = {}) => ({
  id,
  // A UI-authored case declares no id, so an iteration names it only by its stored row.
  testCaseId: `row-${caseId}`,
  title: `Case ${caseId}`,
  status: "completed",
  result: "failed",
  usage: { totalTokens: 1000 },
  actualToolCalls: [],
  expectedToolCalls: [{ toolName: "search" }],
  stageResults: [{ stage: "selection", state: "failed", reason: "missingToolCall" }],
  firstFailedStage: "selection",
  failureCategory: "selection",
  ...over,
});

export const REAL_SERVER = {
  tools: [
    { name: "search", description: "Find things.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "fetch", description: "Get one.", inputSchema: { type: "object", properties: {} } },
  ],
  serverInfo: { name: "Echo", version: "1" },
  instructions: "Use the tools.",
};

/** The Convex answers a full read of a climb needs, one environment run by MCPJam's own loop. */
export function climbBackend(extra: Record<string, (args: any) => unknown> = {}) {
  return fakeConvex({
    "climbs:getClimbRunGroups": () => [
      { unitKey: "baseline:1", role: "baseline_a", runGroupId: "g", status: "settled", environmentIds: ["env_a"], launchedRunIds: ["run_a"] },
    ],
    "projectEnvironments:resolveEnvironmentForLaunch": () => ({
      environmentRef: { environmentId: "env_a", name: "Staging", revision: 1 },
      hostId: "host_plain",
      selectedServerIds: ["s_real"],
      servers: [{ serverId: "s_real", name: "Echo" }],
    }),
    "hosts:getHost": () => ({ config: { hostStyle: "mcpjam" } }),
    ...extra,
  });
}

export function fakeClient(iterations: any[]) {
  return {
    createEvalRunGroup: vi.fn(),
    cancelEvalRun: vi.fn(),
    getEvalRun: vi.fn(async () => ({ environment: { id: "env_a" } })),
    listEvalRunIterations: vi.fn(async () => ({ items: iterations })),
    // The suite's cases: each row id above belongs to the case key it was built from.
    listEvalCases: vi.fn(async () => ({
      items: [...new Set(iterations.map((entry) => String(entry.testCaseId)))].map((id) => ({ id, key: id.replace(/^row-/, "") })),
    })),
  } as never;
}
