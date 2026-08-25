import { isAssertStep, isToolCallStep } from "@/shared/steps";
import {
  formatDurationMs,
  formatCompactNumber,
} from "./metric-strip-data";
import { computeIterationResult } from "./pass-criteria";
import {
  getEffectiveSuiteServers,
  iterationLatencyP50,
  iterationLatencyP95,
  runContextLabel,
  runHostLabel,
} from "./helpers";
import { computeRunEffectiveStats } from "./suite-runs-list";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";

export const SUITE_RUN_HISTORY_PAGE_SIZE = 8;

const SOURCE_LABEL: Record<NonNullable<EvalSuiteRun["source"]>, string> = {
  ui: "UI",
  sdk: "SDK",
  api: "API",
  schedule: "Scheduled",
  github_check: "GitHub",
};

export type SuiteIdentityCounts = {
  caseCount: number;
  sourceCount: number;
  serverCount: number;
};

export function suiteIdentityCounts(
  suite: {
    environment?: { servers?: string[] };
    hostAttachments?: EvalSuite["hostAttachments"];
    serverAttachment?: EvalSuite["serverAttachment"];
  },
  cases: readonly { _id: string }[],
  runs: readonly Pick<EvalSuiteRun, "source">[],
): SuiteIdentityCounts {
  const sources = new Set(runs.map((run) => run.source ?? "ui"));
  return {
    caseCount: cases.length,
    sourceCount: sources.size,
    serverCount: getEffectiveSuiteServers(suite).length,
  };
}

export function formatSuiteIdentitySubline(
  counts: SuiteIdentityCounts,
): string {
  return [
    `${counts.caseCount} ${counts.caseCount === 1 ? "case" : "cases"}`,
    `${counts.sourceCount} ${counts.sourceCount === 1 ? "source" : "sources"}`,
    `${counts.serverCount} ${counts.serverCount === 1 ? "server" : "servers"}`,
  ].join(" · ");
}

export type RunHistoryVerdict =
  | "ship"
  | "hold"
  | "passed"
  | "failed"
  | "running"
  | "pending"
  | "cancelled";

export type SuiteRunHistoryRow = {
  runId: string;
  date: number;
  dateLabel: string;
  verdict: RunHistoryVerdict;
  verdictLabel: string;
  passRate: number | null;
  topFailureSignature: string | null;
  platform: string;
  source: NonNullable<EvalSuiteRun["source"]>;
  client: string | null;
  models: string[];
  latencyMs: number | null;
  tokens: number | null;
  toolCalls: number | null;
};

export type SuiteRunHistoryAggregates = {
  runCount: number;
  totalTokens: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  tokensPerRun: number | null;
  toolCallsPerRun: number | null;
};

export type SuiteRunHistoryFilters = {
  verdict: "all" | RunHistoryVerdict;
  client: string | "all";
  model: string | "all";
};

export type SuiteRunHistoryFilterOptions = {
  verdicts: RunHistoryVerdict[];
  clients: string[];
  models: string[];
};

function runTimestamp(run: EvalSuiteRun): number {
  return run.completedAt ?? run.createdAt ?? run._creationTime ?? 0;
}

export function formatSuiteRunDate(timestamp: number): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  const now = new Date();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function passRateThreshold(
  run: EvalSuiteRun,
  suite: Pick<EvalSuite, "defaultPassCriteria">,
): number | null {
  return (
    run.passCriteria?.minimumPassRate ??
    suite.defaultPassCriteria?.minimumPassRate ??
    null
  );
}

export function resolveRunHistoryVerdict(
  run: EvalSuiteRun,
  passRate: number | null,
  threshold: number | null,
): { verdict: RunHistoryVerdict; label: string } {
  if (run.status === "running") {
    return { verdict: "running", label: "Running" };
  }
  if (run.status === "pending") {
    return { verdict: "pending", label: "Pending" };
  }
  if (run.status === "cancelled" || run.result === "cancelled") {
    return { verdict: "cancelled", label: "Cancelled" };
  }
  if (threshold != null && passRate != null) {
    return passRate >= threshold
      ? { verdict: "ship", label: "Ship" }
      : { verdict: "hold", label: "Hold" };
  }
  if (run.result === "passed") {
    return { verdict: "passed", label: "Passed" };
  }
  if (run.result === "failed") {
    return { verdict: "failed", label: "Failed" };
  }
  if (passRate != null) {
    return passRate === 100
      ? { verdict: "passed", label: "Passed" }
      : { verdict: "failed", label: "Failed" };
  }
  return { verdict: "pending", label: "Pending" };
}

export function runPlatformLabel(run: EvalSuiteRun): string {
  const source = run.source ?? "ui";
  const sourceLabel = SOURCE_LABEL[source] ?? SOURCE_LABEL.ui;
  const ciId = run.ciMetadata?.pipelineId ?? run.ciMetadata?.jobId;
  return ciId ? `${sourceLabel} #${ciId}` : sourceLabel;
}

function mostCommon(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function topFailureSignature(
  iterations: readonly EvalIteration[],
): string | null {
  const failed = iterations.filter(
    (iteration) => computeIterationResult(iteration) === "failed",
  );
  if (failed.length === 0) return null;
  const errors = failed
    .map((iteration) => iteration.error?.trim())
    .filter((error): error is string => Boolean(error));
  if (errors.length > 0) return mostCommon(errors);
  const titles = failed
    .map((iteration) => iteration.testCaseSnapshot?.title?.trim())
    .filter((title): title is string => Boolean(title));
  return mostCommon(titles);
}

function runClientLabel(
  run: EvalSuiteRun,
  hostNamesById: Map<string, string | null> | undefined,
  projectEnvironmentsEnabled: boolean,
): string | null {
  if (projectEnvironmentsEnabled) {
    return runContextLabel(run, hostNamesById);
  }
  return runHostLabel(run, hostNamesById);
}

function runModels(iterations: readonly EvalIteration[]): string[] {
  const models = new Set<string>();
  for (const iteration of iterations) {
    const model = iteration.testCaseSnapshot?.model?.trim();
    if (model) models.add(model);
  }
  return [...models];
}

function sumTokens(iterations: readonly EvalIteration[]): number {
  return iterations.reduce(
    (sum, iteration) => sum + (iteration.tokensUsed || 0),
    0,
  );
}

function sumToolCalls(iterations: readonly EvalIteration[]): number {
  return iterations.reduce(
    (sum, iteration) => sum + (iteration.actualToolCalls?.length ?? 0),
    0,
  );
}

export function buildSuiteRunHistoryRows(
  runs: readonly EvalSuiteRun[],
  allIterations: readonly EvalIteration[],
  suite: Pick<EvalSuite, "defaultPassCriteria">,
  hostNamesById: Map<string, string | null> | undefined,
  projectEnvironmentsEnabled: boolean,
): SuiteRunHistoryRow[] {
  const iterationsByRun = new Map<string, EvalIteration[]>();
  for (const iteration of allIterations) {
    if (!iteration.suiteRunId) continue;
    const list = iterationsByRun.get(iteration.suiteRunId);
    if (list) list.push(iteration);
    else iterationsByRun.set(iteration.suiteRunId, [iteration]);
  }

  return [...runs]
    .sort((a, b) => runTimestamp(b) - runTimestamp(a))
    .map((run) => {
      const iterations = iterationsByRun.get(run._id) ?? [];
      const stats = computeRunEffectiveStats(run, iterations);
      const threshold = passRateThreshold(run, suite);
      const { verdict, label } = resolveRunHistoryVerdict(
        run,
        stats.passRate,
        threshold,
      );
      const date = runTimestamp(run);
      const tokens = sumTokens(iterations);
      const toolCalls = sumToolCalls(iterations);
      return {
        runId: run._id,
        date,
        dateLabel: formatSuiteRunDate(date),
        verdict,
        verdictLabel: label,
        passRate: stats.passRate,
        topFailureSignature: topFailureSignature(iterations),
        platform: runPlatformLabel(run),
        source: run.source ?? "ui",
        client: runClientLabel(run, hostNamesById, projectEnvironmentsEnabled),
        models: runModels(iterations),
        latencyMs: iterationLatencyP50(iterations),
        tokens: tokens > 0 ? tokens : null,
        toolCalls: toolCalls > 0 ? toolCalls : null,
      };
    });
}

export function buildSuiteRunHistoryAggregates(
  runs: readonly EvalSuiteRun[],
  allIterations: readonly EvalIteration[],
): SuiteRunHistoryAggregates {
  const runIds = new Set(runs.map((run) => run._id));
  const iterations = allIterations.filter(
    (iteration) =>
      iteration.suiteRunId != null && runIds.has(iteration.suiteRunId),
  );
  const totalTokens = sumTokens(iterations);
  const totalToolCalls = sumToolCalls(iterations);
  const runCount = runs.length;
  return {
    runCount,
    totalTokens: totalTokens > 0 ? totalTokens : null,
    latencyP50: iterationLatencyP50(iterations),
    latencyP95: iterationLatencyP95(iterations),
    tokensPerRun: runCount > 0 && totalTokens > 0 ? totalTokens / runCount : null,
    toolCallsPerRun:
      runCount > 0 && totalToolCalls > 0 ? totalToolCalls / runCount : null,
  };
}

export function runHistoryFilterOptions(
  rows: readonly SuiteRunHistoryRow[],
): SuiteRunHistoryFilterOptions {
  const verdicts = [...new Set(rows.map((row) => row.verdict))];
  const clients = [
    ...new Set(
      rows
        .map((row) => row.client)
        .filter((client): client is string => Boolean(client)),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const models = [
    ...new Set(rows.flatMap((row) => row.models)),
  ].sort((a, b) => a.localeCompare(b));
  return { verdicts, clients, models };
}

export function filterSuiteRunHistoryRows(
  rows: readonly SuiteRunHistoryRow[],
  filters: SuiteRunHistoryFilters,
): SuiteRunHistoryRow[] {
  return rows.filter((row) => {
    if (filters.verdict !== "all" && row.verdict !== filters.verdict) {
      return false;
    }
    if (filters.client !== "all" && row.client !== filters.client) {
      return false;
    }
    if (filters.model !== "all" && !row.models.includes(filters.model)) {
      return false;
    }
    return true;
  });
}

export function formatRunHistoryMetric(
  value: number | null,
  kind: "number" | "duration",
): string {
  if (value == null) return "—";
  if (kind === "duration") return formatDurationMs(value);
  return formatCompactNumber(value);
}

export type SuiteTestCaseRow = {
  caseId: string;
  title: string;
  summary: string;
};

function uniqueToolNames(testCase: EvalCase): string[] {
  const names = new Set<string>();
  for (const call of testCase.expectedToolCalls ?? []) {
    if (call.toolName) names.add(call.toolName);
  }
  for (const step of testCase.steps ?? []) {
    if (isToolCallStep(step) && step.toolName) {
      names.add(step.toolName);
    }
  }
  return [...names];
}

export function summarizeTestCase(testCase: EvalCase): string {
  const assertCount = (testCase.steps ?? []).filter(isAssertStep).length;
  const tools = uniqueToolNames(testCase);
  const parts: string[] = [];
  if (assertCount > 0) {
    parts.push(
      `${assertCount} ${assertCount === 1 ? "assertion" : "assertions"}`,
    );
  }
  if (tools.length > 0) {
    parts.push(tools.slice(0, 3).join(", "));
  }
  if (parts.length === 0 && testCase.expectedOutput?.trim()) {
    parts.push("expected output");
  }
  if (parts.length === 0 && testCase.query?.trim()) {
    const query = testCase.query.trim();
    return query.length > 80 ? `${query.slice(0, 77)}…` : query;
  }
  return parts.join(" · ");
}

export function buildSuiteTestCaseRows(
  cases: readonly EvalCase[],
): SuiteTestCaseRow[] {
  return cases.map((testCase) => ({
    caseId: testCase._id,
    title: testCase.title?.trim() || "Untitled test case",
    summary: summarizeTestCase(testCase),
  }));
}

export function suiteRunBlockedReason({
  caseCount,
  hasServersConfigured,
  isEnvironmentSuite,
  isRerunning,
  isReplaying,
  runningTestCase,
  evalRunsDisabledReason,
}: {
  caseCount: number;
  hasServersConfigured: boolean;
  isEnvironmentSuite: boolean;
  isRerunning: boolean;
  isReplaying: boolean;
  runningTestCase: boolean;
  evalRunsDisabledReason?: string | null;
}): string | null {
  if (evalRunsDisabledReason) return evalRunsDisabledReason;
  if (!isEnvironmentSuite && !hasServersConfigured) {
    return "Configure suite servers before running the full suite.";
  }
  if (caseCount === 0) return "Add a test case first.";
  if (isRerunning || isReplaying) {
    return "A suite or replay is already in progress.";
  }
  if (runningTestCase) return "Finish the in-progress test case run first.";
  return null;
}
