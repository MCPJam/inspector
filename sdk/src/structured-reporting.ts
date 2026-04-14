import { redactSensitiveValue } from "./redaction.js";

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
  return redactSensitiveValue(report) as StructuredRunReport;
}

export function renderStructuredRunJUnitXml(
  report: StructuredRunReport
): string {
  const redactedReport = renderStructuredRunJson(report);
  const effectiveCases =
    redactedReport.cases.length > 0
      ? redactedReport.cases
      : [createSyntheticPassingCase(redactedReport.kind)];

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

function createSyntheticPassingCase(kind: string): StructuredCaseResult {
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
