/**
 * How a directory submission reads: its answers against its flow, and one
 * readiness run's findings placed on the flow's steps.
 *
 * The rules (defaults, the portal's checks, placement, staleness) are the SDK
 * flow's; this module gathers their inputs: a run's findings from its stored
 * report, and the answers it graded from the copy frozen when it was
 * requested. Every run grades the whole submission, so results come from the
 * latest complete run.
 */
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  placeDirectoryResults,
  directoryPlacementOf,
  validateDirectoryAnswers,
  withDirectoryFlowDefaults,
  type DirectoryAnswer,
  type DirectoryFlow,
  type PlacedStep,
} from "@mcpjam/sdk";
import type {
  PlatformDirectoryFlowSummary,
  PlatformDirectorySubmission as Submission,
  PlatformDirectorySubmissionCounts,
  PlatformDirectorySubmissionSummary,
  PlatformDirectorySubmissionView,
  PlatformDirectorySubmissionFinding,
} from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getInternalBackendConfig } from "../../services/internal-backend.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { redactedReadRefusalError } from "./convex-read-errors.js";

import {
  changedFindingInputs,
  type FindingWithInputs,
} from "../../services/readiness/submission-finding-inputs.js";

type Finding = FindingWithInputs;

/** A run row as `claudeReadinessRuns` returns it. */
export type RunRow = {
  id: string;
  status: string;
  hasReport?: boolean;
  submissionId?: string;
  [field: string]: unknown;
};

export type RunResults = {
  run: RunRow | null;
  /** Absent when the run has no report that could be read. */
  report?: {
    findings: Finding[];
    gradedAnswers?: DirectoryAnswer[];
    pluginVersionId?: string;
    flowVersion?: string;
    expired?: boolean;
  };
};

/** Newest first; more failed runs than this in a row read as none complete. */
const RUN_SCAN_LIMIT = 50;
const REPORT_TIMEOUT_MS = 30_000;

const listRuns = makeFunctionReference<"query">(
  "claudeReadinessRuns:listReadinessRuns",
);
const runInputs = makeFunctionReference<"query">(
  "directoryReadinessRunInputs:getReadinessRunInputs",
);

/** A read the caller may not make answers the 404 an unknown id gets. */
export function readRefusal(error: unknown, resource: string) {
  return (
    redactedReadRefusalError(error, `${resource} not found`) ??
    translateConvexWriteError(error, { resource })
  );
}

export function toFlowSummary(
  flow: DirectoryFlow,
): PlatformDirectoryFlowSummary {
  const { id, directory, title, version, submissionUrl } = flow;
  const steps = flow.steps.map((step) => ({ id: step.id, title: step.title }));
  return { id, directory, title, version, submissionUrl, steps };
}

/** The backend's public projection of a submission, without its answers. */
export function toSubmissionSummary(
  row: Submission,
): PlatformDirectorySubmissionSummary {
  const { answers, ...summary } = row;
  return summary;
}

/** Field issues and one run's findings by step, stale where a read answer changed. */
export function placeResults(
  flow: DirectoryFlow,
  row: Submission,
  results: RunResults,
): PlacedStep[] {
  const steps = placeDirectoryResults({
    flow,
    answers: row.answers,
    findings: results.report?.findings,
    gradedAnswers: results.report?.gradedAnswers,
  });
  for (const step of steps) {
    for (const placed of step.findings) {
      const finding = placed.finding as Finding;
      const changed = changedFindingInputs(finding, {
        flow,
        answers: row.answers,
        pluginVersionId: row.pluginVersionId,
      });
      const needsPackage = directoryPlacementOf(
        flow,
        finding.id,
      )?.needs?.includes("package");
      if (
        !finding.inputs &&
        needsPackage &&
        results.report?.pluginVersionId !== row.pluginVersionId
      )
        changed.push("pluginVersionId");
      if (
        results.report?.flowVersion &&
        results.report.flowVersion !== flow.version
      )
        changed.push("rules");
      if (changed.length > 0 && placed.evidenceStatus === "established") {
        placed.evidenceStatus = "stale";
        placed.staleBecause = [
          ...new Set([...(placed.staleBecause ?? []), ...changed]),
        ];
      } else if (
        results.report?.expired &&
        !finding.inputs &&
        placed.evidenceStatus === "established"
      ) {
        placed.evidenceStatus = "inconclusive";
      }
    }
  }
  return steps;
}

export function toSubmissionView(
  flow: DirectoryFlow,
  row: Submission,
  results: RunResults,
): PlatformDirectorySubmissionView {
  return {
    ...toSubmissionSummary(row),
    // Derived on every read, never stored, so a flow update reaches every
    // draft that never changed a default.
    answers: withDirectoryFlowDefaults(flow, row.answers),
    fieldIssues: validateDirectoryAnswers(flow, row.answers),
    steps: placeResults(flow, row, results),
    resultsRunId: results.report && results.run ? results.run.id : null,
    submissionUrl: flow.submissionUrl,
  };
}

export function sumCounts(steps: readonly PlacedStep[]) {
  const total: PlatformDirectorySubmissionCounts = {
    toFix: 0,
    blockers: 0,
    likelyFlags: 0,
    notChecked: 0,
    passed: 0,
  };
  for (const { counts } of steps) {
    for (const key of Object.keys(total) as Array<keyof typeof total>) {
      total[key] += counts[key];
    }
  }
  return total;
}

/** The latest complete run's results; none for a submission that never ran. */
export async function latestResults(
  convex: ConvexHttpClient,
  row: Submission,
): Promise<RunResults> {
  if (!row.lastRunId) return { run: null };
  let runs: RunRow[];
  try {
    runs = await convex.query(listRuns, {
      projectId: row.projectId,
      submissionId: row.id,
      limit: RUN_SCAN_LIMIT,
    });
  } catch (error) {
    throw readRefusal(error, "Readiness runs");
  }
  const run = runs.find((each) => each.status === "completed");
  if (!run) return { run: null };
  const result = await resultsOf(convex, run);
  return result.report ? result : durableResults(convex, row.id, run);
}

/** One run's results. The caller has read the run under its own bearer. */
export async function resultsOf(
  convex: ConvexHttpClient,
  run: RunRow,
): Promise<RunResults> {
  if (!run.hasReport)
    return run.submissionId
      ? durableResults(convex, run.submissionId, run, true)
      : { run };
  const [findings, inputs] = await Promise.all([
    readFindings(run.id),
    convex.query(runInputs, { runId: run.id }).catch((error: unknown) => {
      throw readRefusal(error, "Readiness run inputs");
    }),
  ]);
  if (!findings)
    return run.submissionId
      ? durableResults(convex, run.submissionId, run, true)
      : { run };
  // Without the frozen answers nothing reads as stale, rather than everything.
  const graded: unknown = inputs?.answers;
  return Array.isArray(graded) && graded.every(hasKey)
    ? {
        run,
        report: {
          findings,
          gradedAnswers: graded,
          pluginVersionId: inputs?.pluginVersionId,
          flowVersion: inputs?.flowVersion,
        },
      }
    : { run, report: { findings } };
}

/**
 * A run's stored report, or `undefined` when retention removed it after the
 * run was read. Over the service-token route, by RUN id, as the report route
 * reads it: the caller's own read of the run is the authorization.
 */
export async function readStoredReport(
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  let status: number;
  let report: Record<string, unknown> | null;
  try {
    const response = await fetch(
      `${convexUrl}/internal/v1/claude-readiness/runs/report?runId=${encodeURIComponent(runId)}`,
      {
        headers: { "x-inspector-service-token": serviceToken },
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      },
    );
    status = response.status;
    const text = await response.text();
    report = response.ok ? JSON.parse(text) : {};
  } catch {
    throw unreadableReport();
  }
  if (status === 404) return undefined;
  if (status !== 200 || typeof report !== "object" || !report) {
    throw unreadableReport();
  }
  return report;
}

/** The findings in a run's stored report, or `undefined` when retention removed it. */
async function readFindings(runId: string): Promise<Finding[] | undefined> {
  const report = await readStoredReport(runId);
  if (!report) return undefined;
  const { findings } = report;
  if (!Array.isArray(findings) || !findings.every(isFinding)) {
    throw unreadableReport();
  }
  return findings;
}

function hasKey(value: unknown): value is DirectoryAnswer {
  return typeof (value as { key?: unknown } | null)?.key === "string";
}

function isFinding(value: unknown): value is Finding {
  const finding = value as Partial<Finding> | null;
  return (
    typeof finding?.id === "string" &&
    typeof finding.lane === "string" &&
    typeof finding.status === "string"
  );
}

function unreadableReport(): WebRouteError {
  return new WebRouteError(
    502,
    ErrorCode.INTERNAL_ERROR,
    "The readiness report could not be read from storage. Try again in a minute.",
  );
}

/** The compact check rows survive report retention and partial reruns. */
async function durableResults(
  convex: ConvexHttpClient,
  submissionId: string,
  run: RunRow,
  onlyThisRun = false,
): Promise<RunResults> {
  const ref = makeFunctionReference<"query">(
    "directorySubmissionResults:listDirectorySubmissionResults",
  );
  const findings: Finding[] = [];
  let cursor: string | undefined;
  do {
    const page: {
      page: PlatformDirectorySubmissionFinding[];
      isDone: boolean;
      continueCursor: string;
    } = await convex
      .query(ref, {
        submissionId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      .catch((error: unknown) => {
        throw readRefusal(error, "Directory submission findings");
      });
    for (const row of page.page) {
      if (onlyThisRun && row.runId !== run.id) continue;
      findings.push({
        id: row.checkId,
        lane: row.lane,
        class: row.class,
        status: row.status,
        title: row.title,
        remediation: row.remediation,
        notEvaluatedReason: row.notEvaluatedReason,
        provenance: row.provenance ?? "declared",
        requiresCapabilities: row.requiresCapabilities,
        evaluatedAt: new Date(row.evaluatedAt).toISOString(),
        engineVersion: row.engineVersion,
        source: row.source ? JSON.parse(row.source) : {},
        intrusiveness: row.intrusiveness ?? "passive",
        inputs: row.inputs,
      });
    }
    cursor = page.isDone ? undefined : page.continueCursor;
  } while (cursor);
  return findings.length
    ? { run, report: { findings, expired: true } }
    : { run };
}
