import { redactSensitiveValue } from "./redaction.js";
import type {
  MCPConformanceResult,
  MCPConformanceSuiteResult,
  MCPCheckResult,
} from "./mcp-conformance/index.js";
import type {
  ConformanceResult as OAuthConformanceResult,
  OAuthConformanceSuiteResult,
  StepResult as OAuthConformanceStepResult,
} from "./oauth-conformance/index.js";
import type {
  MCPAppsConformanceResult,
  MCPAppsConformanceSuiteResult,
  MCPAppsCheckResult,
} from "./apps-conformance/index.js";

export type ConformanceReportKind =
  | "protocol-conformance"
  | "oauth-conformance"
  | "apps-conformance";

export type ConformanceReportCaseStatus = "passed" | "failed" | "skipped";

export interface ConformanceReportCase {
  id: string;
  title: string;
  category: string;
  status: ConformanceReportCaseStatus;
  durationMs: number;
  description?: string;
  error?: string;
  details?: unknown;
  output?: string;
}

export interface ConformanceReportGroup {
  id: string;
  title: string;
  target: string;
  passed: boolean;
  durationMs: number;
  summary?: string;
  cases: ConformanceReportCase[];
}

export interface ConformanceReport {
  schemaVersion: 1;
  kind: ConformanceReportKind;
  name: string;
  passed: boolean;
  durationMs: number;
  groups: ConformanceReportGroup[];
}

type SupportedSingleConformanceResult =
  | MCPConformanceResult
  | OAuthConformanceResult
  | MCPAppsConformanceResult;

type SupportedSuiteConformanceResult =
  | MCPConformanceSuiteResult
  | OAuthConformanceSuiteResult
  | MCPAppsConformanceSuiteResult;

export type SupportedConformanceResult =
  | SupportedSingleConformanceResult
  | SupportedSuiteConformanceResult;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function buildDetailPayload(parts: Record<string, unknown>): unknown {
  const entries = Object.entries(parts).filter(([, value]) => {
    if (value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (isPlainObject(value)) {
      return Object.keys(value).length > 0;
    }
    return true;
  });

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function summarizeHttpAttempts(
  step: Pick<OAuthConformanceStepResult, "httpAttempts">,
): string | undefined {
  if (step.httpAttempts.length === 0) {
    return undefined;
  }

  return step.httpAttempts
    .map((attempt) => {
      const request = `${attempt.request.method} ${attempt.request.url}`;
      const response = attempt.response
        ? `${attempt.response.status} ${attempt.response.statusText}`
        : "No response";
      return `${request} → ${response}`;
    })
    .join("\n");
}

function reportCaseFromMcpCheck(check: MCPCheckResult): ConformanceReportCase {
  return {
    id: check.id,
    title: check.title,
    category: check.category,
    status: check.status,
    durationMs: check.durationMs,
    description: check.description,
    ...(check.error?.message ? { error: check.error.message } : {}),
    ...(check.details !== undefined || check.error?.details !== undefined
      ? {
          details: buildDetailPayload({
            details: check.details,
            errorDetails: check.error?.details,
          }),
        }
      : {}),
  };
}

function reportCaseFromAppsCheck(
  check: MCPAppsCheckResult,
): ConformanceReportCase {
  return {
    id: check.id,
    title: check.title,
    category: check.category,
    status: check.status,
    durationMs: check.durationMs,
    description: check.description,
    ...(check.error?.message ? { error: check.error.message } : {}),
    ...(check.details !== undefined ||
    check.error?.details !== undefined ||
    check.warnings?.length
      ? {
          details: buildDetailPayload({
            details: check.details,
            errorDetails: check.error?.details,
            warnings: check.warnings,
          }),
        }
      : {}),
  };
}

function reportCaseFromOAuthStep(
  step: OAuthConformanceStepResult,
): ConformanceReportCase {
  const output = summarizeHttpAttempts(step);
  return {
    id: step.step,
    title: step.title || step.step,
    category: "oauth",
    status: step.status,
    durationMs: step.durationMs,
    description: step.summary,
    ...(step.error?.message ? { error: step.error.message } : {}),
    ...(step.error?.details !== undefined || step.teachableMoments?.length
      ? {
          details: buildDetailPayload({
            errorDetails: step.error?.details,
            teachableMoments: step.teachableMoments,
          }),
        }
      : {}),
    ...(output ? { output } : {}),
  };
}

function mcpGroupFromResult(
  result: MCPConformanceResult,
  title: string,
  index: number,
): ConformanceReportGroup {
  return {
    id: `mcp-${index + 1}`,
    title,
    target: result.serverUrl,
    passed: result.passed,
    durationMs: result.durationMs,
    summary: result.summary,
    cases: result.checks.map(reportCaseFromMcpCheck),
  };
}

function appsGroupFromResult(
  result: MCPAppsConformanceResult,
  title: string,
  index: number,
): ConformanceReportGroup {
  return {
    id: `apps-${index + 1}`,
    title,
    target: result.target,
    passed: result.passed,
    durationMs: result.durationMs,
    summary: result.summary,
    cases: result.checks.map(reportCaseFromAppsCheck),
  };
}

function oauthGroupFromResult(
  result: OAuthConformanceResult,
  title: string,
  index: number,
): ConformanceReportGroup {
  return {
    id: `oauth-${index + 1}`,
    title,
    target: result.serverUrl,
    passed: result.passed,
    durationMs: result.durationMs,
    summary: result.summary,
    cases: result.steps.map(reportCaseFromOAuthStep),
  };
}

function isMcpSingleResult(
  result: SupportedConformanceResult,
): result is MCPConformanceResult {
  return (
    "checks" in result &&
    !("results" in result) &&
    "serverUrl" in result &&
    !("target" in result)
  );
}

function isAppsSingleResult(
  result: SupportedConformanceResult,
): result is MCPAppsConformanceResult {
  return "checks" in result && !("results" in result) && "target" in result;
}

function isOAuthSingleResult(
  result: SupportedConformanceResult,
): result is OAuthConformanceResult {
  return "steps" in result && !("results" in result);
}

function isMcpSuiteResult(
  result: SupportedConformanceResult,
): result is MCPConformanceSuiteResult {
  return (
    "results" in result &&
    "serverUrl" in result &&
    !("target" in result) &&
    result.results.length > 0 &&
    "checks" in result.results[0]
  );
}

function isAppsSuiteResult(
  result: SupportedConformanceResult,
): result is MCPAppsConformanceSuiteResult {
  return "results" in result && "target" in result;
}

function isOAuthSuiteResult(
  result: SupportedConformanceResult,
): result is OAuthConformanceSuiteResult {
  return (
    "results" in result &&
    "serverUrl" in result &&
    !("target" in result) &&
    result.results.length > 0 &&
    "steps" in result.results[0]
  );
}

function createProtocolReport(
  result: MCPConformanceResult | MCPConformanceSuiteResult,
): ConformanceReport {
  if ("results" in result) {
    return {
      schemaVersion: 1,
      kind: "protocol-conformance",
      name: result.name,
      passed: result.passed,
      durationMs: result.durationMs,
      groups: result.results.map((entry, index) =>
        mcpGroupFromResult(entry, entry.label, index),
      ),
    };
  }

  return {
    schemaVersion: 1,
    kind: "protocol-conformance",
    name: "MCP Protocol Conformance",
    passed: result.passed,
    durationMs: result.durationMs,
    groups: [mcpGroupFromResult(result, "MCP Protocol Conformance", 0)],
  };
}

function createAppsReport(
  result: MCPAppsConformanceResult | MCPAppsConformanceSuiteResult,
): ConformanceReport {
  if ("results" in result) {
    return {
      schemaVersion: 1,
      kind: "apps-conformance",
      name: result.name,
      passed: result.passed,
      durationMs: result.durationMs,
      groups: result.results.map((entry, index) =>
        appsGroupFromResult(entry, entry.label, index),
      ),
    };
  }

  return {
    schemaVersion: 1,
    kind: "apps-conformance",
    name: "MCP Apps Conformance",
    passed: result.passed,
    durationMs: result.durationMs,
    groups: [appsGroupFromResult(result, "MCP Apps Conformance", 0)],
  };
}

function createOAuthReport(
  result: OAuthConformanceResult | OAuthConformanceSuiteResult,
): ConformanceReport {
  if ("results" in result) {
    return {
      schemaVersion: 1,
      kind: "oauth-conformance",
      name: result.name,
      passed: result.passed,
      durationMs: result.durationMs,
      groups: result.results.map((entry, index) =>
        oauthGroupFromResult(entry, entry.label, index),
      ),
    };
  }

  return {
    schemaVersion: 1,
    kind: "oauth-conformance",
    name: "OAuth Conformance",
    passed: result.passed,
    durationMs: result.durationMs,
    groups: [
      oauthGroupFromResult(
        result,
        `${result.protocolVersion}/${result.registrationStrategy}`,
        0,
      ),
    ],
  };
}

export function toConformanceReport(
  result: MCPConformanceResult,
): ConformanceReport;
export function toConformanceReport(
  result: MCPConformanceSuiteResult,
): ConformanceReport;
export function toConformanceReport(
  result: OAuthConformanceResult,
): ConformanceReport;
export function toConformanceReport(
  result: OAuthConformanceSuiteResult,
): ConformanceReport;
export function toConformanceReport(
  result: MCPAppsConformanceResult,
): ConformanceReport;
export function toConformanceReport(
  result: MCPAppsConformanceSuiteResult,
): ConformanceReport;
export function toConformanceReport(
  result: SupportedConformanceResult,
): ConformanceReport;
export function toConformanceReport(
  result: SupportedConformanceResult,
): ConformanceReport {
  if (isMcpSingleResult(result) || isMcpSuiteResult(result)) {
    return createProtocolReport(result);
  }

  if (isAppsSingleResult(result) || isAppsSuiteResult(result)) {
    return createAppsReport(result);
  }

  if (isOAuthSingleResult(result) || isOAuthSuiteResult(result)) {
    return createOAuthReport(result);
  }

  throw new Error("Unsupported conformance result shape");
}

export function renderConformanceReportJson(
  report: ConformanceReport,
): ConformanceReport {
  return redactSensitiveValue(report) as ConformanceReport;
}

function renderConformanceTestCase(
  testCase: ConformanceReportCase,
  classname: string,
): string {
  const name = escapeXml(testCase.title);
  const time = (testCase.durationMs / 1000).toFixed(3);
  const escapedClassname = escapeXml(classname);

  if (testCase.status === "skipped") {
    return `    <testcase name="${name}" classname="${escapedClassname}" time="${time}">\n      <skipped/>\n    </testcase>`;
  }

  if (testCase.status === "failed") {
    const message = escapeXml(testCase.error ?? "Check failed");
    const body = testCase.output
      ? escapeXml(testCase.output)
      : testCase.details !== undefined
        ? escapeXml(JSON.stringify(testCase.details))
        : "";

    return `    <testcase name="${name}" classname="${escapedClassname}" time="${time}">\n      <failure message="${message}">${body}</failure>\n    </testcase>`;
  }

  return `    <testcase name="${name}" classname="${escapedClassname}" time="${time}"/>`;
}

function renderConformanceTestSuite(group: ConformanceReportGroup): string {
  const name = escapeXml(group.title);
  const tests = group.cases.length;
  const failures = group.cases.filter((entry) => entry.status === "failed").length;
  const skipped = group.cases.filter((entry) => entry.status === "skipped").length;
  const time = (group.durationMs / 1000).toFixed(3);
  const classname = group.target || `mcpjam.${sanitizeToken(group.id)}`;

  const cases = group.cases
    .map((entry) => renderConformanceTestCase(entry, classname))
    .join("\n");

  return `  <testsuite name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">\n${cases}\n  </testsuite>`;
}

export function renderConformanceReportJUnitXml(
  report: ConformanceReport,
): string {
  const redactedReport = renderConformanceReportJson(report);
  const tests = redactedReport.groups.reduce(
    (sum, group) => sum + group.cases.length,
    0,
  );
  const failures = redactedReport.groups.reduce(
    (sum, group) =>
      sum + group.cases.filter((entry) => entry.status === "failed").length,
    0,
  );
  const skipped = redactedReport.groups.reduce(
    (sum, group) =>
      sum + group.cases.filter((entry) => entry.status === "skipped").length,
    0,
  );
  const time = (redactedReport.durationMs / 1000).toFixed(3);
  const name = escapeXml(redactedReport.name);

  const suites = redactedReport.groups.map(renderConformanceTestSuite).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">\n${suites}\n</testsuites>\n`;
}
