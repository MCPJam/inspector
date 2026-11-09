/**
 * Shared durable conformance execution for hosted UI and the GitHub worker.
 *
 * Creates the Convex run first, streams suite progress into report rows, and
 * finalizes once every requested suite has settled. Directory readiness is
 * deliberately absent — it grades publisher policy and must never enter the
 * conformance score or CI verdict.
 *
 * Every suite dials through the hosted egress guard no matter which caller
 * started the run: see {@link guardPersistedConformanceTransport}.
 */

import {
  isHttpServerConfig,
  isKnownProtocolVersion,
  redactConformanceReportForSharing,
  runConformance,
  type ConformanceReport,
  type ConformanceRunProgress,
  type ConformanceSuiteKind,
  type MCPServerConfig,
  type OAuthConformanceConfig,
} from "@mcpjam/sdk";
import { createConvexClient } from "./evals/route-helpers.js";
import { reconcileHeadlessOAuthScope } from "./conformance-oauth-headless-scope.js";
import { logger } from "../utils/logger.js";
import { redactHostedTransportFailures } from "../utils/hosted-transport-failure-redaction.js";
import { HOSTED_TRANSPORT_FAILURE_DETAIL } from "../utils/hosted-doctor-redaction.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
  assertAllowedHostedTargetUrl,
} from "../utils/hosted-egress-guard.js";
import { createConformanceFetch } from "../routes/shared/conformance.js";
import {
  deadlineFetch,
  runWithConformanceSignal,
} from "../routes/shared/conformance-deadline.js";
import { convexErrorData } from "../routes/v1/convex-errors.js";
import { isSelected } from "../../shared/conformance-settings.js";
import { startConformanceRunLifecycle } from "./conformance-run-lifecycle.js";
import {
  suiteConfigsForRun,
  type ConformanceRunSettings,
} from "./conformance-run-settings.js";
import { isAnalyticsDisabled } from "../utils/analytics.js";
import { resolveEnvironment } from "../utils/log-events.js";

export type ConformanceRunSource =
  | "ui"
  | "sdk"
  | "cli"
  | "github_action"
  | "github_app"
  | "api"
  | "benchmark";

/**
 * How the SDK counts a hosted run as `conformance_run_triggered`. The SDK
 * sends to the production PostHog project, so only a prod deployment with
 * analytics on labels the run; a staging or dev run would read as prod
 * usage. UI runs are counted in the browser, and SDK/CLI runs never come
 * through here, so every other source stays quiet.
 */
function conformanceRunTelemetry(
  source: ConformanceRunSource,
):
  | { __telemetryRunSource: "api" | "github_app" | "benchmark" }
  | { __suppressTelemetry: true } {
  if (
    (source === "api" || source === "github_app" || source === "benchmark") &&
    !isAnalyticsDisabled() &&
    resolveEnvironment() === "prod"
  ) {
    return { __telemetryRunSource: source };
  }
  return { __suppressTelemetry: true };
}

export type ExecutePersistedConformanceArgs = {
  convexToken: string;
  projectId: string;
  /**
   * The target. A `baseFetch` (or `fetchFn`) on it is the transport every
   * suite dials through, and it is honored as given; when neither is present
   * the run is put behind the hosted conformance guard anyway — see
   * {@link guardPersistedConformanceTransport}.
   */
  server: MCPServerConfig & { fetchFn?: typeof fetch };
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
   * The saved settings the run applies, read before the start. Absent: every
   * check with no tool inputs, the way the GitHub and benchmark workers run.
   */
  settings?: ConformanceRunSettings;
  /** The run's time budget. Absent: no deadline beyond the backend's sweep. */
  runTimeoutSeconds?: number;
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
    // Advice is part of what the run found, like the score; only each
    // entry's `details` is dropped, to keep this degraded body small.
    ...(report.advisories?.length
      ? {
          advisories: report.advisories.map((advisory) => ({
            id: advisory.id,
            title: advisory.title,
            group: advisory.group,
            kind: advisory.kind,
            status: advisory.status,
            ...(advisory.message !== undefined
              ? { message: advisory.message }
              : {}),
          })),
        }
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

/**
 * Put every suite of a persisted run behind the hosted egress guard, whoever
 * the caller was.
 *
 * WHY HERE. This executor is the one door every persisted run walks through —
 * the public `/v1` start route, the GitHub checks worker and the benchmark
 * worker — and the target of each is a URL somebody else chose: a saved
 * server, a sandbox running a pull request's code, a benchmarked connector.
 * Leaving the guard to each caller is how two of the three came to pass a bare
 * `{ url }`, which the suites dialled through the global fetch: no address
 * classification, and redirects followed wherever they led (pentest finding
 * MJ-001's shape, on a route the doctor fix never touched). A caller that
 * forgets now gets the guard anyway.
 *
 * A DELIBERATE TRANSPORT STILL WINS. A `baseFetch`/`fetchFn` on the server
 * config, or a `fetchFn` on the OAuth config, is used as given — the same rule
 * as `createAuthorizedManager`'s per-server `baseFetch`. The defaults are the
 * transports the hosted conformance routes already dial through, and both are
 * plain `fetch` outside hosted mode, where reaching localhost is the point.
 *
 * EVERY transport is then wrapped by {@link redactHostedTransportFailures}, so
 * a refused or failed dial reaches the persisted report as a verdict or one
 * uniform sentence, never as the resolved address, socket error or TLS text
 * the report is read back with. Also a no-op outside hosted mode.
 */
export function guardPersistedConformanceTransport(args: {
  server: ExecutePersistedConformanceArgs["server"];
  oauth?: OAuthConformanceConfig;
}): {
  server: ExecutePersistedConformanceArgs["server"];
  oauth?: OAuthConformanceConfig;
} {
  // `baseFetch` is the transport the MCP client dials through in every suite;
  // `fetchFn` is what the protocol suite's raw probes use. Either one alone
  // stands in for both, so a caller that set one did not leave the other open.
  // Read structurally: `baseFetch` exists only on the HTTP member of the union.
  const declared = args.server as {
    baseFetch?: typeof fetch;
    fetchFn?: typeof fetch;
  };
  const transport =
    declared.baseFetch ??
    declared.fetchFn ??
    createConformanceFetch("MCP server");
  const probes = declared.fetchFn ?? transport;
  const server = {
    ...args.server,
    baseFetch: redactHostedTransportFailures(transport),
    fetchFn: redactHostedTransportFailures(probes),
  };
  if (!args.oauth) return { server };
  return {
    server,
    oauth: {
      ...args.oauth,
      // The OAuth suite dials URLs it DISCOVERS — metadata, authorization,
      // token and registration endpoints all come out of the target's own
      // documents — so it needs the guard as much as the target itself does.
      fetchFn: redactHostedTransportFailures(
        args.oauth.fetchFn ?? createConformanceFetch("OAuth endpoint")
      ),
    },
  };
}

/**
 * The reason a hosted run must not dial `server` at all, or `null` to proceed.
 *
 * The transport guard above decides each request as it is made, and that is
 * enough for everything that goes through a fetch. It is not enough for the
 * protocol suite's localhost host-header checks, which open raw `node:http`
 * sockets — `fetch` cannot set `Host` — whenever the TARGET is a loopback
 * name. The `/v1` start route refuses such a target before it gets here; the
 * workers did not ask. So the executor judges the starting URL itself, with the
 * same check the routes use, and a target it refuses is never handed to a
 * suite. No-op outside hosted mode, where reaching localhost is the point.
 *
 * The verdict is what gets persisted, so it follows the transport's rules: a
 * refusal keeps its wording (which names the host, never what it resolved
 * to), and a resolver failure becomes the uniform connection message rather
 * than the resolver's own text.
 */
export async function persistedConformanceTargetRefusal(
  server: ExecutePersistedConformanceArgs["server"]
): Promise<string | null> {
  const url = (server as { url?: string | URL }).url;
  if (url === undefined) return null;
  try {
    await assertAllowedHostedTargetUrl(String(url), "Server URL");
    return null;
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) return error.message;
    if (error instanceof EgressResolutionError) {
      return HOSTED_TRANSPORT_FAILURE_DETAIL;
    }
    throw error;
  }
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
      runTimeoutSeconds: args.runTimeoutSeconds,
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

  const lifecycle = startConformanceRunLifecycle({
    runTimeoutSeconds: args.runTimeoutSeconds,
    heartbeat: () =>
      client.mutation(
        "conformanceRuns:heartbeat" as never,
        { runId: started.runId } as never
      ),
    onHeartbeatError: (error) => {
      logger.warn("[conformance-run] heartbeat failed", {
        runId: started.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const persisted = new Set<ConformanceSuiteKind>();
  // The backend refuses a report for a run it already settled
  // (`CONFORMANCE_RUN_IMMUTABLE`). That is a cancel learned late, not a
  // failure, so the run stops instead of throwing.
  const upsertReport = async (
    suiteKind: ConformanceSuiteKind,
    report: unknown,
    status: "completed" | "failed",
    durationMs: number | undefined
  ): Promise<void> => {
    if (lifecycle.cancelled()) return;
    try {
      await client.action(
        "conformanceRuns:upsertReportAction" as never,
        { runId: started.runId, suiteKind, report, status, durationMs } as never
      );
      persisted.add(suiteKind);
    } catch (error) {
      if (convexErrorData(error)?.code !== "CONFORMANCE_RUN_IMMUTABLE") {
        throw error;
      }
      lifecycle.markCancelled();
    }
  };
  const recordIncomplete = (suiteKind: ConformanceSuiteKind, reason: string) => {
    const body = prepareReportForPersistence(
      suiteKind,
      syntheticIncompleteReport(suiteKind, reason),
      args.oauthHeadlessCheckIds
    );
    return upsertReport(suiteKind, body, "failed", body.durationMs);
  };
  const persistProgress = async (
    event: ConformanceRunProgress
  ): Promise<void> => {
    const body = prepareReportForPersistence(
      event.suiteKind,
      event.report ??
        syntheticIncompleteReport(
          event.suiteKind,
          event.error ?? "suite did not produce a report"
        ),
      args.oauthHeadlessCheckIds
    );
    const status = event.status === "completed" ? "completed" : "failed";
    try {
      await upsertReport(
        event.suiteKind,
        jsonSafeReport(body),
        status,
        body.durationMs
      );
    } catch (persistError) {
      // A persistence failure must not rewrite a FINISHED suite as
      // could-not-run: throwing here would bubble into the SDK's suite catch,
      // which reports the suite failed with the serialization complaint as
      // its error. Keep the verdict and degrade only the detail.
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
      // Degraded from the PREPARED body, never the raw report: the fallback
      // carries the verdict and the score forward, and the raw ones describe
      // a scope this exam does not grade.
      const fallback = summaryFallbackReport(body, event.suiteKind, message);
      await upsertReport(
        event.suiteKind,
        jsonSafeReport(fallback),
        status,
        fallback.durationMs
      );
    }
  };
  // Writes the suites began before the run stopped, awaited before the run
  // records what they left unfinished.
  const progressWrites: Promise<void>[] = [];

  try {
    const refusal = await persistedConformanceTargetRefusal(args.server);
    const guarded = guardPersistedConformanceTransport({
      server: args.server,
      oauth: args.oauth,
    });
    const requestedVersion =
      args.protocolVersion && isKnownProtocolVersion(args.protocolVersion)
        ? args.protocolVersion
        : undefined;
    const configs =
      args.settings && refusal === null && isHttpServerConfig(guarded.server)
        ? await suiteConfigsForRun(
            args.settings,
            guarded.server,
            requestedVersion,
            lifecycle.signal
          )
        : undefined;
    // A suite whose saved checks all fall outside the version the run
    // resolved to has nothing to run; the app leaves it out the same way.
    const runSuites = configs?.selection
      ? executionSuites.filter(
          (kind) =>
            kind === "oauth" || isSelected(configs.selection?.[kind])
        )
      : executionSuites;
    const report =
      runSuites.length > 0 && refusal === null
        ? await runWithConformanceSignal(lifecycle.signal, () =>
            runConformance({
              server: stopWithRun(guarded.server, lifecycle.signal),
              suites: runSuites,
              protocolVersion: (configs?.protocolVersion ??
                args.protocolVersion) as never,
              engineVersion: args.engineVersion,
              signal: lifecycle.signal,
              ...(configs?.protocol ? { protocol: configs.protocol } : {}),
              ...(configs?.apps ? { apps: configs.apps } : {}),
              ...(configs?.tasks ? { tasks: configs.tasks } : {}),
              ...(guarded.oauth ? { oauth: guarded.oauth } : {}),
              ...conformanceRunTelemetry(args.source),
              onProgress: (event) => {
                if (event.status === "running") return;
                // Past the deadline or a cancel, a suite still unwinding
                // reports the requests the run cut off, not the server. The
                // run records it as timed out instead.
                if (lifecycle.signal.aborted) return;
                const write = persistProgress(event);
                progressWrites.push(write);
                return write;
              },
            })
          ).catch((error: unknown) => {
            // Past the deadline or cancelled: the suites stop with the signal,
            // and whatever they did not report is recorded below.
            if (lifecycle.signal.aborted) return null;
            throw error;
          })
        : null;
    await Promise.allSettled(progressWrites);

    if (refusal !== null) {
      // Nothing was dialled, so every suite that would have run records the
      // refusal as its could-not-run reason: the run finalizes with an honest
      // verdict instead of three suites' worth of refused requests.
      for (const suiteKind of executionSuites) {
        await recordIncomplete(suiteKind, refusal);
      }
    }
    for (const suiteKind of executionSuites) {
      if (runSuites.includes(suiteKind)) continue;
      await recordIncomplete(
        suiteKind,
        `None of this suite's saved checks apply to MCP protocol version ${configs?.protocolVersion ?? "auto"}, so it did not run.`
      );
    }
    if (lifecycle.signal.aborted && !lifecycle.cancelled()) {
      const reason = lifecycle.signal.reason;
      for (const suiteKind of runSuites) {
        if (persisted.has(suiteKind)) continue;
        await recordIncomplete(
          suiteKind,
          reason instanceof Error ? reason.message : String(reason)
        );
      }
    }

    if (unsupportedOAuth) {
      await recordIncomplete("oauth", unsupportedOAuthReason);
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
    lifecycle.stop();
  }
}

/** Every request a run makes, through either transport, stops when it does. */
function stopWithRun(
  server: ExecutePersistedConformanceArgs["server"],
  signal: AbortSignal
): ExecutePersistedConformanceArgs["server"] {
  const declared = server as { baseFetch?: typeof fetch; fetchFn?: typeof fetch };
  return {
    ...server,
    ...(declared.baseFetch
      ? { baseFetch: deadlineFetch(declared.baseFetch, signal) }
      : {}),
    ...(declared.fetchFn
      ? { fetchFn: deadlineFetch(declared.fetchFn, signal) }
      : {}),
  };
}
