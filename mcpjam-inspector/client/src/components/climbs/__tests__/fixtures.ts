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
