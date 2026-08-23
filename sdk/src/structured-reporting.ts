import { redactForTelemetry } from "./telemetry-redaction.js";
import type { EvalDecisionSummary } from "./eval-decision-summary.js";
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
  summary: StructuredRunSummary;
  cases: StructuredCaseResult[];
  durationMs: number;
  metadata: Record<string, unknown>;
  decisionSummary?: EvalDecisionSummary;
}

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
    decisionSummary?: EvalDecisionSummary;
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
        error:
          input.iterationError ??
          "The complete iteration result set could not be fetched.",
      });
    }

    if (
      input.run.result !== "passed" &&
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
      })),
      ...(options.metadata ?? {}),
    },
    ...(options.decisionSummary
      ? { decisionSummary: options.decisionSummary }
      : {}),
  };
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
  const time = (redactedReport.durationMs / 1000).toFixed(3);
  const suiteName = escapeXml(redactedReport.kind);

  const casesXml = effectiveCases
    .map((caseResult) => renderJUnitTestCase(redactedReport.kind, caseResult))
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${suiteName}" tests="${tests}" failures="${failures}" time="${time}">\n  <testsuite name="${suiteName}" tests="${tests}" failures="${failures}" time="${time}">\n${casesXml}\n  </testsuite>\n</testsuites>\n`;
}

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
