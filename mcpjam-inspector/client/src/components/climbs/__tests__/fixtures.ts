import type { Climb, ClimbRoundSummary } from "../climb-types";

export function makeRound(overrides: Partial<ClimbRoundSummary> = {}): ClimbRoundSummary {
  return {
    number: 1,
    status: "settled",
    serverId: "mock_1",
    serverVersion: "2",
    submittedBy: "Casey",
    submittedVia: "api",
    openedAt: 1_700_000_000_000,
    settledAt: 1_700_000_600_000,
    verdict: "kept",
    standing: "kept",
    reasons: [],
    ...overrides,
  };
}

export function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    climbId: "climb_1",
    suiteId: "suite_1",
    projectId: "proj_1",
    serverId: "srv_1",
    serverName: "mcpjam-mcp",
    environmentIds: ["env_a", "env_b"],
    picker: "person",
    state: "ready",
    measure: "pass_rate",
    measureLocked: false,
    minImprovementBps: 100,
    limits: {
      roundLimit: 10,
      roundsStarted: 0,
      roundsLeft: 10,
      creditLimit: 4000,
      creditsCommitted: 200,
      creditsLeft: 3800,
    },
    groups: {
      steering: 6,
      validation: 4,
      confirmation: 0,
      steeringCases: [],
      steeringToolsWithoutValidation: [],
    },
    best: { serverId: "mock_1", serverVersion: "1", roundNumber: 0 },
    rounds: [],
    confirmationCasesUsedBy: [],
    verifications: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

import type { ClimbRoundDetail } from "../climb-types";

const rate = (best: number, candidate: number, move: "better" | "worse" | "none") => ({
  passRate: { bestBps: best, candidateBps: candidate, deltaBps: candidate - best, noiseBps: 560, move },
});

export function makeRoundDetail(overrides: Partial<ClimbRoundDetail> = {}): ClimbRoundDetail {
  return {
    ...makeRound(),
    estimatedCredits: 120,
    remeasuredBest: false,
    againstBest: {},
    validation: "unchanged",
    failedSteeringCaseKeys: [],
    environments: [
      { environmentId: "env_a", candidateLost: 0, bestLost: 0, measureRecorded: true, steering: rate(7800, 9400, "better"), validation: rate(8300, 8300, "none") },
      { environmentId: "env_b", candidateLost: 2, bestLost: 0, measureRecorded: true, steering: rate(10000, 10000, "none"), validation: rate(10000, 10000, "none") },
    ],
    environmentsWithoutMeasure: [],
    reasons: ["measure_better_on_steering"],
    ...overrides,
  };
}

import type { ClimbForOption } from "@mcpjam/sdk/climbs";

export function makeOption(overrides: Partial<ClimbForOption> = {}): ClimbForOption {
  return {
    id: "tool_descriptions",
    label: "Tool descriptions",
    measure: "pass_rate",
    available: true,
    number: { value: 7, unit: "failed_iterations", text: "7 of 13 failed iterations picked the wrong tool" },
    failedRuns: [],
    ...overrides,
  };
}

export const failedRun = (n: number) => ({
  caseKey: `case_${n}`,
  caseTitle: `Counts projects ${n}`,
  environmentId: "env_a",
  runId: `run_${n}`,
  iterationId: `iter_${n}`,
  reason: "Called show_servers, expected list_projects",
  link: "https://app.test/x",
});

export const baselineEnv = (id: string, a: number, b: number) => ({
  environmentId: id,
  recorded: { tokens: true, cost: true, tool_calls: true },
  noRoomToImprove: false,
  flippedSteeringCaseKeys: [],
  flippedValidationCount: 0,
  lostIterations: 0,
  countedIterations: 18,
  steering: { counted: 18, passed: b, lost: 0, passRateBps: [a, b] as [number, number], passRateNoiseBps: 560 },
  validation: { counted: 12, passed: 10, lost: 0, passRateBps: [8300, 8300] as [number, number], passRateNoiseBps: 0 },
});

import type { ClimbSummary } from "@mcpjam/sdk/climbs";

export function makeSummary(overrides: Partial<ClimbSummary> = {}): ClimbSummary {
  return {
    measure: "pass_rate",
    stoppedBecause: "the round limit was reached",
    steering: {
      label: "Steering cases",
      environments: [
        { environmentId: "env_a", baselinePassRateBps: 7800, bestPassRateBps: 9400 },
        { environmentId: "env_b", baselinePassRateBps: 10000, bestPassRateBps: 10000 },
      ],
    },
    validation: {
      label: "Validation cases",
      environments: [
        { environmentId: "env_a", baselinePassRateBps: 8300, bestPassRateBps: 8300 },
        { environmentId: "env_b", baselinePassRateBps: 10000, bestPassRateBps: 10000 },
      ],
    },
    rounds: [],
    confirmation: { status: "not_run", usedByEarlierClimbs: [] },
    established: ["2 rounds improved pass rate."],
    notEstablished: ["Both groups helped pick this result."],
    ...overrides,
  };
}
