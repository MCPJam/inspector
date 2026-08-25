import { redactForTelemetry } from "./telemetry-redaction.js";
import { formatEvalRunDecisionSummary } from "./eval-decision-summary.js";
import {
  EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
  EVAL_RUN_DECISION_VERDICT_LABELS,
  EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS,
  EVAL_VERDICT_DECISION_REASON_LABELS,
  FAILURE_CATEGORY_LABELS,
  STAGE_REASON_LABELS,
  USER_VALUE_STAGE_LABELS,
  measurementUnitLabel,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
} from "./contract/index.js";
import type {
  PlatformEvalIteration,
  PlatformEvalRun,
} from "./platform/types.js";

export type StructuredCaseClassification =
  | "breaking"
  | "non_breaking"
  | "informational";

export interface StructuredCaseResult {
  id: string;
  title: string;
  category: string;
  passed: boolean;
  classification?: StructuredCaseClassification;
  durationMs?: number;
  error?: string;
  details?: unknown;
  /**
   * An authorized override of THIS case's verdict, on the record.
   *
   * Set only on a gate case whose failure was waived. It is the single home
   * for the waiver payload in a structured report — every renderer reads it
   * from here rather than each carrying its own copy, so the three facts the
   * charter requires cannot drift between the JSON, the JUnit and the HTML.
   *
   * A case carrying this is `passed: true` (the gate did not block the build)
   * but is never rendered as a plain pass: JUnit marks it `<skipped>`, HTML
   * gives it its own section, and the report's `verdict` says `waived`.
   */
  waiver?: StructuredCaseWaiver;
}

/**
 * The waiver facts a CI artifact must carry: WHO waived, WHY, and UNTIL WHEN.
 *
 * `createdByEmail` is carried alongside the opaque `createdBy` id because a
 * JUnit file read six months from now cannot resolve a user id, and it is
 * `null` rather than absent when it could not be resolved — a deleted user
 * must not make a waiver look authorless.
 */
export interface StructuredCaseWaiver {
  id: string;
  reason: string;
  expiresAt: number;
  createdAt: number;
  createdBy: string;
  createdByEmail: string | null;
  policySnapshot?: { minimumPassRate: number } | null;
}

export interface StructuredSummaryBucket {
  total: number;
  passed: number;
  failed: number;
}

export interface StructuredRunSummary {
  total: number;
  passed: number;
  failed: number;
  byCategory: Record<string, StructuredSummaryBucket>;
  byClassification?: Record<string, StructuredSummaryBucket>;
}

export interface StructuredRunReport {
  schemaVersion: 1;
  kind: string;
  passed: boolean;
  /**
   * The backend's verdict, carried through rather than recomputed. Absent on a
   * report built from anything but eval runs.
   *
   * `passed` alone cannot express `inconclusive`: a run the platform could not
   * measure is not a pass, but calling it a failure reports a defect nothing
   * observed. So `passed` stays false and this says WHY, and no synthetic
   * failing case is fabricated for it — which is also why an inconclusive run
   * leaves `summary.failed` untouched.
   */
  verdict?: StructuredRunVerdict;
  summary: StructuredRunSummary;
  cases: StructuredCaseResult[];
  durationMs: number;
  metadata: Record<string, unknown>;
  /**
   * The canonical run decision contract, VERBATIM.
   *
   * Carries its own `schemaVersion`, so a consumer identifies the shape from
   * the object rather than from this report's version. It replaced an
   * unversioned per-case summary whose verdict was computed by counting
   * iterations — see the release note; a reader of the old shape looked for
   * `passRate.percent` and `cases[]`, and now reads `counts` (with its
   * `measurementUnit`) and `diagnostics.items[]`.
   */
  decisionSummary?: EvalRunDecisionSummary;
}

export type StructuredRunVerdict =
  | "passed"
  | "failed"
  | "inconclusive"
  | /**
     * A measured failure an authorized human overrode. Its own value rather
     * than `passed`, because the two are not the same claim and only one of
     * them is a clean run — see `gateOutcomeVerdict` in `gates.ts`.
     */
    "waived";

export interface StructuredEvalRunInput {
  run: PlatformEvalRun;
  iterations: readonly PlatformEvalIteration[];
  iterationsComplete: boolean;
  iterationError?: string;
}

function evalCaseKey(iteration: PlatformEvalIteration): string {
  return iteration.testCaseId ?? iteration.title ?? iteration.id;
}

function evalCaseFailure(iterations: readonly PlatformEvalIteration[]): string {
  return iterations
    .filter((iteration) => iteration.result !== "passed")
    .map(
      (iteration) =>
        iteration.error ??
        `Iteration ${iteration.iterationNumber} ${
          iteration.result ?? iteration.status
        }`
    )
    .join("; ");
}

function evalRunDurationMs(runs: readonly PlatformEvalRun[]): number {
  const starts = runs.map((run) => run.createdAt);
  const ends = runs
    .map((run) => run.completedAt)
    .filter((value): value is number => value !== null);
  if (starts.length === 0 || ends.length !== runs.length) return 0;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

export function buildEvalRunReport(
  inputs: readonly StructuredEvalRunInput[],
  options: {
    cases?: StructuredCaseResult[];
    metadata?: Record<string, unknown>;
    decisionSummary?: EvalRunDecisionSummary;
    /**
     * Overrides the verdict this would otherwise compute from `inputs`.
     *
     * For a gate/compare report, `inputs` describes the underlying eval
     * run — not the gate's own outcome, which is a separate policy decision
     * layered on top (a run can pass while its gate is non-gateable). Pass
     * the gate's verdict (e.g. via `gateOutcomeVerdict`) explicitly rather
     * than letting this fall back to a verdict about the wrong thing, or to
     * no verdict at all — which a renderer with no verdict falls back to
     * reading off `passed`, painting an unmeasured gate as a measured
     * failure.
     */
    verdict?: StructuredRunVerdict;
  } = {}
): StructuredRunReport {
  const cases = [...(options.cases ?? [])];

  for (const input of inputs) {
    const byCase = new Map<string, PlatformEvalIteration[]>();
    for (const iteration of input.iterations) {
      const key = evalCaseKey(iteration);
      const existing = byCase.get(key);
      if (existing) existing.push(iteration);
      else byCase.set(key, [iteration]);
    }

    for (const [caseKey, iterations] of byCase) {
      const first = iterations[0];
      const passed = iterations.every(
        (iteration) => iteration.result === "passed"
      );
      const durationMs = iterations.reduce(
        (total, iteration) => total + (iteration.durationMs ?? 0),
        0
      );
      cases.push({
        id: `${input.run.id}:${caseKey}`,
        title: first.title ?? first.testCaseId ?? first.id,
        category: "eval",
        passed,
        ...(durationMs > 0 ? { durationMs } : {}),
        ...(passed ? {} : { error: evalCaseFailure(iterations) }),
        details: {
          runId: input.run.id,
          iterations: iterations.map((iteration) => ({
            id: iteration.id,
            iterationNumber: iteration.iterationNumber,
            status: iteration.status,
            result: iteration.result,
            error: iteration.error,
          })),
        },
      });
    }

    if (!input.iterationsComplete || input.iterationError) {
      cases.push({
        id: `${input.run.id}:iterations`,
        title: `${input.run.id}: iteration results`,
        category: "reporting",
        passed: false,
        classification: "informational",
        error:
          input.iterationError ??
          "The complete iteration result set could not be fetched.",
      });
    }

    if (
      input.run.result !== "passed" &&
      input.run.result !== "inconclusive" &&
      !cases.some(
        (entry) => entry.id.startsWith(`${input.run.id}:`) && !entry.passed
      )
    ) {
      cases.push({
        id: `${input.run.id}:run`,
        title: `${input.run.id}: ${input.run.status}`,
        category: "eval",
        passed: false,
        error: `Run ${input.run.result ?? input.run.status}.`,
      });
    }
  }

  const passed =
    inputs.length > 0 &&
    inputs.every(
      (input) =>
        input.run.result === "passed" &&
        input.iterationsComplete &&
        input.iterationError === undefined
    ) &&
    cases.every((entry) => entry.passed);

  return {
    schemaVersion: 1,
    kind: "eval-run",
    passed,
    ...(options.verdict !== undefined
      ? { verdict: options.verdict }
      : inputs.length > 0
      ? { verdict: structuredEvalVerdict(inputs, passed) }
      : {}),
    summary: summarizeStructuredCases(cases),
    cases,
    durationMs: evalRunDurationMs(inputs.map((input) => input.run)),
    metadata: {
      runs: inputs.map((input) => ({
        id: input.run.id,
        suiteId: input.run.suiteId,
        status: input.run.status,
        result: input.run.result,
        summary: input.run.summary,
        iterationsComplete: input.iterationsComplete,
        ...(input.run.verdictPolicyVersion !== undefined
          ? { verdictPolicyVersion: input.run.verdictPolicyVersion }
          : {}),
        ...(input.run.verdictSummary !== undefined
          ? { verdictSummary: input.run.verdictSummary }
          : {}),
        ...(input.run.verdictPolicyIntegrityError !== undefined
          ? {
              verdictPolicyIntegrityError: input.run.verdictPolicyIntegrityError,
            }
          : {}),
      })),
      ...(options.metadata ?? {}),
    },
    ...(options.decisionSummary
      ? { decisionSummary: options.decisionSummary }
      : {}),
  };
}

/**
 * The report's verdict, read off the runs the backend decided.
 *
 * A failure anywhere wins, because one measured regression is a regression
 * whatever else was unmeasurable. Otherwise an inconclusive run withholds the
 * report's verdict rather than being folded into either side.
 */
function structuredEvalVerdict(
  inputs: readonly StructuredEvalRunInput[],
  passed: boolean
): StructuredRunVerdict {
  if (passed) return "passed";
  const results = inputs.map((input) => input.run.result);
  if (results.some((result) => result === "failed")) return "failed";
  const reportable = inputs.every(
    (input) => input.iterationsComplete && input.iterationError === undefined
  );
  return reportable && results.some((result) => result === "inconclusive")
    ? "inconclusive"
    : "failed";
}

export function summarizeStructuredCases(
  cases: StructuredCaseResult[]
): StructuredRunSummary {
  const summary: StructuredRunSummary = {
    total: cases.length,
    passed: 0,
    failed: 0,
    byCategory: {},
    byClassification: {},
  };

  for (const caseResult of cases) {
    if (caseResult.passed) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }

    const categoryBucket =
      summary.byCategory[caseResult.category] ??
      createStructuredSummaryBucket();
    updateBucket(categoryBucket, caseResult.passed);
    summary.byCategory[caseResult.category] = categoryBucket;

    if (caseResult.classification) {
      const classificationBucket =
        summary.byClassification?.[caseResult.classification] ??
        createStructuredSummaryBucket();
      updateBucket(classificationBucket, caseResult.passed);
      if (summary.byClassification) {
        summary.byClassification[caseResult.classification] =
          classificationBucket;
      }
    }
  }

  if (
    summary.byClassification &&
    Object.keys(summary.byClassification).length === 0
  ) {
    delete summary.byClassification;
  }

  return summary;
}

export function renderStructuredRunJson(
  report: StructuredRunReport
): StructuredRunReport {
  return redactForTelemetry(report) as StructuredRunReport;
}

export function renderStructuredRunJUnitXml(
  report: StructuredRunReport
): string {
  const redactedReport = renderStructuredRunJson(report);
  const effectiveCases =
    redactedReport.cases.length > 0
      ? redactedReport.cases
      : [createSyntheticCase(redactedReport.kind, redactedReport.passed)];

  const tests = effectiveCases.length;
  const failures = effectiveCases.filter((entry) => !entry.passed).length;
  // Declared on the suite as well as marked on the case: a parser that only
  // reads the attributes must still be able to see that something here was
  // overridden rather than run clean.
  //
  // OMITTED when zero, rather than written as `skipped="0"`. This XML is
  // consumed by CI systems and asserted as a literal, and an attribute that
  // appears on every report ever rendered would be a wire change for every
  // existing consumer in exchange for saying nothing. A parser that finds it
  // absent reads zero, which is the fact.
  const skippedCount = effectiveCases.filter((entry) => entry.waiver).length;
  const skipped = skippedCount > 0 ? ` skipped="${skippedCount}"` : "";
  const time = (redactedReport.durationMs / 1000).toFixed(3);
  const suiteName = escapeXml(redactedReport.kind);

  const casesXml = effectiveCases
    .map((caseResult) => renderJUnitTestCase(redactedReport.kind, caseResult))
    .join("\n");

  // The decision summary as `<system-out>` on the suite.
  //
  // JUnit has no field for "here is the chain that explains these failures", so
  // it goes in the one place every parser surfaces verbatim. What it may NOT do
  // is omit the chain while the JSON and HTML terminals show it: a team whose CI
  // reads JUnit would then be the only audience that cannot see why a run
  // failed, and they are the audience most likely to be looking.
  const systemOut =
    redactedReport.decisionSummary === undefined
      ? ""
      : `\n    <system-out>${escapeXml(
          formatEvalRunDecisionSummary(redactedReport.decisionSummary)
        )}</system-out>`;

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${suiteName}" tests="${tests}" failures="${failures}"${skipped} time="${time}">\n  <testsuite name="${suiteName}" tests="${tests}" failures="${failures}"${skipped} time="${time}">\n${casesXml}${systemOut}\n  </testsuite>\n</testsuites>\n`;
}

/** `who`, `why`, `until when` — the charter's three facts, on one line. */
function formatWaiverMessage(waiver: StructuredCaseWaiver): string {
  const who = waiver.createdByEmail ?? waiver.createdBy;
  return `Gate WAIVED by ${who} until ${new Date(
    waiver.expiresAt
  ).toISOString()} — ${waiver.reason}`;
}

/**
 * Minimal HTML report: decision summary + failures, self-contained (inline
 * `<style>`, no scripts/fonts/external assets) because CI artifacts are
 * opened from disk — often over `file://` with no network. The paid HTML
 * tiers (traces, parity, history) are out of scope; this is summary+failures
 * only, per PRD §18.2.
 *
 * Redaction MUST come first, exactly like `renderStructuredRunJUnitXml`:
 * `--out` and `--reporter` are two terminals for the same artifact, and
 * rendering from the raw report would reopen the gap `renderStructuredRunJson`
 * exists to close (see `cli/src/lib/reporting.ts`'s `writeJsonArtifact`).
 */
export function renderStructuredRunHtml(report: StructuredRunReport): string {
  const redacted = renderStructuredRunJson(report);
  const status = reportHtmlStatus(redacted);
  const failedCases = redacted.cases.filter((entry) => !entry.passed);
  const observedFailures = failedCases.filter(
    (entry) => !isDiagnosticCase(entry)
  );
  const diagnosticCases = failedCases.filter((entry) =>
    isDiagnosticCase(entry)
  );

  // Waived cases are `passed: true`, so they are NOT in `failedCases` and
  // would otherwise be the one thing this page never mentioned — a report that
  // silently rendered an overridden failure as a clean run.
  const waivedCases = redacted.cases.filter((entry) => entry.waiver);

  const sections = [
    renderHtmlHeader(redacted, status),
    // Immediately under the header, ABOVE the summary: on a waived report this
    // is the reason the page is not what it otherwise appears to be, and a
    // reader who scrolls no further must still have seen it.
    renderHtmlWaiverSection(waivedCases),
    renderHtmlSummary(
      redacted.summary,
      observedFailures.length === 0 && diagnosticCases.length > 0
    ),
    redacted.decisionSummary
      ? renderHtmlDecisionSummary(redacted.decisionSummary)
      : "",
    renderHtmlCaseSection("Failures", observedFailures, false),
    renderHtmlCaseSection("Not measured", diagnosticCases, true),
  ]
    .filter((section) => section.length > 0)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(redacted.kind)} report</title>
<style>${STRUCTURED_RUN_HTML_STYLE}</style>
</head>
<body>
<main>
${sections}
</main>
</body>
</html>
`;
}

type StructuredRunHtmlStatus = "pass" | "fail" | "neutral" | "waived";

/**
 * `inconclusive` is NOT a failure — B4's contract: the run did not measure
 * the server well enough to say, so folding it into "failed" would report a
 * defect the run never observed. Painting it red is the bug; amber/neutral
 * is the only correct rendering. `passed` alone can't distinguish
 * "inconclusive" from "failed" (both leave it `false`), so `verdict` — when
 * present — is read first.
 */
function reportHtmlStatus(
  report: StructuredRunReport
): StructuredRunHtmlStatus {
  if (report.verdict === "inconclusive") return "neutral";
  if (report.verdict === "passed") return "pass";
  if (report.verdict === "failed") return "fail";
  // Its own colour, not green and not red. Green would be the silent waiver
  // the charter forbids; red would report a blocked release that is not
  // blocked. The `passed` fallback below cannot reach this — `report.passed`
  // is false for a waived run — which is exactly why the verdict is read
  // first.
  if (report.verdict === "waived") return "waived";
  return report.passed ? "pass" : "fail";
}

/**
 * The waiver banner: who, why, until when, and what it overrode.
 *
 * Rendered from the CASES rather than from a second report-level copy of the
 * payload, so there is exactly one place a waiver's facts live in a structured
 * report and no way for two renderings of the same waiver to disagree.
 */
function renderHtmlWaiverSection(cases: StructuredCaseResult[]): string {
  if (cases.length === 0) return "";

  const items = cases
    .map((entry) => {
      const waiver = entry.waiver!;
      const who = waiver.createdByEmail ?? waiver.createdBy;
      const overrode = waiver.policySnapshot
        ? `<p>Overrode: minimum pass rate ${waiver.policySnapshot.minimumPassRate}</p>`
        : "";
      return `<article class="case case-waived">
  <h3>${escapeHtml(entry.title)} <span class="note">(${escapeHtml(
    entry.category
  )})</span></h3>
  <p>Waived by <strong>${escapeHtml(who)}</strong></p>
  <p>Reason: ${escapeHtml(waiver.reason)}</p>
  <p>Expires: ${escapeHtml(new Date(waiver.expiresAt).toISOString())}</p>
  ${overrode}
</article>`;
    })
    .join("\n");

  return `<section class="waivers">
  <h2>Waived (${cases.length})</h2>
  <p class="note">This gate did not pass on its own evidence. An authorized user overrode it, on the record, until the expiry below.</p>
  ${items}
</section>`;
}

/**
 * Whether a non-passed case is a diagnostic explaining why nothing was
 * measured (a gate/compare report's synthetic case for a fetch failure,
 * cancellation, timeout, or non-gateable policy) rather than an observed
 * regression.
 *
 * This is a PER-CASE property, unlike the report's overall verdict: an
 * `inconclusive` gate/compare report can still carry genuinely failed
 * iteration rows alongside its own non-gateable diagnostic (e.g. real
 * failures plus a policy the run couldn't be gated against) — collapsing
 * the whole report to one status would paint those real failures neutral
 * too and hide them under "Not measured", which is worse than the
 * red/neutral conflation this file exists to fix. `classification:
 * "informational"` is the existing marker for exactly this (`gateCase` in
 * run-compare.ts, `gateReportCase` in the CLI, `createSyntheticCase`
 * below) — a real failure is never given it.
 */
function isDiagnosticCase(entry: StructuredCaseResult): boolean {
  return entry.classification === "informational";
}

/**
 * `inconclusive` and `notEstablished` are both NEUTRAL, for the same reason the
 * report's own status is: neither is a measured failure. Painting either red
 * reports a defect the run did not observe — and `notEstablished` has not even
 * reached the validity phase that withholds an `inconclusive`.
 */
function decisionVerdictHtmlStatus(
  verdict: EvalRunDecisionSummary["verdict"]
): StructuredRunHtmlStatus {
  if (verdict === "passed") return "pass";
  if (verdict === "failed") return "fail";
  return "neutral";
}

function renderHtmlHeader(
  report: StructuredRunReport,
  status: StructuredRunHtmlStatus
): string {
  const label = report.verdict ?? (report.passed ? "passed" : "failed");
  return `<header class="report-header">
  <h1>${escapeHtml(report.kind)}</h1>
  <span class="badge badge-${status}">${escapeHtml(label)}</span>
  <p class="meta">Duration: ${formatHtmlDurationMs(report.durationMs)}</p>
</header>`;
}

function renderHtmlSummary(
  summary: StructuredRunSummary,
  failuresAreAllDiagnostic: boolean
): string {
  const buckets = [
    renderHtmlBucketTable("By category", summary.byCategory),
    summary.byClassification
      ? renderHtmlBucketTable("By classification", summary.byClassification)
      : "",
  ]
    .filter((section) => section.length > 0)
    .join("\n");
  // The count itself is accurate either way — these cases really are
  // `passed: false` — but "N failed" alone reads as a confirmed regression.
  // When every one of them is a diagnostic explaining why nothing could be
  // measured (not an observed failure), say so.
  const note = failuresAreAllDiagnostic
    ? ' <span class="note">(not measured, not a confirmed regression)</span>'
    : "";

  return `<section class="summary">
  <h2>Summary</h2>
  <p class="totals">${summary.passed}/${summary.total} passed, ${summary.failed} failed${note}</p>
  ${buckets}
</section>`;
}

function renderHtmlBucketTable(
  title: string,
  buckets: Record<string, StructuredSummaryBucket>
): string {
  const entries = Object.entries(buckets);
  if (entries.length === 0) return "";

  const rows = entries
    .map(
      ([name, bucket]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${bucket.passed}/${
          bucket.total
        }</td><td>${bucket.failed}</td></tr>`
    )
    .join("\n");

  return `<table class="bucket-table">
  <caption>${escapeHtml(title)}</caption>
  <thead><tr><th>Name</th><th>Passed</th><th>Failed</th></tr></thead>
  <tbody>
  ${rows}
  </tbody>
</table>`;
}

/**
 * The decision summary, rendered from the canonical contract.
 *
 * Every enum goes through the label maps beside the contract, so this page and
 * the CLI's human output say the same words about the same run — `User value`,
 * not `userValue`. HTML and JSON are two terminals for ONE object: whatever
 * this section omits, `decisionSummary` in the JSON still carries, and the two
 * must not disagree about the verdict, the unit, the first failed stage, the
 * category or the next action.
 */
function renderHtmlDecisionSummary(summary: EvalRunDecisionSummary): string {
  const status = decisionVerdictHtmlStatus(summary.verdict);
  const verdict = EVAL_RUN_DECISION_VERDICT_LABELS[summary.verdict];
  const source = EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS[summary.verdictSource];
  const counts = summary.counts;
  // The unit is printed WITH the numbers. A policy-v2 run counts case
  // execution variants and a legacy one counts trials, so a bare "2/3" is a
  // different claim in each and there is nothing in the digits that says which.
  const countLine =
    counts === undefined
      ? ""
      : counts.measurementUnit === "caseVariant"
      ? `${counts.passed}/${counts.total} ${escapeHtml(
          measurementUnitLabel("caseVariant", counts.total)
        )} passed, ${counts.failed} failed${
          counts.inconclusive > 0 ? `, ${counts.inconclusive} inconclusive` : ""
        }`
      : [
          counts.total !== undefined && counts.passed !== undefined
            ? `${counts.passed}/${counts.total} ${escapeHtml(
                measurementUnitLabel("trial", counts.total)
              )} passed`
            : "",
          counts.failed !== undefined ? `${counts.failed} failed` : "",
        ]
          .filter((part) => part.length > 0)
          .join(", ");

  const why = [
    ...(summary.undecided
      ? [
          `<p class="note">${escapeHtml(
            decisionUndecidedText(summary.undecided)
          )}</p>`,
        ]
      : []),
    ...(summary.decision?.reasons ?? []).map(
      (reason) =>
        `<p class="note">${escapeHtml(
          EVAL_VERDICT_DECISION_REASON_LABELS[reason]
        )}</p>`
    ),
  ].join("\n  ");

  const { items, scannedIterations, complete } = summary.diagnostics;
  // Stated rather than implied: an empty list from a partial page is not "no
  // failures", and a reader who cannot tell the two apart will read it as one.
  const scope = complete
    ? ""
    : ' <span class="note">(PARTIAL — more trials were not examined)</span>';
  const diagnosticsLine = `<p class="totals">${items.length} non-passing of ${scannedIterations} ${escapeHtml(
    measurementUnitLabel("trial", scannedIterations)
  )} examined${scope}</p>`;

  const cases = items.map((item) => renderHtmlDecisionCase(item)).join("\n");

  return `<section class="decision-summary">
  <h2>Decision summary</h2>
  <p>
    <span class="badge badge-${status}">${escapeHtml(verdict)}</span>
    <span class="note">${escapeHtml(source)}</span>${
    countLine.length > 0 ? `\n    ${countLine}` : ""
  }
  </p>
  ${why}
  ${diagnosticsLine}
  ${cases}
</section>`;
}

function decisionUndecidedText(
  undecided: NonNullable<EvalRunDecisionSummary["undecided"]>
): string {
  const reason = EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS[undecided.reason];
  return undecided.detail ? `${reason} — ${undecided.detail}` : reason;
}

function renderHtmlDecisionCase(item: EvalRunDecisionDiagnostic): string {
  const chain = item.chain;
  const failedRow =
    chain.status === "verified" && chain.firstFailedStage !== undefined
      ? chain.stages.find((entry) => entry.stage === chain.firstFailedStage)
      : undefined;

  const stageLine =
    chain.status === "verified"
      ? chain.firstFailedStage !== undefined
        ? `First failed stage: ${escapeHtml(
            USER_VALUE_STAGE_LABELS[chain.firstFailedStage]
          )}${
            failedRow?.reason
              ? ` — ${escapeHtml(STAGE_REASON_LABELS[failedRow.reason])}`
              : ""
          }`
        : "First failed stage: none was established — the run never reached the server's stages"
      : chain.status === "unverified"
      ? "First failed stage: not established — the recorded stage chain did not validate, so it is withheld"
      : "First failed stage: not established — this run recorded no stage chain";

  const category =
    chain.status === "verified" && chain.failureCategory !== undefined
      ? `Failure category: ${escapeHtml(
          FAILURE_CATEGORY_LABELS[chain.failureCategory]
        )}`
      : "Failure category: not reported";

  const evidenceParts = [
    ...(item.evidence.spanIds
      ? [`span ids ${item.evidence.spanIds.join(", ")}`]
      : []),
    ...(item.evidence.promptIndexes
      ? [`prompt indexes ${item.evidence.promptIndexes.join(", ")}`]
      : []),
    ...(item.evidence.reasons
      ? [`reasons ${item.evidence.reasons.join(", ")}`]
      : []),
  ];

  const parts = [
    `<p class="stage-line">${stageLine}</p>`,
    `<p>${category}</p>`,
    chain.status !== "absent" && chain.analyzerVersionAhead
      ? `<p class="note">Stage chain came from a newer analyzer (version ${chain.analyzerVersionAhead.reported}; this build knows ${chain.analyzerVersionAhead.known})</p>`
      : "",
    item.expected
      ? `<p>Expected tool calls: ${escapeHtml(
          item.expected.toolNames.join(", ")
        )}</p>`
      : "",
    item.observed?.toolNames
      ? `<p>Observed tool calls: ${escapeHtml(
          item.observed.toolNames.join(", ")
        )}</p>`
      : "",
    item.observed?.failure
      ? `<p>Observed failure: ${escapeHtml(item.observed.failure)}</p>`
      : "",
    // Named with the stage it was read from, because that is the only stage it
    // is evidence ABOUT. The passing stages have spans of their own and they
    // do not explain this failure.
    evidenceParts.length > 0
      ? `<p>Evidence${
          item.evidence.stage
            ? ` at ${escapeHtml(USER_VALUE_STAGE_LABELS[item.evidence.stage])}`
            : ""
        }: ${escapeHtml(evidenceParts.join("; "))}</p>`
      : "",
    `<p class="note">Trace: ${escapeHtml(item.evidence.tracePath)}</p>`,
    `<p class="next-action">Next action: ${escapeHtml(item.nextAction)}</p>`,
  ]
    .filter((part) => part.length > 0)
    .join("\n  ");

  const identity = [
    item.caseId ?? item.testCaseId ?? undefined,
    `iteration ${item.iterationNumber}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");

  return `<article class="decision-case">
  <h3>${escapeHtml(
    item.title ?? item.iterationId
  )} <span class="note">(${escapeHtml(identity)})</span></h3>
  ${parts}
</article>`;
}

/**
 * Renders one group of non-passed cases — observed failures (red) or
 * diagnostics explaining why nothing was measured (neutral). Split by
 * `isDiagnosticCase` rather than the report's overall status: a gate/
 * compare report can carry genuinely failed rows alongside its own
 * non-gateable diagnostic, and collapsing the whole report to one status
 * would paint real failures neutral too — hiding them, which is worse
 * than the red/neutral conflation this file exists to fix.
 */
function renderHtmlCaseSection(
  heading: "Failures" | "Not measured",
  cases: StructuredCaseResult[],
  neutral: boolean
): string {
  if (cases.length === 0) return "";

  const items = cases.map((entry) => renderHtmlCase(entry, neutral)).join("\n");
  const headingText =
    heading === "Failures" ? `Failures (${cases.length})` : heading;

  return `<section class="failed-cases">
  <h2>${headingText}</h2>
  ${items}
</section>`;
}

function renderHtmlCase(entry: StructuredCaseResult, neutral: boolean): string {
  const details = entry.details
    ? `<pre class="details">${escapeHtml(
        JSON.stringify(entry.details, null, 2)
      )}</pre>`
    : "";
  const caseClass = neutral ? "case-neutral" : "case-fail";
  const errorClass = neutral ? "note" : "error";

  return `<article class="case ${caseClass}">
  <h3>${escapeHtml(entry.title)} <span class="note">(${escapeHtml(
    entry.category
  )})</span></h3>
  ${
    entry.error ? `<p class="${errorClass}">${escapeHtml(entry.error)}</p>` : ""
  }
  ${details}
</article>`;
}

function formatHtmlDurationMs(durationMs: number): string {
  return `${durationMs}ms`;
}

const STRUCTURED_RUN_HTML_STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 2rem;
    line-height: 1.5;
    background: Canvas;
    color: CanvasText;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1, h2, h3 { line-height: 1.25; }
  h2 { margin-top: 2rem; border-bottom: 1px solid GrayText; padding-bottom: 0.25rem; }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-weight: 600;
    font-size: 0.85rem;
    text-transform: uppercase;
  }
  .badge.badge-pass { background: #1a7f37; color: #fff; }
  .badge.badge-fail { background: #cf222e; color: #fff; }
  .badge.badge-neutral { background: #9a6700; color: #fff; }
  /* Violet: deliberately neither the green of a pass nor the red of a
     failure, so a waived report cannot be mistaken for either at a glance. */
  .badge.badge-waived { background: #6639ba; color: #fff; }
  article.case-fail { border-left: 4px solid #cf222e; }
  article.case-neutral { border-left: 4px solid #9a6700; }
  article.case-waived { border-left: 4px solid #6639ba; }
  .meta, .note { color: GrayText; font-size: 0.9rem; }
  table.bucket-table { border-collapse: collapse; margin: 0.5rem 0 1rem; width: 100%; }
  table.bucket-table th, table.bucket-table td {
    text-align: left;
    padding: 0.25rem 0.75rem 0.25rem 0;
    border-bottom: 1px solid color-mix(in srgb, GrayText 30%, transparent);
  }
  article.decision-case, article.case {
    border: 1px solid color-mix(in srgb, GrayText 30%, transparent);
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
    margin: 0.75rem 0;
  }
  .error { color: #cf222e; font-weight: 600; }
  pre.details {
    white-space: pre-wrap;
    word-break: break-word;
    background: color-mix(in srgb, CanvasText 6%, Canvas);
    padding: 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.85rem;
  }
`;

function createStructuredSummaryBucket(): StructuredSummaryBucket {
  return {
    total: 0,
    passed: 0,
    failed: 0,
  };
}

function updateBucket(bucket: StructuredSummaryBucket, passed: boolean): void {
  bucket.total += 1;
  if (passed) {
    bucket.passed += 1;
  } else {
    bucket.failed += 1;
  }
}

function createSyntheticCase(
  kind: string,
  passed: boolean
): StructuredCaseResult {
  if (!passed) {
    return {
      id: `${kind}:failed`,
      title: "failed",
      category: "validation",
      passed: false,
      classification: "informational",
      error: "Run failed without individual cases.",
    };
  }

  if (kind === "server-diff") {
    return {
      id: "server-diff:no-drift",
      title: "no-drift",
      category: "protocol",
      passed: true,
      classification: "informational",
    };
  }

  if (kind === "tools-call-validation") {
    return {
      id: "tools-call-validation:validation-passed",
      title: "validation-passed",
      category: "validation",
      passed: true,
      classification: "informational",
    };
  }

  return {
    id: `${kind}:passed`,
    title: "passed",
    category: "validation",
    passed: true,
    classification: "informational",
  };
}

function renderJUnitTestCase(
  kind: string,
  caseResult: StructuredCaseResult
): string {
  const testcaseName = escapeXml(caseResult.title);
  const testcaseClassname = escapeXml(resolveJUnitClassname(kind, caseResult));
  const testcaseTime = ((caseResult.durationMs ?? 0) / 1000).toFixed(3);

  // A WAIVED case is neither a pass nor a failure, and JUnit already has the
  // word for that. `<skipped>` is read by every CI parser and renders as its
  // own third state, so the build is not failed by the artifact (which is what
  // the waiver was granted for) while the report still refuses to show a clean
  // green row. The three required facts ride in the `message`, because that is
  // the part a CI UI actually displays.
  //
  // Checked BEFORE `passed`: a waived case is `passed: true` so it does not
  // inflate the suite's failure count, and the plain-pass branch below would
  // otherwise swallow it and emit exactly the silent waiver this forbids.
  if (caseResult.waiver) {
    const waiverMessage = escapeXml(formatWaiverMessage(caseResult.waiver));
    const waiverBody = escapeXml(JSON.stringify(caseResult.waiver));
    return `    <testcase name="${testcaseName}" classname="${testcaseClassname}" time="${testcaseTime}">\n      <skipped message="${waiverMessage}">${waiverBody}</skipped>\n    </testcase>`;
  }

  if (caseResult.passed) {
    return `    <testcase name="${testcaseName}" classname="${testcaseClassname}" time="${testcaseTime}"/>`;
  }

  const failureMessage = escapeXml(caseResult.error ?? "Check failed");
  const failureBody = caseResult.details
    ? escapeXml(JSON.stringify(caseResult.details))
    : "";

  return `    <testcase name="${testcaseName}" classname="${testcaseClassname}" time="${testcaseTime}">\n      <failure message="${failureMessage}">${failureBody}</failure>\n    </testcase>`;
}

function resolveJUnitClassname(
  kind: string,
  caseResult: StructuredCaseResult
): string {
  if (caseResult.id === "server-diff:no-drift") {
    return "mcpjam.server-diff";
  }

  if (caseResult.id === "tools-call-validation:validation-passed") {
    return "mcpjam.tools-call-validation";
  }

  if (caseResult.id === `${kind}:passed`) {
    return `mcpjam.${kind}`;
  }

  return `mcpjam.${kind}.${sanitizeToken(caseResult.category)}`;
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/**
 * Make a string legal to put inside XML 1.0 at all.
 *
 * Entity-escaping is not enough. XML 1.0 forbids most control characters
 * OUTRIGHT — they cannot even be written as character references — and an
 * unpaired surrogate is equally fatal. One of either in a `<failure message=…>`
 * produces a file no JUnit parser will read, and the failure then surfaces
 * inside the CI runner's parser with nothing pointing back at the report that
 * caused it.
 *
 * This is reachable input, not a theoretical one: an eval case's failure text
 * is an iteration's `error`, which is model- and server-authored.
 *
 * Rendered as a visible `\uXXXX` escape rather than dropped, because the byte
 * is usually the interesting half of the message.
 */
function toXmlSafeText(value: string): string {
  return (
    value
      // C0 controls except tab (\u0009), LF (\u000A) and CR (\u000D), plus DEL.
      .replace(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,
        escapeAsCodePoint
      )
      // With the `u` flag a matched surrogate is necessarily an UNPAIRED one:
      // a valid pair is one code point above the BMP and never enters this class.
      .replace(/[\uD800-\uDFFF]/gu, escapeAsCodePoint)
  );
}

function escapeAsCodePoint(char: string): string {
  return `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

function escapeXml(value: string): string {
  return toXmlSafeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
