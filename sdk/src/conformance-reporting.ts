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
import { deepJsonSafe } from "./json-safe.js";
import { redactForTelemetry } from "./telemetry-redaction.js";
import type { ConformanceProfileStamp } from "./conformance-profile.js";
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
import {
  isDispositiveClaudeFinding,
  type ClaudeReadinessFinding,
  type ClaudeReadinessResult,
} from "./claude-readiness/types.js";
import {
  isOpenAIReadinessResult,
  type OpenAIReadinessResult,
} from "./openai-readiness/types.js";
import {
  isDispositiveDirectoryFinding,
  type DirectoryReadinessFinding,
} from "./directory-readiness/types.js";

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
  | "claude-directory-readiness"
  // Likewise not a suite. Same reasoning as the Claude entry above: it grades a
  // publisher's listing policy, carries no `score`, and is excluded from
  // `pooledConformanceScore` by construction.
  | "openai-directory-readiness";

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
  /**
   * The active profile does not score this check. It ran and its verdict is
   * reported verbatim, but it must not turn a build red: the frozen profile
   * exists so a MUST added this week cannot retroactively fail a server that
   * was green last week, and a reporter that emitted `<failure>` for it would
   * reopen exactly that hole on the CI channel while the exit code stayed 0.
   */
  pending?: boolean;
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
  /**
   * Which questions the run asked, and which build asked them (see
   * `conformance-profile.ts`). Present for the protocol suite (`mcp-protocol`)
   * and the Tasks suite (`mcp-tasks`); absent for the suites that carry no
   * profile yet, and for reports produced before profiles existed.
   *
   * A reader comparing two reports must check this first, and must check the
   * ID as well as the version: two scores from different profile versions are
   * not the same measurement, and two scores from different profile IDs are not
   * even the same question set.
   */
  profile?: ConformanceProfileStamp;
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
  | ClaudeReadinessResult
  | OpenAIReadinessResult;

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

  // Reports get persisted, and the persistence layer rejects class instances
  // (a raw MCPAuthError in `errorDetails` used to fail the whole report
  // write). The check helpers already sanitize what they attach; this is the
  // shared last line for every suite's detail payload.
  return deepJsonSafe(Object.fromEntries(entries));
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

function reportCaseFromMcpCheck(
  check: MCPCheckResult,
  pendingIds?: ReadonlySet<string>,
): ConformanceReportCase {
  return {
    id: check.id,
    title: check.title,
    category: check.category,
    status: check.status,
    ...(pendingIds?.has(check.id) ? { pending: true } : {}),
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

/**
 * Apps and Tasks checks share a result shape, so they share a case mapper.
 *
 * `pendingIds` is threaded here for the same reason it is on the protocol
 * mapper: JUnit renders a pending case as `<skipped>`, and without it a failing
 * PENDING Tasks check emitted `<failure>` while the run exited 0 — reopening the
 * retroactive-failure hole the frozen profile exists to close, on the one
 * channel most teams gate on. Apps carries no profile yet, so it passes
 * `undefined` and nothing changes there.
 */
function reportCaseFromCheck(
  check: MCPAppsCheckResult | MCPTasksCheckResult,
  pendingIds?: ReadonlySet<string>,
): ConformanceReportCase {
  return {
    id: check.id,
    title: check.title,
    category: check.category,
    status: check.status,
    ...(pendingIds?.has(check.id) ? { pending: true } : {}),
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
  if (
    outcome !== "passed" &&
    outcome !== "failed" &&
    outcome !== "incomplete"
  ) {
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
    cases: (() => {
      const pendingIds = new Set(result.profile?.pendingCheckIds ?? []);
      return result.checks.map((check) =>
        reportCaseFromMcpCheck(check, pendingIds),
      );
    })(),
  };
}

function appsGroupFromResult(
  result: MCPAppsConformanceResult | MCPTasksConformanceResult,
  title: string,
  index: number,
  idPrefix = "apps",
): ConformanceReportGroup {
  // Read off the RESULT rather than passed in: the Tasks runner stamps its own
  // `mcp-tasks` profile, and reading it here keeps the two from disagreeing
  // about which checks that run scored.
  const pendingIds = new Set(
    (result as { profile?: { pendingCheckIds?: string[] } }).profile
      ?.pendingCheckIds ?? [],
  );
  return {
    id: `${idPrefix}-${index + 1}`,
    title,
    target: result.target,
    passed: result.passed,
    durationMs: result.durationMs,
    summary: result.summary,
    cases: result.checks.map((check) =>
      reportCaseFromCheck(check, pendingIds),
    ),
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

/**
 * The profile every run in a matrix shares, if they share one. A single run
 * without a stamp is enough to make the answer "none": the pooled score then
 * mixes a scored check from one run with a pending one from another, and a
 * label that hid that would be worse than no label.
 */
function sharedProfileFields(
  results: ReadonlyArray<{ profile?: ConformanceProfileStamp }>,
): { profile?: ConformanceProfileStamp } {
  const first = results[0]?.profile;
  if (!first) return {};
  const same = results.every(
    (entry) =>
      entry.profile?.profileId === first.profileId &&
      entry.profile?.profileVersion === first.profileVersion &&
      entry.profile?.manifestDigest === first.manifestDigest,
  );
  return same ? { profile: first } : {};
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
      score: pooledConformanceScore(
        result.results.map(scoreFromProtocolResult),
      ),
      // Only when every run in the matrix asked the same questions. A suite
      // whose runs disagree (different profile versions, or one run without a
      // stamp) has no single profile to name, and naming one of them would
      // label the pooled number with an identity it does not have.
      ...sharedProfileFields(result.results),
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
    ...(result.profile ? { profile: result.profile } : {}),
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
/**
 * What the generic readiness renderer needs to know about ONE publisher.
 *
 * `kind` alone is not enough, and assuming it was is what would break the
 * moment a second publisher appeared. Two things vary per provider and neither
 * is derivable from a string: how to RECOGNISE that provider's result among
 * the union `toConformanceReport` accepts, and which of its findings are
 * DISPOSITIVE. Claude's structural discriminator — lanes + findings + badges —
 * matches OpenAI's result too, so a renderer that switched on shape alone
 * would label an OpenAI grade "Claude Directory Readiness". Passing the type
 * predicate in makes each provider responsible for identifying its own
 * results, and passing the dispositive policy in keeps the renderer from
 * baking in one publisher's idea of what fails a lane.
 */
export interface DirectoryReadinessRenderPolicy {
  /** The report kind this provider stamps onto its reports. */
  kind: ConformanceReportKind;
  /** Human-readable report name. */
  providerName: string;
  /**
   * Whether a finding can DECIDE a lane, and therefore renders as a testcase
   * rather than an advisory. Supplied by the provider so the renderer and that
   * provider's `decideLaneStatus` cannot drift into disagreeing about the same
   * finding.
   */
  isDispositive: (finding: GenericReadinessFinding) => boolean;
}

export interface DirectoryReadinessReportProvider<
  Result extends SupportedConformanceResult,
> extends DirectoryReadinessRenderPolicy {
  /** Recognise this provider's result within the accepted union. */
  isResult: (result: SupportedConformanceResult) => result is Result;
}

/**
 * The readiness result shape the renderer actually reads.
 *
 * Structural rather than a union of the concrete result types: the renderer
 * touches lanes, findings and a target, and naming the fields it uses keeps a
 * third publisher from having to edit this file to be renderable.
 */
interface GenericReadinessFinding {
  id: string;
  title: string;
  lane: string;
  class: string;
  status: string;
  remediation?: string;
  source: unknown;
  provenance: string;
  intrusiveness: string;
  requiresCapabilities?: string[];
  notEvaluatedReason?: string;
  details?: Record<string, unknown>;
  derivedFrom?: string[];
}

interface GenericReadinessResult {
  status: "ready" | "not-ready" | "incomplete";
  summary: string;
  context: { target: string };
  lanes: { lane: string; status: string; summary: string }[];
  findings: GenericReadinessFinding[];
  durationMs: number;
}

function isClaudeReadinessResult(
  result: SupportedConformanceResult,
): result is ClaudeReadinessResult {
  return (
    "lanes" in result &&
    "findings" in result &&
    "badges" in result &&
    // NOT structural alone. OpenAI's readiness result carries lanes, findings
    // and badges too, so the shape test that used to be sufficient would now
    // route an OpenAI grade into the Claude adapter and publish it under
    // Anthropic's name. `readinessKind` is the explicit discriminator; its
    // ABSENCE means Claude, because Claude's result predates the field and
    // adding it would have been a breaking change to a published shape.
    !("readinessKind" in result)
  );
}

/**
 * Only findings that can DECIDE a lane become testcases; everything else is an
 * advisory. A CI job that fails on a heuristic teaches its owners to ignore the
 * job, and a capability badge is not a defect at all.
 */
export const CLAUDE_READINESS_REPORT_PROVIDER: DirectoryReadinessReportProvider<ClaudeReadinessResult> =
  {
    kind: "claude-directory-readiness",
    providerName: "Claude Directory Readiness",
    isResult: isClaudeReadinessResult,
    // The predicate itself is imported rather than restated, so the renderer
    // and `decideLaneStatus` cannot drift into disagreeing about the same
    // finding.
    isDispositive: (finding) =>
      isDispositiveClaudeFinding(
        finding as unknown as Pick<ClaudeReadinessFinding, "class">,
      ),
  };

function readinessCaseStatus(
  finding: GenericReadinessFinding,
): ConformanceReportCaseStatus {
  if (finding.status === "violated") return "failed";
  if (finding.status === "satisfied") return "passed";
  return "skipped";
}

/**
 * Render any publisher's readiness result into the shared report shape.
 *
 * DELIBERATELY NO `score`, for any provider. Readiness grades a publisher's
 * listing policy, not the MCP spec, and pooling it with the four conformance
 * suites would put directory paperwork into a protocol-conformance number.
 */
function createDirectoryReadinessReport(
  result: GenericReadinessResult,
  provider: DirectoryReadinessRenderPolicy,
): ConformanceReport {
  const isDispositiveFinding = provider.isDispositive;
  const advisories: ConformanceReportAdvisory[] = [];
  // `lanes` and `findings` are independent arrays on the result, so nothing in
  // the type says every finding's lane appears in `lanes`. When it does not,
  // an unconsumed finding — a VIOLATED requirement included — would vanish
  // from the report with no counter and no error. Tracking what was consumed
  // and sweeping the remainder into advisories keeps the report total.
  const consumed = new Set<GenericReadinessFinding>();
  const groups: ConformanceReportGroup[] = result.lanes.map((lane) => {
    const laneFindings = result.findings.filter(
      (finding) => finding.lane === lane.lane,
    );
    for (const finding of laneFindings) {
      consumed.add(finding);
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

  for (const finding of result.findings) {
    if (consumed.has(finding)) continue;
    // Orphaned: its lane was not reported. Rendered as an advisory rather than
    // dropped, and tagged with the lane it CLAIMED, so the gap is visible in
    // the output instead of being invisible in it.
    advisories.push({
      id: finding.id,
      title: finding.title,
      group: finding.lane,
      kind: finding.class,
      status: finding.status,
      message:
        finding.remediation ??
        finding.notEvaluatedReason ??
        `reported outside any lane in this result`,
      details: buildDetailPayload({
        provenance: finding.provenance,
        source: finding.source,
        orphanedLane: finding.lane,
      }),
    });
  }

  return {
    schemaVersion: 1,
    kind: provider.kind,
    name: provider.providerName,
    passed: result.status === "ready",
    outcome:
      result.status === "ready"
        ? "passed"
        : result.status === "not-ready"
          ? "failed"
          : "incomplete",
    incompleteReason:
      result.status === "incomplete" ? result.summary : undefined,
    // DELIBERATELY NO `score` — see the docblock above.
    durationMs: result.durationMs,
    groups,
    advisories,
  };
}

/**
 * Every readiness provider, in the order `toConformanceReport` tries them.
 *
 * A registry rather than a chain of `if`s so adding a publisher is one entry
 * here plus its own module — and so the ONE thing that must stay true across
 * providers, that exactly one recognises any given result, is visible in a
 * single place.
 */
/**
 * OpenAI's descriptor.
 *
 * `isResult` tests the explicit `readinessKind` rather than the shape, because
 * the shape is IDENTICAL to Claude's — lanes, findings, badges — and a
 * structural test would route whichever result was tried first.
 *
 * `isDispositive` is the shared predicate rather than a publisher-specific one:
 * both products agree that `required` and `runtime-blocker` decide a lane, and
 * a second copy of that rule would be a second place for the renderer and the
 * grader to disagree about the same finding.
 */
export const OPENAI_READINESS_REPORT_PROVIDER: DirectoryReadinessReportProvider<OpenAIReadinessResult> =
  {
    kind: "openai-directory-readiness",
    providerName: "OpenAI Plugin Directory Readiness",
    isResult: (result): result is OpenAIReadinessResult =>
      isOpenAIReadinessResult(result),
    isDispositive: (finding) =>
      isDispositiveDirectoryFinding(
        finding as unknown as Pick<
          DirectoryReadinessFinding<string, unknown, string>,
          "class"
        >,
      ),
  };

const READINESS_REPORT_PROVIDERS: DirectoryReadinessReportProvider<never>[] = [
  // OpenAI first: its `readinessKind` test is exact, while Claude's recognises
  // "a readiness result with no kind". Ordering the exact test first means
  // neither provider depends on the other's negative case.
  OPENAI_READINESS_REPORT_PROVIDER as unknown as DirectoryReadinessReportProvider<never>,
  CLAUDE_READINESS_REPORT_PROVIDER as unknown as DirectoryReadinessReportProvider<never>,
];

/**
 * Register a readiness provider from outside this module.
 *
 * Exists so a publisher module owns its own descriptor instead of this file
 * importing every publisher's result type — the import direction that would
 * make `conformance-reporting` depend on every readiness product there will
 * ever be.
 */
export function registerDirectoryReadinessProvider<
  Result extends SupportedConformanceResult,
>(provider: DirectoryReadinessReportProvider<Result>): void {
  if (
    READINESS_REPORT_PROVIDERS.some((known) => known.kind === provider.kind)
  ) {
    return;
  }
  // BEFORE THE CATCH-ALL, not after it. Claude's `isResult` recognises "a
  // readiness result with no `readinessKind`", which is a shape a new
  // publisher's result can match by accident — appending would then hand every
  // registered provider's results to Claude's adapter and publish them under
  // Anthropic's name. The ordering invariant this file states is that exact
  // discriminators run first, and appending is the one operation that breaks
  // it silently.
  const catchAll = READINESS_REPORT_PROVIDERS.indexOf(
    CLAUDE_READINESS_REPORT_PROVIDER as unknown as DirectoryReadinessReportProvider<never>,
  );
  READINESS_REPORT_PROVIDERS.splice(
    catchAll === -1 ? READINESS_REPORT_PROVIDERS.length : catchAll,
    0,
    provider as unknown as DirectoryReadinessReportProvider<never>,
  );
}

/** The first provider that recognises this result, if any. */
function matchReadinessProvider(
  result: SupportedConformanceResult,
): DirectoryReadinessReportProvider<never> | undefined {
  return READINESS_REPORT_PROVIDERS.find((provider) =>
    provider.isResult(result),
  );
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
  result: OpenAIReadinessResult,
): ConformanceReport;
export function toConformanceReport(
  result: SupportedConformanceResult,
): ConformanceReport;
export function toConformanceReport(
  result: SupportedConformanceResult,
): ConformanceReport {
  // First: readiness is not a suite, and every discriminator below is written
  // for suite shapes.
  const readinessProvider = matchReadinessProvider(result);
  if (readinessProvider) {
    return createDirectoryReadinessReport(
      result as unknown as GenericReadinessResult,
      readinessProvider,
    );
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
      // `mcp-tasks`, never `mcp-protocol` — the two suites are separately
      // versioned so a Tasks addition cannot move the protocol denominator.
      ...(result.profile ? { profile: result.profile } : {}),
      durationMs: result.durationMs,
      groups: [
        appsGroupFromResult(result, "MCP Tasks Conformance", 0, "tasks"),
      ],
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

  // A pending check renders as `<skipped>` carrying its real verdict, never as
  // `<failure>`. The run's exit code already refuses to fail on it; emitting a
  // failure here would turn the CI job red anyway — the retroactive-failure
  // hole the frozen profile exists to close, reopened on the one channel most
  // teams actually gate on.
  if (testCase.pending) {
    const note = escapeXml(
      `unscored by the active profile${testCase.error ? `: ${testCase.error}` : ""}`,
    );
    return `    <testcase name="${name}" classname="${escapedClassname}" time="${time}">\n      <skipped message="${note}"/>\n    </testcase>`;
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
  // The tallies follow what the cases RENDER as, or the attribute would
  // contradict the elements beneath it: a pending check is emitted as
  // `<skipped>` regardless of its verdict, so it counts as skipped here.
  const failures = group.cases.filter(
    (entry) => entry.status === "failed" && !entry.pending,
  ).length;
  const skipped = group.cases.filter(
    (entry) => entry.status === "skipped" || entry.pending,
  ).length;
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
  // Same rule as the per-suite tallies: pending cases render as `<skipped>`,
  // so they are counted as skipped and never as failures.
  const failures = redactedReport.groups.reduce(
    (sum, group) =>
      sum +
      group.cases.filter((entry) => entry.status === "failed" && !entry.pending)
        .length,
    0,
  );
  const skipped = redactedReport.groups.reduce(
    (sum, group) =>
      sum +
      group.cases.filter(
        (entry) => entry.status === "skipped" || entry.pending,
      ).length,
    0,
  );
  const time = (redactedReport.durationMs / 1000).toFixed(3);
  const name = escapeXml(redactedReport.name);

  const advisories = redactedReport.advisories ?? [];
  const suites = redactedReport.groups
    .map((group) =>
      renderConformanceTestSuite(group, redactedReport.score, advisories),
    )
    .join("\n");

  // An advisory whose `group` names no rendered testsuite would otherwise be
  // filtered away in silence — present in the JSON report, absent from the
  // JUnit output, with nothing saying so. It gets its own suite instead.
  const renderedGroups = new Set(
    redactedReport.groups.map((group) => group.id),
  );
  const orphanedAdvisories = advisories.filter(
    (advisory) => !renderedGroups.has(advisory.group),
  );
  const orphanSuite =
    orphanedAdvisories.length > 0
      ? `\n  <testsuite name="mcpjam.advisories" tests="0" failures="0" skipped="0" time="0.000">\n    <properties>\n${renderAdvisoryProperties(
          orphanedAdvisories,
        )}\n    </properties>\n  </testsuite>`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">\n${suites}${orphanSuite}\n</testsuites>\n`;
}
