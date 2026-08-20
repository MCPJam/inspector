/**
 * Rendering a readiness verdict for a terminal and for CI.
 *
 * READINESS HAS NO SCORE, and this module is where that stays true when the
 * temptation is highest — a reporter wants a number, and the conformance
 * reporters beside it have one. Readiness answers "would this be listed",
 * which has no numerator, so what it publishes instead is a LANE with a status
 * and a coverage denominator. A percentage here would be invented, and an
 * invented number is the one a dashboard quotes.
 *
 * The JUnit adaptation loses one distinction and keeps the one that matters.
 * This repo's JUnit renderer has two outcomes, pass and failure, while
 * readiness has three — so `not-ready` and `incomplete` both render as
 * failures, told apart by the failure MESSAGE and by `details.status` rather
 * than by the element. What is never lost is that `incomplete` is not a pass:
 * a CI dashboard showing a green tick for a lane nobody could evaluate would
 * be the exact lie the third state exists to prevent, and that is the one
 * mapping this file will not make.
 */

import {
  summarizeStructuredCases,
  type StructuredCaseResult,
  type StructuredRunReport,
} from "@mcpjam/sdk";

export interface ReadinessLaneLike {
  lane: string;
  status: "ready" | "not-ready" | "incomplete";
  evaluated: number;
  notEvaluated: number;
  notApplicable: number;
  missingInputs: string[];
}

export interface ReadinessReportInput {
  publisher: "claude" | "openai";
  target: string;
  overallStatus: "ready" | "not-ready" | "incomplete" | null;
  lanes: ReadinessLaneLike[];
  stages?: Array<{ stage: string; status: string; lanes: string[] }>;
  submissionMode?: string | null;
  engineVersion?: string | null;
  policySnapshotDate?: string | null;
  observations?: { status: string; reason?: string; detail?: string };
  requestedObservations: boolean;
  /** Hosted runs only. Absent for a local run, which has no row. */
  runId?: string;
  durationMs: number;
}

/**
 * One case per LANE, not one per finding.
 *
 * A finding-level report would be thousands of rows and would make a CI
 * dashboard's failure count a function of how many checks a publisher happens
 * to define this month. The lane is the unit a submitter acts on.
 */
export function toReadinessStructuredReport(
  input: ReadinessReportInput,
): StructuredRunReport {
  const cases: StructuredCaseResult[] = input.lanes.map((lane) => {
    const total = lane.evaluated + lane.notEvaluated + lane.notApplicable;
    return {
      id: `${input.publisher}.${lane.lane}`,
      title: lane.lane,
      category: input.publisher,
      // `incomplete` is NOT passed. `details.status` and the `error` text
      // below are what tell it apart from a real violation — the structured
      // classification vocabulary here is about breaking changes and has no
      // word for "could not evaluate", so borrowing one would misfile it.
      passed: lane.status === "ready",
      details: {
        status: lane.status,
        evaluated: lane.evaluated,
        notEvaluated: lane.notEvaluated,
        notApplicable: lane.notApplicable,
        total,
        ...(lane.missingInputs.length > 0
          ? { missingInputs: lane.missingInputs }
          : {}),
      },
      ...(lane.status === "not-ready"
        ? { error: `Lane "${lane.lane}" is not ready` }
        : {}),
      ...(lane.status === "incomplete"
        ? {
            error: `Lane "${lane.lane}" could not be evaluated${
              lane.missingInputs.length > 0
                ? ` (missing: ${lane.missingInputs.join(", ")})`
                : ""
            }`,
          }
        : {}),
    };
  });

  return {
    schemaVersion: 1,
    kind: `directory-readiness.${input.publisher}`,
    // A run with ANY incomplete lane is not a pass. `summarizeStructuredCases`
    // counts a skipped case as failed for its own totals, which is why the
    // verdict is taken from the rollup rather than from the counts.
    passed: input.overallStatus === "ready",
    summary: summarizeStructuredCases(cases),
    cases,
    durationMs: input.durationMs,
    metadata: {
      publisher: input.publisher,
      target: input.target,
      overallStatus: input.overallStatus,
      ...(input.submissionMode ? { submissionMode: input.submissionMode } : {}),
      ...(input.stages ? { stages: input.stages } : {}),
      ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
      ...(input.policySnapshotDate
        ? { policySnapshotDate: input.policySnapshotDate }
        : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      // ALWAYS present, and always distinct from the grade. A consumer must be
      // able to see "the lanes graded cleanly AND the model call was refused"
      // without inferring either from the other.
      llmObservations: input.observations ?? {
        status: "not-requested",
        reason: "not_requested",
      },
      requestedLlmObservations: input.requestedObservations,
    },
  };
}

/** The human rendering: lanes, coverage, and never a number out of a hundred. */
export function renderReadinessForHuman(input: ReadinessReportInput): string {
  const lines: string[] = [];
  const label =
    input.publisher === "claude"
      ? "Claude directory"
      : "OpenAI plugin directory";
  lines.push(`${label} readiness — ${input.target}`);
  if (input.submissionMode)
    lines.push(`Submission mode: ${input.submissionMode}`);
  lines.push("");

  for (const lane of input.lanes) {
    const total = lane.evaluated + lane.notEvaluated + lane.notApplicable;
    const glyph =
      lane.status === "ready" ? "✓" : lane.status === "not-ready" ? "✗" : "○";
    lines.push(
      `  ${glyph} ${lane.lane} — ${lane.status} (${
        lane.evaluated
      }/${total} evaluated${
        lane.notApplicable > 0 ? `, ${lane.notApplicable} n/a` : ""
      })`,
    );
    if (lane.missingInputs.length > 0) {
      lines.push(`      missing: ${lane.missingInputs.join(", ")}`);
    }
  }

  if (input.stages && input.stages.length > 0) {
    lines.push("");
    for (const stage of input.stages) {
      lines.push(`  [${stage.stage}] ${stage.status}`);
    }
  }

  lines.push("");
  lines.push(`Overall: ${input.overallStatus ?? "no verdict"}`);
  return lines.join("\n");
}
