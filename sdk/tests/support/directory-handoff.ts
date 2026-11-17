/** Builders for the handoff and export tests: findings, events, snapshots and the input itself. */

import { CLAUDE_CONNECTOR_FLOW } from "../../src/directory-readiness/flows/claude-connector.js";
import { placeDirectoryResults } from "../../src/directory-readiness/flows/place.js";
import type {
  DirectoryAnswer,
  DirectoryFlow,
} from "../../src/directory-readiness/flows/types.js";
import type { DirectoryCheckGate } from "../../src/directory-readiness/flows/verdict.js";
import type {
  DirectoryHandoffInput,
  DirectorySnapshotLabel,
  DirectorySubmissionEvent,
  DirectorySubmissionSnapshot,
} from "../../src/directory-readiness/handoff.js";
import type { DirectoryReadinessFinding } from "../../src/directory-readiness/types.js";

export function finding(
  id: string,
  overrides: Partial<DirectoryReadinessFinding> = {}
): DirectoryReadinessFinding {
  return {
    id,
    title: `Check ${id}`,
    lane: "directory-policy",
    class: "required",
    status: "satisfied",
    source: {},
    provenance: "wire",
    intrusiveness: "passive",
    evaluatedAt: "2026-11-13T00:00:00.000Z",
    engineVersion: "test",
    ...overrides,
  };
}

export function event(
  kind: DirectorySubmissionEvent["kind"],
  fields: Partial<DirectorySubmissionEvent> = {}
): DirectorySubmissionEvent {
  return {
    id: `event-${kind}-${fields.createdAt ?? 0}`,
    submissionId: "sub-1",
    projectId: "project-1",
    kind,
    reportedOrObserved: "reported",
    actor: "user-1",
    createdAt: 1_000,
    ...fields,
  };
}

/** The latest snapshot under `label`: `null` names no revision. */
export function snapshot(
  label: DirectorySnapshotLabel,
  revisionNumber: number | null,
  contractHash = `hash-${revisionNumber}`
): DirectorySubmissionSnapshot {
  return {
    ...event("snapshot", {
      snapshot: {
        label,
        serverId: "server-1",
        ...(revisionNumber === null ? {} : { revisionNumber }),
      },
    }),
    revision:
      revisionNumber === null
        ? null
        : { revisionNumber, capturedAt: 500, counts: { tools: 64 }, contractHash },
  };
}

export function handoffInput(
  options: {
    flow?: DirectoryFlow;
    answers?: DirectoryAnswer[];
    findings?: DirectoryReadinessFinding[];
    gradedAnswers?: DirectoryAnswer[];
    checkGate?: DirectoryCheckGate;
    events?: DirectorySubmissionEvent[];
    snapshots?: DirectoryHandoffInput["snapshots"];
    latestRun?: DirectoryHandoffInput["latestRun"];
  } = {}
): DirectoryHandoffInput {
  const flow = options.flow ?? CLAUDE_CONNECTOR_FLOW;
  const answers = options.answers ?? [];
  return {
    flow,
    submission: {
      id: "sub-1",
      projectId: "project-1",
      flowVersion: flow.version,
      serverId: "server-1",
      revision: 4,
      updatedAt: 2_000,
      answers,
      ...(options.checkGate ? { checkGate: options.checkGate } : {}),
    },
    results: placeDirectoryResults({
      flow,
      answers,
      findings: options.findings,
      gradedAnswers: options.gradedAnswers,
    }),
    resultsRunId: options.findings ? "run-1" : null,
    latestRun: options.latestRun ?? null,
    events: options.events ?? [],
    snapshots: options.snapshots ?? {},
  };
}
