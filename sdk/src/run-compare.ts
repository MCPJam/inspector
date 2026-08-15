/**
 * Adapt a run comparison into the shared `StructuredRunReport`, so
 * `mcpjam eval compare` gets JSON and JUnit output for free.
 *
 * Mirrors `buildServerDiffReport` (`server-diff.ts`) deliberately: the CLI's
 * `--reporter` / `--out` plumbing already speaks `StructuredRunReport`, and a
 * second report shape would mean a second JUnit renderer to keep in sync.
 *
 * --- What counts as a failing "case" here ---
 *
 * The report's cases are the comparison's cases, and a case "fails" when it
 * REGRESSED. `changed`, `new_case` and `removed_case` are informational: they
 * describe a diff in the test suite, not a diff in the product. Making them
 * fail would turn every legitimate suite edit into a red build, which is how
 * teams learn to pass `--no-verify`.
 *
 * The overall `passed` comes from the GATE REPORT, not from the case rows: a
 * regression the policy did not ask about must not fail the build, and a
 * non-gateable policy must not pass it.
 */

import type { GateReport } from "./gates.js";
import type { FlakyCase } from "./compare-stats.js";
import type {
  PlatformRunCompare,
  PlatformRunCompareCase,
} from "./platform/types.js";
import {
  summarizeStructuredCases,
  type StructuredCaseResult,
  type StructuredRunReport,
} from "./structured-reporting.js";

/** Case statuses that represent a product regression, not a suite edit. */
const FAILING_STATUSES = new Set<PlatformRunCompareCase["status"]>([
  "regressed",
]);

function classify(
  status: PlatformRunCompareCase["status"]
): StructuredCaseResult["classification"] {
  if (status === "regressed") return "breaking";
  if (status === "fixed" || status === "unchanged_passed") return "non_breaking";
  return "informational";
}

function describeCase(row: PlatformRunCompareCase): string | undefined {
  if (row.status === "regressed") {
    const regressions = row.scoreDeltas
      .filter(
        (delta) =>
          delta.gating &&
          !delta.definitionChanged &&
          delta.base?.passed === true &&
          delta.compare?.passed === false
      )
      .map((delta) => delta.scorerId);
    const scorers =
      regressions.length > 0
        ? ` (gating scorer(s) regressed: ${regressions.join(", ")})`
        : "";
    return `${row.base.outcome} -> ${row.compare.outcome}${scorers}${
      row.compare.error ? `: ${row.compare.error}` : ""
    }`;
  }
  return undefined;
}

function toStructuredCase(row: PlatformRunCompareCase): StructuredCaseResult {
  return {
    id: row.caseKey,
    title: row.title,
    category: row.status,
    passed: !FAILING_STATUSES.has(row.status),
    classification: classify(row.status),
    ...(describeCase(row) ? { error: describeCase(row) } : {}),
    details: {
      status: row.status,
      configChanged: row.configChanged,
      evaluationConfigChanged: row.evaluationConfigChanged,
      base: row.base.outcome,
      compare: row.compare.outcome,
      ...(row.scoreDeltas.length > 0
        ? { scoreDeltas: row.scoreDeltas }
        : {}),
    },
  };
}

export function buildRunCompareReport(
  compare: PlatformRunCompare,
  gateReport: GateReport,
  options: {
    durationMs?: number;
    flakyCases?: FlakyCase[];
    metadata?: Record<string, unknown>;
  } = {}
): StructuredRunReport {
  const cases = compare.cases.map(toStructuredCase);

  return {
    schemaVersion: 1,
    kind: "run-compare",
    // The GATE decides, not the rows. See the module comment.
    passed: gateReport.outcome === "passed",
    summary: summarizeStructuredCases(cases),
    cases,
    durationMs: options.durationMs ?? 0,
    metadata: {
      suite: compare.suite,
      baseline: compare.baseline,
      baseRunId: compare.baseRun.id,
      compareRunId: compare.compareRun.id,
      gate: {
        outcome: gateReport.outcome,
        scoreIntegrity: gateReport.scoreIntegrity,
        verdicts: gateReport.verdicts,
      },
      scoreContract: compare.scoreContract,
      passSummary: compare.passSummary,
      // Reported, never gated — see `detectFlakyCases`.
      flakyCases: options.flakyCases ?? [],
      ...(options.metadata ?? {}),
    },
  };
}
