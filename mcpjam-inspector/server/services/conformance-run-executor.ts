/**
 * Shared durable conformance execution for hosted UI and the GitHub worker.
 *
 * Creates the Convex run first, streams suite progress into report rows, and
 * finalizes once every requested suite has settled. Directory readiness is
 * deliberately absent — it grades publisher policy and must never enter the
 * conformance score or CI verdict.
 */

import {
  redactConformanceReportForSharing,
  runConformance,
  type ConformanceReport,
  type ConformanceSuiteKind,
  type MCPServerConfig,
  type OAuthConformanceConfig,
} from "@mcpjam/sdk";
import { createConvexClient } from "./evals/route-helpers.js";
import { reconcileHeadlessOAuthScope } from "./conformance-oauth-headless-scope.js";
import { logger } from "../utils/logger.js";

export type ConformanceRunSource =
  | "ui"
  | "sdk"
  | "cli"
  | "github_action"
  | "github_app"
  | "api"
  | "benchmark";

export type ExecutePersistedConformanceArgs = {
  convexToken: string;
  projectId: string;
  server: MCPServerConfig;
  suites?: ConformanceSuiteKind[];
  source: ConformanceRunSource;
  /**
   * The OAuth suite's configuration, when the caller has one.
   *
   * OAuth is OPT-IN in the SDK — `runConformance` refuses a requested `oauth`
   * suite with no config rather than guessing an auth strategy — so a caller
   * that wants the suite executed has to build this. The hosted benchmark
   * assembles it from the stored connection plus the definition's pins; every
   * other caller today passes nothing and gets the explicit incomplete below.
   */
  oauth?: OAuthConformanceConfig;
  /**
   * The OAuth check ids the pinned exam GRADES, by id.
   *
   * Present only for a run whose definition pins a headless OAuth scope. It is
   * what makes the denominator honest: see
   * `conformance-oauth-headless-scope.ts`, which is where the rule that a
   * check the harness could not reach is `could-not-run` rather than
   * `not-applicable` actually lives. Absent ⇒ the report is persisted exactly
   * as the suite produced it.
   */
  oauthHeadlessCheckIds?: ReadonlyArray<string>;
  target: {
    kind: "server" | "github_repo" | "external";
    serverId?: string;
    githubCheckRepoConfigId?: string;
    serverRef?: string;
    serverUrl?: string;
  };
  protocolVersion?: string;
  engineVersion?: string;
  githubCheckTriggerId?: string;
  actorLabel?: string;
  /**
   * Route-level idempotency. Mapped by the caller onto a namespaced
   * `externalRunId` (`api:<projectId>:<serverId>:<key>`). Absent ⇒ every start inserts.
   */
  externalRunId?: string;
  /**
   * Called with the run id THE MOMENT IT EXISTS, before suites execute. That
   * call is what posts the `conformance` attempt and binds the run.
   *
   * `meta` is how a start-and-detach surface learns whether this was a
   * replay: the mutation returns `reused` only here, and the receipt must
   * report the run's real status rather than a decorative `queued`.
   */
  onRunStarted?: (
    runId: string,
    meta?: { reused?: boolean; status?: string },
  ) => Promise<void>;
};

export type ExecutePersistedConformanceResult = {
  runId: string;
  reused?: boolean;
  outcome?: string | null;
  score?: number | null;
};

/**
 * Deep-copy a report into plain JSON-safe data before it crosses the Convex
 * boundary. The SDK's check helpers already sanitize what they attach, but
 * this write is where one stray class instance (a live run put a raw
 * `MCPAuthError` into `details.errorDetails`) turned a FINISHED report into a
 * "not a supported Convex type" rejection — and the failure handler then
 * replaced the whole report with a could-not-run skip. Kept local on purpose:
 * the persistence boundary must hold no matter which SDK version produced the
 * payload.
 */
function jsonSafeReport(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (depth >= 16) return "[max-depth]";
  if (obj instanceof Date) return obj.toISOString();
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((entry) => jsonSafeReport(entry, depth + 1, seen) ?? null);
    }
    const out: Record<string, unknown> = {};
    if (obj instanceof Error) {
      out.name = obj.name;
      out.message = obj.message;
      const coded = obj as Error & { code?: unknown; statusCode?: unknown };
      if (coded.code !== undefined) {
        out.code = jsonSafeReport(coded.code, depth + 1, seen);
      }
      if (coded.statusCode !== undefined) {
        out.statusCode = jsonSafeReport(coded.statusCode, depth + 1, seen);
      }
    }
    for (const [key, entry] of Object.entries(obj)) {
      const safe = jsonSafeReport(entry, depth + 1, seen);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * When persisting the full report body still fails, the run must keep the
 * finished suite's VERDICT — outcome, score, pass/fail — rather than
 * fabricating a could-not-run skip that erases real results. Only the group
 * detail is degraded, with one case naming the persistence failure.
 */
function summaryFallbackReport(
  report: ConformanceReport,
  kind: ConformanceSuiteKind,
  persistError: string
): ConformanceReport {
  return {
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    name: report.name,
    passed: report.passed,
    ...(report.outcome !== undefined ? { outcome: report.outcome } : {}),
    ...(report.incompleteReason !== undefined
      ? { incompleteReason: report.incompleteReason }
      : {}),
    ...(report.score !== undefined
      ? { score: jsonSafeReport(report.score) as ConformanceReport["score"] }
      : {}),
    durationMs: report.durationMs,
    groups: [
      {
        id: "execution",
        title: "Execution",
        target: "",
        passed: report.passed,
        durationMs: report.durationMs,
        cases: [
          {
            id: `${kind}-report-not-persisted`,
            title: "Suite finished but its detailed report could not be saved",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
            category: "execution",
            error: persistError,
          },
        ],
      },
    ],
  };
}

function syntheticIncompleteReport(
  kind: ConformanceSuiteKind,
  error: string
): ConformanceReport {
  const reportKind =
    kind === "protocol"
      ? "protocol-conformance"
      : kind === "apps"
      ? "apps-conformance"
      : kind === "tasks"
      ? "tasks-conformance"
      : "oauth-conformance";
  return {
    schemaVersion: 1,
    kind: reportKind,
    name: kind,
    passed: false,
    outcome: "incomplete",
    durationMs: 0,
    groups: [
      {
        id: "execution",
        title: "Execution",
        target: "",
        passed: false,
        durationMs: 0,
        cases: [
          {
            id: `${kind}-could-not-run`,
            title: "Suite could not run",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
            category: "execution",
            error,
          },
        ],
      },
    ],
  };
}

/**
 * Everything that has to happen to a report BEFORE it becomes a durable row.
 *
 * Both passes are OAuth-only and both are ordered deliberately:
 *
 *   1. Scope reconciliation runs first, so redaction sees the case list the
 *      run will actually be graded on.
 *   2. REDACTION RUNS HERE, NOT AT PROJECTION TIME. A completed OAuth run
 *      carries a live access token, a refresh token, the client secret and the
 *      `Authorization` header of every request it made (`routes/web/score.ts`
 *      says the same thing at the other place this is enforced). Redacting
 *      when the report is later projected into benchmark evidence would mean
 *      the credentials were already at rest in `conformanceRuns` — readable by
 *      every surface that reads a run, and un-recallable once written.
 */
function prepareReportForPersistence(
  suiteKind: ConformanceSuiteKind,
  report: ConformanceReport,
  oauthHeadlessCheckIds: ReadonlyArray<string> | undefined
): ConformanceReport {
  if (suiteKind !== "oauth") return report;
  const scoped = oauthHeadlessCheckIds?.length
    ? reconcileHeadlessOAuthScope({ report, checkIds: oauthHeadlessCheckIds })
        .report
    : report;
  return redactConformanceReportForSharing(scoped);
}

export async function executePersistedConformanceRun(
  args: ExecutePersistedConformanceArgs
): Promise<ExecutePersistedConformanceResult> {
  const client = createConvexClient(args.convexToken);
  const requestedSuites = (args.suites ?? ["protocol", "apps", "tasks"]).filter(
    (kind): kind is ConformanceSuiteKind =>
      kind === "protocol" ||
      kind === "apps" ||
      kind === "tasks" ||
      kind === "oauth"
  );
  // GitHub App has no interactive OAuth, and a caller that requested the suite
  // without configuring it has no auth strategy to run. Keep OAuth in the
  // persisted requested snapshot either way, but record it as an explicit
  // incomplete suite instead of silently dropping a configured gate — and
  // instead of letting `runConformance` refuse the WHOLE run over one suite it
  // cannot start, which would lose the protocol/apps/tasks reports too.
  const suites = requestedSuites;
  const unsupportedOAuth =
    suites.includes("oauth") && (args.source === "github_app" || !args.oauth);
  const unsupportedOAuthReason =
    args.source === "github_app"
      ? "GitHub App checks cannot complete interactive OAuth authorization"
      : "The OAuth suite was requested without an auth strategy to run it with";
  const executionSuites = unsupportedOAuth
    ? suites.filter((kind) => kind !== "oauth")
    : suites;

  const started = (await client.mutation(
    "conformanceRuns:startRun" as never,
    {
      projectId: args.projectId,
      target: args.target,
      source: args.source,
      requestedSuites: suites,
      protocolVersion: args.protocolVersion,
      engineVersion: args.engineVersion,
      actorLabel: args.actorLabel,
      githubCheckTriggerId: args.githubCheckTriggerId,
      ...(args.externalRunId ? { externalRunId: args.externalRunId } : {}),
    } as never
  )) as {
    runId: string;
    reused?: boolean;
    status?: string;
    outcome?: string | null;
  };

  await args.onRunStarted?.(started.runId, {
    reused: started.reused === true,
    status: started.status,
  });

  // A reused row already has an owner — the request that inserted it.
  // Re-entering `runConformance` for a still-`queued` replay would dial the
  // target twice and write conflicting reports for one run id. Recovery for a
  // dead owner is heartbeat + sweep, never a second execute.
  if (started.reused) {
    return {
      runId: started.runId,
      reused: true,
      outcome: started.outcome ?? null,
    };
  }

  const heartbeat = setInterval(() => {
    void client
      .mutation(
        "conformanceRuns:heartbeat" as never,
        {
          runId: started.runId,
        } as never
      )
      .catch((error: unknown) => {
        logger.warn("[conformance-run] heartbeat failed", {
          runId: started.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, 20_000);
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    const report =
      executionSuites.length > 0
        ? await runConformance({
            server: args.server,
            suites: executionSuites,
            protocolVersion: args.protocolVersion as never,
            engineVersion: args.engineVersion,
            ...(args.oauth ? { oauth: args.oauth } : {}),
            onProgress: async (event) => {
              if (event.status === "running") return;
              const body = prepareReportForPersistence(
                event.suiteKind,
                event.report ??
                  syntheticIncompleteReport(
                    event.suiteKind,
                    event.error ?? "suite did not produce a report"
                  ),
                args.oauthHeadlessCheckIds
              );
              const status =
                event.status === "completed" ? "completed" : "failed";
              try {
                await client.action(
                  "conformanceRuns:upsertReportAction" as never,
                  {
                    runId: started.runId,
                    suiteKind: event.suiteKind,
                    report: jsonSafeReport(body),
                    status,
                    durationMs: body.durationMs,
                  } as never
                );
              } catch (persistError) {
                // A persistence failure must not rewrite a FINISHED suite as
                // could-not-run: throwing here would bubble into the SDK's
                // suite catch, which reports the suite failed with the
                // serialization complaint as its error. Keep the verdict and
                // degrade only the detail.
                if (event.status !== "completed" || !event.report) {
                  throw persistError;
                }
                const message =
                  persistError instanceof Error
                    ? persistError.message
                    : String(persistError);
                logger.warn(
                  "[conformance-run] report body could not be persisted; keeping suite summary",
                  {
                    runId: started.runId,
                    suiteKind: event.suiteKind,
                    error: message,
                  }
                );
                // Degraded from the PREPARED body, never the raw report: the
                // fallback carries the verdict and the score forward, and the
                // raw ones describe a scope this exam does not grade.
                const fallback = summaryFallbackReport(
                  body,
                  event.suiteKind,
                  message
                );
                await client.action(
                  "conformanceRuns:upsertReportAction" as never,
                  {
                    runId: started.runId,
                    suiteKind: event.suiteKind,
                    report: jsonSafeReport(fallback),
                    status,
                    durationMs: fallback.durationMs,
                  } as never
                );
              }
            },
          })
        : null;

    if (unsupportedOAuth) {
      const body = prepareReportForPersistence(
        "oauth",
        syntheticIncompleteReport("oauth", unsupportedOAuthReason),
        args.oauthHeadlessCheckIds
      );
      await client.action(
        "conformanceRuns:upsertReportAction" as never,
        {
          runId: started.runId,
          suiteKind: "oauth",
          report: body,
          status: "failed",
          durationMs: body.durationMs,
        } as never
      );
    }

    const finalized = (await client.mutation(
      "conformanceRuns:finalizeRun" as never,
      { runId: started.runId } as never
    )) as { outcome?: string | null; score?: number | null };

    return {
      runId: started.runId,
      outcome: finalized.outcome ?? report?.outcome,
      score: finalized.score ?? report?.score.score,
    };
  } finally {
    clearInterval(heartbeat);
  }
}
