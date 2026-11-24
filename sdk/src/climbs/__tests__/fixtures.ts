import type { PlatformClimb } from "../../platform/climb-types.js";
import type { ClimbEvidence } from "../types.js";

const group = (over: Record<string, unknown> = {}) => ({
  counted: 12,
  passed: 9,
  lost: 0,
  passRateBps: [7500, 7500] as [number, number],
  passRateNoiseBps: 833,
  tokensNoiseBps: 40,
  smallestChangeBps: { pass_rate: 833, tokens: 100, cost: 100, tool_calls: 100 },
  ...over,
});

/** A climb whose baseline has settled in two environments. */
export function climb(over: Partial<PlatformClimb> = {}): PlatformClimb {
  return {
    climbId: "climb-1",
    suiteId: "suite-1",
    projectId: "project-1",
    serverId: "server-1",
    serverName: "Echo",
    environmentIds: ["env-a", "env-b"],
    picker: "agent",
    state: "ready",
    measure: "pass_rate",
    measureLocked: false,
    minImprovementBps: 100,
    limits: { roundLimit: 3, roundsStarted: 0, roundsLeft: 3, creditLimit: 500, creditsCommitted: 60, creditsLeft: 440 },
    groups: { steering: 6, validation: 3, confirmation: 3, steeringCases: [], steeringToolsWithoutValidation: [] },
    baseline: {
      settledAt: 1,
      environments: [
        {
          environmentId: "env-a",
          recorded: { tokens: true, cost: true, tool_calls: true },
          noRoomToImprove: false,
          flippedSteeringCaseKeys: ["search-empty"],
          flippedValidationCount: 1,
          lostIterations: 0,
          countedIterations: 24,
          steering: group(),
          validation: group({ counted: 6, passed: 6 }),
        },
        {
          environmentId: "env-b",
          recorded: { tokens: true, cost: false, tool_calls: true },
          noRoomToImprove: false,
          flippedSteeringCaseKeys: [],
          flippedValidationCount: 0,
          lostIterations: 2,
          countedIterations: 22,
          steering: group({ smallestChangeBps: { pass_rate: 833, tokens: 100, tool_calls: 100 } }),
        },
      ],
    },
    best: { serverId: "mock-0", roundNumber: 0 },
    rounds: [],
    confirmationCasesUsedBy: [],
    verifications: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

export function evidence(over: Partial<ClimbEvidence> = {}): ClimbEvidence {
  return {
    runId: "run-1",
    iterationId: "it-1",
    environmentId: "env-a",
    caseKey: "search-basic",
    tool: "search",
    outcome: "failed",
    failedStage: { stage: "selection", reason: "missingToolCall" },
    failureCategory: "selection",
    link: "https://app.test/evaluate/suite/suite-1/runs/run-1?iteration=it-1",
    ...over,
  };
}
