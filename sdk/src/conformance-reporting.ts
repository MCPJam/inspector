import type {
  ConformanceRunOutcome,
  ConformanceSkipReason,
} from "./conformance-outcome.js";
import {
  describeConformanceScore,
  pooledConformanceScore,
  scoreFromAppsResult,
  scoreFromOAuthResult,
  scoreFromProtocolResult,
  scoreFromTasksResult,
  type ConformanceScore,
} from "./conformance-score.js";
import { redactForTelemetry } from "./telemetry-redaction.js";
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
import type {
  MCPTasksConformanceResult,
  MCPTasksCheckResult,
} from "./tasks-conformance/index.js";
import type {
  ClaudeReadinessFinding,
  ClaudeReadinessResult,
} from "./claude-readiness/types.js";

export type ConformanceReportKind =
  | "protocol-conformance"
  | "oauth-conformance"
  | "apps-conformance"
  | "tasks-conformance"
  // NOT a fifth conformance suite. Claude directory readiness grades a
  // PUBLISHER'S POLICY, not the MCP specification, so it carries no
  // `score` and is excluded from `pooledConformanceScore` by construction —
  // the adapter below simply never sets the field. Consumers that switch on
  // this union must treat it as an advisory-bearing report rather than a
  // conformance verdict they can pool.
  | "claude-directory-readiness";

export type ConformanceReportCaseStatus = "passed" | "failed" | "skipped";

/**
 * A statement that is REPORTED but never graded.
 *
 * Heuristics, recommendations, capability badges and things a human has to
 * look at all belong here. They exist because suppressing them would lose real
 * signal, and they are kept out of `cases` because a CI job that fails on an
 * LLM's opinion — or on a capability the server was never required to have —
 * teaches its owners to ignore the job. JUnit renders these as `<properties>`,
 * never as failed testcases.
 */
export interface ConformanceReportAdvisory {
  id: string;
  title: string;
  /** Id of the {@link ConformanceReportGroup} this advisory was raised in. */
  group: string;
  /** What kind of statement it is, e.g. a finding class. */
  kind: string;
  /** The verdict, in the vocabulary of whatever produced it. */
  status: string;
  message?: string;
  details?: unknown;
}

export interface ConformanceReportCase {
  id: string;
  title: string;
  category: string;
  status: ConformanceReportCaseStatus;
  /**
   * Why a skipped case produced no verdict. CI needs this: a
   * `"not-applicable"` skip left nothing unverified, while a
   * `"could-not-run"` skip means an obligation went untested.
   */
  skipReason?: ConformanceSkipReason;
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
  /** True only when `outcome` is `"passed"`. */
  passed: boolean;
  /**
   * The three-value verdict. Absent only for suites that predate it, so
   * consumers should treat a missing value as `passed ? "passed" : "failed"`.
   */
  outcome?: ConformanceRunOutcome;
  incompleteReason?: string;
  /**
   * The 0–100 conformance score (see `conformance-score.ts`). For a suite,
   * the pooled score over its runs. `score.score` is null when nothing was
   * applicable — e.g. OAuth against a server that serves without auth.
   */
  score?: ConformanceScore;
  durationMs: number;
  groups: ConformanceReportGroup[];
  /**
   * Ungraded statements. Absent for the conformance suites, which have none;
   * present for readiness, whose experience-insights lane is entirely
   * advisory. Adding an OPTIONAL field keeps `schemaVersion` at 1 — an older
   * consumer reading a readiness report ignores it and still gets a valid
   * report, which is the property a version bump would otherwise be asserting.
   */
  advisories?: ConformanceReportAdvisory[];
}

type SupportedSingleConformanceResult =
  | MCPConformanceResult
  | OAuthConformanceResult
  | MCPAppsConformanceResult
  | MCPTasksConformanceResult
  | ClaudeReadinessResult;

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
    ...(check.skipReason ? { skipReason: check.skipReason } : {}),
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

/** Apps and Tasks checks share a result shape, so they share a case mapper. */
function reportCaseFromCheck(
  check: MCPAppsCheckResult | MCPTasksCheckResult,
): ConformanceReportCase {
  return {
    id: check.id,
    title: check.title,
    category: check.category,
    status: check.status,
    ...(check.skipReason ? { skipReason: check.skipReason } : {}),
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
    ...(step.error?.details !== undefined ||
    step.warnings?.length ||
    step.teachableMoments?.length
      ? {
          details: buildDetailPayload({
            errorDetails: step.error?.details,
            warnings: step.warnings,
            teachableMoments: step.teachableMoments,
          }),
        }
      : {}),
    ...(output ? { output } : {}),
  };
}

/**
 * The three-value verdict for a single-run report. Declared on
 * `ConformanceReport` since the skip-taxonomy change but never assigned by any
 * builder, so `json-summary` could not tell a failed run from an incomplete
 * one — exactly the distinction the field exists to carry.
 *
 * OAuth's own outcome union also contains `"not-applicable"`, which the
 * report's three-value union does not; that value is omitted here, and
 * consumers keep the documented fallback (`passed ? "passed" : "failed"`).
 */
function outcomeFields(result: {
  outcome?: string;
  incompleteReason?: string;
}): Pick<ConformanceReport, "outcome" | "incompleteReason"> {
  const outcome = result.outcome;
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "incomplete") {
    return {};
  }
  return {
    outcome,
    ...(result.incompleteReason
      ? { incompleteReason: result.incompleteReason }
      : {}),
  };
}

/**
 * A suite's verdict is the worst of its runs — a failure outranks an
 * incomplete, the same ordering the CLI exit codes use — and the first
 * incomplete run's reason speaks for the suite.
 */
function suiteOutcomeFields(
  results: ReadonlyArray<{
    passed: boolean;
    outcome?: string;
    incompleteReason?: string;
  }>,
): Pick<ConformanceReport, "outcome" | "incompleteReason"> {
  const outcomes = results.map(
    (entry) =>
      outcomeFields(entry).outcome ??
      // OAuth's not-applicable flows carry `passed: false` (they are not
      // passes) but they are not failures either — authorization is OPTIONAL,
      // so a no-auth flow must not drag a suite's verdict to "failed".
      (entry.outcome === "not-applicable"
        ? "passed"
        : entry.passed
          ? "passed"
          : "failed"),
  );
  if (outcomes.includes("failed")) {
    return { outcome: "failed" };
  }
  if (outcomes.includes("incomplete")) {
    const first = results.find(
      (entry) => outcomeFields(entry).outcome === "incomplete",
    );
    return {
      outcome: "incomplete",
      ...(first?.incompleteReason
        ? { incompleteReason: first.incompleteReason }
        : {}),
    };
  }
  return { outcome: "passed" };
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
  result: MCPAppsConformanceResult | MCPTasksConformanceResult,
  title: string,
  index: number,
  idPrefix = "apps",
): ConformanceReportGroup {
  return {
    id: `${idPrefix}-${index + 1}`,
    title,
    target: result.target,
    passed: result.passed,
    durationMs: result.durationMs,
    summary: result.summary,
    cases: result.checks.map(reportCaseFromCheck),
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

function isTasksSingleResult(
  result: SupportedConformanceResult,
): result is MCPTasksConformanceResult {
  return (
    "checks" in result &&
    !("results" in result) &&
    "discovery" in result &&
    isPlainObject(result.discovery) &&
    "wire" in result.discovery
  );
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
      ...suiteOutcomeFields(result.results),
      score: pooledConformanceScore(result.results.map(scoreFromProtocolResult)),
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
    ...outcomeFields(result),
    score: scoreFromProtocolResult(result),
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
      ...suiteOutcomeFields(result.results),
      score: pooledConformanceScore(result.results.map(scoreFromAppsResult)),
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
    ...outcomeFields(result),
    score: scoreFromAppsResult(result),
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
      ...suiteOutcomeFields(result.results),
      score: pooledConformanceScore(result.results.map(scoreFromOAuthResult)),
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
    ...outcomeFields(result),
    score: scoreFromOAuthResult(result),
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

/**
 * Readiness is structurally unlike the suites: `lanes` and `findings` instead
 * of `checks`, and a `status` that is a three-value readiness verdict rather
 * than a pass/fail. Discriminating on `lanes` is enough — no suite has one.
 */
function isClaudeReadinessResult(
  result: SupportedConformanceResult,
): result is ClaudeReadinessResult {
  return "lanes" in result && "findings" in result && "badges" in result;
}

/**
 * Only findings that can DECIDE a lane become testcases.
 *
 * Everything else is an advisory. A CI job that fails on a heuristic teaches
 * its owners to ignore the job, and a capability badge is not a defect at all,
 * so rendering either as a failed testcase would be actively harmful.
 */
function isDispositiveFinding(finding: ClaudeReadinessFinding): boolean {
  return finding.class === "required" || finding.class === "runtime-blocker";
}

function readinessCaseStatus(
  finding: ClaudeReadinessFinding,
): ConformanceReportCaseStatus {
  if (finding.status === "violated") return "failed";
  if (finding.status === "satisfied") return "passed";
  return "skipped";
}

function createClaudeReadinessReport(
  result: ClaudeReadinessResult,
): ConformanceReport {
  const advisories: ConformanceReportAdvisory[] = [];
  const groups: ConformanceReportGroup[] = result.lanes.map((lane) => {
    const laneFindings = result.findings.filter(
      (finding) => finding.lane === lane.lane,
    );
    for (const finding of laneFindings) {
      if (isDispositiveFinding(finding)) continue;
      advisories.push({
        id: finding.id,
        title: finding.title,
        group: lane.lane,
        kind: finding.class,
        status: finding.status,
        message: finding.remediation ?? finding.notEvaluatedReason,
        details: buildDetailPayload({
          provenance: finding.provenance,
          source: finding.source,
          derivedFrom: finding.derivedFrom,
          observed: finding.details,
        }),
      });
    }
    return {
      id: lane.lane,
      title: lane.lane,
      target: result.context.target,
      // A lane that could not be evaluated is not a passing lane; only
      // `ready` is. This is the same rule `decideConformanceOutcome` applies
      // to a suite that skipped half its checks.
      passed: lane.status === "ready",
      durationMs: 0,
      summary: lane.summary,
      cases: laneFindings.filter(isDispositiveFinding).map((finding) => ({
        id: finding.id,
        title: finding.title,
        category: finding.class,
        status: readinessCaseStatus(finding),
        // A finding that was never evaluated left an obligation untested; a
        // finding that could not apply left nothing unverified. The suites
        // draw exactly this line and CI reads it.
        skipReason:
          finding.status === "not-evaluated"
            ? ("could-not-run" as const)
            : finding.status === "not-applicable"
              ? ("not-applicable" as const)
              : undefined,
        durationMs: 0,
        description: finding.remediation,
        error:
          finding.status === "violated"
            ? (finding.remediation ?? "Requirement not satisfied")
            : finding.status === "not-evaluated"
              ? finding.notEvaluatedReason
              : undefined,
        details: buildDetailPayload({
          provenance: finding.provenance,
          intrusiveness: finding.intrusiveness,
          source: finding.source,
          requiresCapabilities: finding.requiresCapabilities,
          derivedFrom: finding.derivedFrom,
          observed: finding.details,
        }),
      })),
    };
  });

  return {
    schemaVersion: 1,
    kind: "claude-directory-readiness",
    name: "Claude Directory Readiness",
    passed: result.status === "ready",
    outcome:
      result.status === "ready"
        ? "passed"
        : result.status === "not-ready"
          ? "failed"
          : "incomplete",
    incompleteReason:
      result.status === "incomplete" ? result.summary : undefined,
    // DELIBERATELY NO `score`. Readiness grades Anthropic's policy, not the
    // MCP spec, and pooling it with the four conformance suites would put a
    // publisher's listing requirements into a protocol-conformance number.
    durationMs: result.durationMs,
    groups,
    advisories,
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
  result: MCPTasksConformanceResult,
): ConformanceReport;
export function toConformanceReport(
  result: ClaudeReadinessResult,
): ConformanceReport;
export function toConformanceReport(
  result: SupportedConformanceResult,
): ConformanceReport;
export function toConformanceReport(
  result: SupportedConformanceResult,
): ConformanceReport {
  // First: readiness is not a suite, and every discriminator below is written
  // for suite shapes.
  if (isClaudeReadinessResult(result)) {
    return createClaudeReadinessReport(result);
  }

  if (isMcpSingleResult(result) || isMcpSuiteResult(result)) {
    return createProtocolReport(result);
  }

  if (isTasksSingleResult(result)) {
    return {
      schemaVersion: 1,
      kind: "tasks-conformance",
      name: "MCP Tasks Conformance",
      passed: result.passed,
      ...outcomeFields(result),
      score: scoreFromTasksResult(result),
      durationMs: result.durationMs,
      groups: [appsGroupFromResult(result, "MCP Tasks Conformance", 0, "tasks")],
    };
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
  return redactForTelemetry(report) as ConformanceReport;
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

/**
 * Advisories as `<properties>`, which is the only JUnit element that can carry
 * "here is something you should know" without asserting a verdict.
 *
 * The alternative — a `<testcase>` with `<failure>` — would make every CI job
 * that runs readiness go red on a heuristic, and the alternative after that is
 * that everyone adds `|| true`. Property names are namespaced by advisory id
 * so two lanes cannot collide.
 */
function renderAdvisoryProperties(
  advisories: ConformanceReportAdvisory[],
): string {
  return advisories
    .map((advisory) => {
      const value = advisory.message
        ? `${advisory.kind}/${advisory.status}: ${advisory.title} — ${advisory.message}`
        : `${advisory.kind}/${advisory.status}: ${advisory.title}`;
      return `      <property name="mcpjam.advisory.${escapeXml(
        sanitizeToken(advisory.id),
      )}" value="${escapeXml(value)}"/>`;
    })
    .join("\n");
}

function renderConformanceTestSuite(
  group: ConformanceReportGroup,
  score: ConformanceScore | undefined,
  advisories: ConformanceReportAdvisory[] = [],
): string {
  const name = escapeXml(group.title);
  const tests = group.cases.length;
  const failures = group.cases.filter((entry) => entry.status === "failed").length;
  const skipped = group.cases.filter((entry) => entry.status === "skipped").length;
  const time = (group.durationMs / 1000).toFixed(3);
  const classname = group.target || `mcpjam.${sanitizeToken(group.id)}`;

  // JUnit's XSDs put <properties> under <testsuite>, never under the
  // <testsuites> root — a root-level block is schema-invalid to Jenkins and
  // friends. The score is REPORT-level (pooled for suites), so every
  // testsuite carries the same values; the property names say so.
  const scoreProperties = score
    ? `      <property name="mcpjam.conformance.score" value="${
        score.score === null ? "not-scored" : String(score.score)
      }"/>\n      <property name="mcpjam.conformance.summary" value="${escapeXml(
        describeConformanceScore(score),
      )}"/>`
    : "";
  const groupAdvisories = advisories.filter(
    (advisory) => advisory.group === group.id,
  );
  const advisoryProperties = renderAdvisoryProperties(groupAdvisories);
  const propertyLines = [scoreProperties, advisoryProperties].filter(Boolean);
  const properties =
    propertyLines.length > 0
      ? `    <properties>\n${propertyLines.join("\n")}\n    </properties>\n`
      : "";

  const cases = group.cases
    .map((entry) => renderConformanceTestCase(entry, classname))
    .join("\n");

  return `  <testsuite name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">\n${properties}${cases}\n  </testsuite>`;
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

  const suites = redactedReport.groups
    .map((group) =>
      renderConformanceTestSuite(
        group,
        redactedReport.score,
        redactedReport.advisories ?? [],
      ),
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">\n${suites}\n</testsuites>\n`;
}
