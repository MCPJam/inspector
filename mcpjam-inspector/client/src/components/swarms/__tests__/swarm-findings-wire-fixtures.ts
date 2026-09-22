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

export const WIRE_SECOND_RUN_ID = "run-export";
export const WIRE_SECOND_GOAL = {
  runId: WIRE_SECOND_RUN_ID,
  journeyRefId: "journey-export",
  title: "Export the quarterly ledger for the finance team",
};
export const WIRE_TRUNCATION_PHRASE =
  "The reply stopped before it was finished.";
export const WIRE_TRUNCATION_FIX = "Raise the reply limit.";
export const WIRE_ACCOUNT =
  "She asked for the diagram and the reply stopped partway. Nothing was drawn.";

/**
 * The staging wave that started all this: two goals, the same cause, and the
 * reply cut off in both. Long titles on purpose — the legacy composer cut goal
 * titles to four words, which is most of why the card said nothing useful.
 */
export function truncatedWire(
  over: {
    signalRows?: boolean;
    mechanismRows?: boolean;
    verification?: SwarmJourneyFindings["verification"];
  } = {},
): SwarmJourneyFindings {
  const published = publishedWire();
  const base: SwarmJourneyFinding = {
    id: "x",
    basis: "verifiedMechanism",
    scopeLevel: "goal",
    persona: WIRE_PERSONA,
    goal: WIRE_GOAL,
    target: { kind: "host", id: "host-1", label: "Claude", modelId: null },
    population: { count: 1, total: 2, unit: "sessions" },
    sessionIds: ["session-1"],
    citations: ["session-1/signal:outputTruncated:1"],
    verdictSeen: "failed",
    chainStage: "response",
    chainStageState: "failed",
    chainStageBasis: "derived",
    disposition: "blockedByResponse",
    tone: "fail",
    coverageNotes: [],
    outcomePhrase: "could not finish the reply",
    mechanismPhrase: WIRE_TRUNCATION_PHRASE,
    fixPhrase: WIRE_TRUNCATION_FIX,
    reportExcerpt: null,
    // ONE cause, fanned into a row per goal — the client rejoins them by this.
    mechanismId: "mechanism-truncation",
  };
  const mechanismRows: SwarmJourneyFinding[] = [
    { ...base, id: "mech-a" },
    {
      ...base,
      id: "mech-b",
      goal: WIRE_SECOND_GOAL,
      sessionIds: ["session-2"],
      citations: ["session-2/signal:outputTruncated:0"],
    },
  ];
  const reports: SwarmJourneyFinding[] = mechanismRows.map((row, index) => ({
    ...row,
    id: `report-${index}`,
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
    mechanismId: null,
    reportExcerpt: {
      actual: "The assistant's reply stopped at its output limit.",
      account: WIRE_ACCOUNT,
      citations: [`${row.sessionIds[0]}/m:0`],
    },
  }));
  const signalRows: SwarmJourneyFinding[] = mechanismRows.map((row, index) => ({
    ...row,
    id: `signal-${index}`,
    basis: "populationFact",
    signal: "outputTruncated",
    // A recorded fact never colours a stage the chain measured.
    chainStageState: null,
    chainStageBasis: "reported",
    outcomePhrase: "Reply cut off before finishing",
    mechanismPhrase: null,
    fixPhrase: null,
    mechanismId: null,
    citations: [],
    reportExcerpt: null,
  }));
  return swarmJourneyFindingsSchema.parse({
    ...published,
    summaryKind: "broken",
    population: {
      configured: 5,
      started: 5,
      read: 4,
      unread: 1,
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
        goalRunIds: [WIRE_RUN_ID, WIRE_SECOND_RUN_ID],
      },
    ],
    findings: [
      ...(over.mechanismRows === false ? [] : mechanismRows),
      ...reports,
      ...(over.signalRows === false ? [] : signalRows),
    ],
    ...(over.verification ? { verification: over.verification } : {}),
  });
}
