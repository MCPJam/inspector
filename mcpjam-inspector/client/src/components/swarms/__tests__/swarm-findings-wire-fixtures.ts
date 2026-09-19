/**
 * A controlled shared-findings payload for the swarm Findings tests.
 *
 * The backend owns `sdk/tests/fixtures/swarm-findings-wire.json` and re-syncs
 * it byte-for-byte, so its literals (versions, titles, phrases, ids) can
 * change under these tests at any time. Only the envelope fields come from
 * it; every row a test asserts on is written here.
 */
import {
  swarmJourneyFindingsSchema,
  type SwarmJourneyFinding,
  type SwarmJourneyFindings,
} from "@mcpjam/sdk/contract";
import wire from "../../../../../../sdk/tests/fixtures/swarm-findings-wire.json";

export const WIRE_RUN_ID = "run-reconcile";
export const WIRE_PERSONA = { name: "Ana", personaRefId: null };
export const WIRE_GOAL = {
  runId: WIRE_RUN_ID,
  journeyRefId: "journey-reconcile",
  title: "Reconcile payouts",
};
export const WIRE_MECHANISM_PHRASE = "The requested change was rejected.";
export const WIRE_FIX_PHRASE = "Accept the requested change.";

/** The backend fixture exactly as published, parsed. */
export function publishedWire(): SwarmJourneyFindings {
  return swarmJourneyFindingsSchema.parse(wire);
}

/**
 * One persona, one goal, blocked at the tool response: a verified mechanism
 * (goal-scoped, with a fix) plus a session report.
 */
export function brokenWire(): SwarmJourneyFindings {
  const published = publishedWire();
  const mechanism: SwarmJourneyFinding = {
    id: "mechanism",
    basis: "verifiedMechanism",
    scopeLevel: "goal",
    persona: WIRE_PERSONA,
    goal: WIRE_GOAL,
    target: { kind: "host", id: "host-1", label: "Claude", modelId: null },
    population: { count: 1, total: 1, unit: "sessions" },
    sessionIds: ["session-1"],
    citations: ["session-1/m:0"],
    verdictSeen: "failed",
    chainStage: "response",
    chainStageState: "failed",
    chainStageBasis: "reported",
    disposition: "blockedByResponse",
    tone: "fail",
    coverageNotes: [],
    outcomePhrase: "could not save changes",
    mechanismPhrase: WIRE_MECHANISM_PHRASE,
    fixPhrase: WIRE_FIX_PHRASE,
    reportExcerpt: null,
    mechanismId: "mechanism-1",
  };
  const report: SwarmJourneyFinding = {
    ...mechanism,
    id: "report",
    basis: "sessionReport",
    scopeLevel: "session",
    chainStage: null,
    chainStageState: null,
    chainStageBasis: "unmeasured",
    disposition: "notMeasured",
    tone: "muted",
    outcomePhrase: null,
    mechanismPhrase: null,
    fixPhrase: null,
    reportExcerpt: {
      actual: "The change was rejected.",
      citations: ["session-1/m:0"],
    },
    mechanismId: null,
  };
  return swarmJourneyFindingsSchema.parse({
    ...published,
    summaryKind: "broken",
    population: {
      configured: 1,
      started: 1,
      read: 1,
      unread: 0,
      withdrawn: 0,
      limited: 0,
      graded: 0,
    },
    coverageNotes: [],
    personas: [
      {
        persona: WIRE_PERSONA,
        disposition: "blockedByResponse",
        tone: "fail",
        goalRunIds: [WIRE_RUN_ID],
      },
    ],
    findings: [mechanism, report],
  });
}
