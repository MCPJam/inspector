import type { EvalSuiteOverviewEntry, EvalSuiteRun, CommitGroup } from "./types";

// ---------------------------------------------------------------------------
// Failure Classification
// ---------------------------------------------------------------------------

export type FailureTag = "regression" | "flaky" | "new";

export interface ClassifiedFailure {
  run: EvalSuiteRun;
  suiteName: string;
  tags: FailureTag[];
}

/**
 * Classify a failed run by examining its history across recent commits.
 *
 * - "regression": suite was passing in a previous commit and is now failing
 * - "flaky": suite has alternated between pass/fail in recent history
 * - "new": this is the first time this suite has been run (no prior history)
 */
export function classifyFailure(
  run: EvalSuiteRun,
  suiteName: string,
  allCommitGroups: CommitGroup[],
): ClassifiedFailure {
  const tags: FailureTag[] = [];

  // Collect history for this suite across commit groups (newest-first order)
  const history = getSuiteHistory(run.suiteId, allCommitGroups);

  if (history.length <= 1) {
    // No prior runs — this is a new suite
    tags.push("new");
  } else {
    // history[0] is the current run's commit group (newest)
    // Check if the immediately previous run was passing
    const previousResult = history[1];
    if (previousResult === "passed") {
      tags.push("regression");
    }

    // Check for flakiness: alternating pass/fail in recent history
    if (isFlaky(history)) {
      tags.push("flaky");
    }
  }

  return { run, suiteName, tags };
}

/**
 * Get the result history of a suite across commit groups.
 * Returns an array of results from newest to oldest.
 */
export function getSuiteHistory(
  suiteId: string,
  allCommitGroups: CommitGroup[],
): Array<"passed" | "failed" | "other"> {
  const results: Array<"passed" | "failed" | "other"> = [];

  for (const group of allCommitGroups) {
    const run = group.runs.find((r) => r.suiteId === suiteId);
    if (run) {
      if (run.result === "passed") results.push("passed");
      else if (run.result === "failed") results.push("failed");
      else results.push("other");
    }
  }

  return results;
}

/**
 * Determine if a suite is flaky based on its result history.
 * A suite is flaky if it has switched between pass and fail
 * at least 2 times in the recent history (up to last 10 runs).
 */
export function isFlaky(
  history: Array<"passed" | "failed" | "other">,
): boolean {
  // Filter to only definitive results
  const definitive = history
    .slice(0, 10)
    .filter((r) => r === "passed" || r === "failed");

  if (definitive.length < 3) return false;

  let switches = 0;
  for (let i = 1; i < definitive.length; i++) {
    if (definitive[i] !== definitive[i - 1]) {
      switches++;
    }
  }

  return switches >= 2;
}

/**
 * Classify all failed runs in a commit group.
 */
export function classifyAllFailures(
  failedRuns: EvalSuiteRun[],
  suiteMap: Map<string, string>,
  allCommitGroups: CommitGroup[],
): ClassifiedFailure[] {
  return failedRuns.map((run) => {
    const suiteName = suiteMap.get(run.suiteId) || "Unknown suite";
    return classifyFailure(run, suiteName, allCommitGroups);
  });
}

// ---------------------------------------------------------------------------
// AI Triage Data Preparation
// ---------------------------------------------------------------------------

export interface TriageContext {
  commitSha: string;
  branch: string | null;
  totalSuites: number;
  totalCases: { total: number; passed: number; failed: number };
  failures: Array<{
    suiteName: string;
    tags: FailureTag[];
    failedCases: number;
    totalCases: number;
    passRate: number;
    testNames: string[];
  }>;
  passedSuites: string[];
  notRunSuites: string[];
}

/**
 * Build context object for the LLM triage prompt.
 */
export function buildTriageContext(
  commitGroup: CommitGroup,
  classifiedFailures: ClassifiedFailure[],
  passedRuns: EvalSuiteRun[],
  notRunRuns: EvalSuiteRun[],
): TriageContext {
  const totalCases = { total: 0, passed: 0, failed: 0 };
  for (const run of commitGroup.runs) {
    if (run.summary) {
      totalCases.total += run.summary.total;
      totalCases.passed += run.summary.passed;
      totalCases.failed += run.summary.failed;
    }
  }

  return {
    commitSha: commitGroup.shortSha,
    branch: commitGroup.branch,
    totalSuites: commitGroup.runs.length,
    totalCases,
    failures: classifiedFailures.map((cf) => ({
      suiteName: cf.suiteName,
      tags: cf.tags,
      failedCases: cf.run.summary?.failed ?? 0,
      totalCases: cf.run.summary?.total ?? 0,
      passRate: cf.run.summary
        ? Math.round(
            (cf.run.summary.passed / Math.max(cf.run.summary.total, 1)) * 100,
          )
        : 0,
      testNames:
        cf.run.configSnapshot?.tests?.map((t) => t.title).filter(Boolean) ?? [],
    })),
    passedSuites: passedRuns.map(
      (r) => commitGroup.suiteMap.get(r.suiteId) || "Unknown",
    ),
    notRunSuites: notRunRuns.map(
      (r) => commitGroup.suiteMap.get(r.suiteId) || "Unknown",
    ),
  };
}

/**
 * Build context for overview-level AI insights from all suites.
 */
export interface OverviewTriageContext {
  totalSuites: number;
  failingSuites: Array<{
    name: string;
    tags: FailureTag[];
    passRate: string;
    failedCases: number;
    totalCases: number;
  }>;
  passingSuites: number;
  neverRunSuites: number;
}

export function buildOverviewTriageContext(
  suites: EvalSuiteOverviewEntry[],
  allCommitGroups: CommitGroup[],
): OverviewTriageContext {
  const failingSuites: OverviewTriageContext["failingSuites"] = [];
  let passingSuites = 0;
  let neverRunSuites = 0;

  for (const entry of suites) {
    if (!entry.latestRun) {
      neverRunSuites++;
      continue;
    }
    // Include suites that have any failed cases — even if the suite-level
    // result is "passed" due to pass rate thresholds being met
    const hasFailedCases = entry.totals.failed > 0;
    const suiteResultFailed = entry.latestRun.result === "failed";

    if (hasFailedCases || suiteResultFailed) {
      const classified = classifyFailure(
        entry.latestRun,
        entry.suite.name,
        allCommitGroups,
      );
      const total = entry.totals.passed + entry.totals.failed;
      failingSuites.push({
        name: entry.suite.name,
        tags: classified.tags,
        passRate:
          total > 0
            ? `${Math.round((entry.totals.passed / total) * 100)}%`
            : "--",
        failedCases: entry.totals.failed,
        totalCases: total,
      });
    } else {
      passingSuites++;
    }
  }

  return {
    totalSuites: suites.length,
    failingSuites,
    passingSuites,
    neverRunSuites,
  };
}
