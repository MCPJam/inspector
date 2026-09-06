/**
 * Starting a hosted directory-readiness run, once, for every surface.
 *
 * Three callers create these runs — the public `/api/v1` endpoints, the
 * `/api/web` endpoints the conformance panel uses, and (through the platform
 * client) the CLI. What they legitimately differ on is how a caller proves who
 * it is and what an answer looks like on the wire. What they must NOT differ
 * on is the part in here: which transports may be graded, which submission
 * shapes a hosted run can grade at all, where the target comes from, and
 * whether a replayed start executes anything.
 *
 * The last one is why this is shared rather than copied. A surface that got
 * the replay rule slightly wrong would dial a third party's server twice for
 * one logical request — and it would do it only on retries, which is exactly
 * the traffic nobody is watching when the feature is demoed.
 *
 * AUTHORIZATION IS THE CALLER'S JOB, deliberately. Each surface already has
 * its own exchange for turning a request into an authorized server row, and a
 * helper that tried to do that too would need to understand three auth
 * schemes. This function takes the RESULT of that exchange and refuses to
 * take a URL any other way.
 */

import type { ConvexHttpClient } from "convex/browser";
import type { OpenAISubmissionMode } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { createStreamingPinnedFetch } from "../../utils/pinned-fetch.js";
import { executeHostedReadinessRun } from "../../services/readiness/worker.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import type { ServerAnalyticsActor } from "../../utils/analytics.js";

/** The two words the public vocabulary uses. Never `anthropic`/`chatgpt`. */
export const READINESS_PUBLISHERS = ["claude", "openai"] as const;
export type ReadinessPublisher = (typeof READINESS_PUBLISHERS)[number];

/**
 * The submission shapes a HOSTED run may grade.
 *
 * The package shapes need an uploaded archive, and no hosted surface has a way
 * to receive one — the CLI reads it off the local disk. Listing them here and
 * refusing them at the edge means the refusal can name the CLI, rather than
 * surfacing later as a lane that mysteriously never evaluates.
 */
export const HOSTED_SUBMISSION_MODES = [
  "mcp-only",
  "mcp-imported-skills",
] as const;

export type HostedSubmissionMode = (typeof HOSTED_SUBMISSION_MODES)[number];

/** The shape `authorizeServer` hands back, narrowed to what a start needs. */
export interface AuthorizedReadinessServer {
  serverConfig: {
    transportType?: string;
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
  };
  // `null` as well as absent: the authorize response distinguishes "this
  // server does not use OAuth" from "it does and we hold no token", and both
  // arrive here as a falsy value that must not become the string "null" in an
  // Authorization header.
  oauthAccessToken?: string | null;
}

export interface StartHostedReadinessRunInput {
  convex: ConvexHttpClient;
  projectId: string;
  serverId: string;
  publisher: ReadinessPublisher;
  /** Required for OpenAI, absent for Claude. Never inferred from the inputs. */
  submissionMode?: OpenAISubmissionMode;
  idempotencyKey?: string;
  /** The one field that can SPEND. Defaults off at every call site. */
  includeLlmObservations: boolean;
  /** The output of the surface's own authorize exchange. */
  authorized: AuthorizedReadinessServer;
  /**
   * Who to attribute the run's TERMINAL event to.
   *
   * Resolved by the surface while its request still exists, because the run
   * outlives it. Optional: a surface with no resolvable actor passes nothing
   * and the terminal event is dropped rather than attributed to a stranger.
   */
  analyticsActor?: ServerAnalyticsActor;
  /** Maps a Convex error onto the surface's own error vocabulary. */
  translateError: (error: unknown) => Error;
}

export type HostedReadinessRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface HostedReadinessReceipt {
  runId: string;
  projectId: string;
  serverId: string;
  readinessKind: ReadinessPublisher;
  /**
   * The run's status at the moment this start returned.
   *
   * `pending` for a fresh start, and for a DEDUPED start whatever the existing
   * run is already at. An idempotency key replayed hours later names a run
   * that finished long ago; answering `pending` for it would send the caller
   * into a poll loop for a result it could already read.
   */
  status: HostedReadinessRunStatus;
  /** True when an idempotency key replayed an existing run. */
  deduped: boolean;
  includeLlmObservations: boolean;
}

/**
 * Create the leased row and detach the execution.
 *
 * The TARGET comes from the saved server the caller already authorized, never
 * from a request body. That is what makes "a caller cannot point this at an
 * arbitrary URL" true by construction rather than by validation — a body field
 * that could name a host would turn every one of these surfaces into an
 * authenticated fetch primitive.
 *
 * Execution runs in THIS process, detached, holding the lease the mutation
 * handed back. The backend's recovery cron is what makes that safe: a node
 * that dies stops heartbeating and the run is re-queued with a FRESH job id,
 * so a node returning from the dead cannot write into the attempt that
 * replaced it.
 */
export async function startHostedReadinessRun(
  input: StartHostedReadinessRunInput,
): Promise<HostedReadinessReceipt> {
  const config = input.authorized.serverConfig;
  if (config.transportType !== "http" || !config.url) {
    // Readiness grades what a HOST would see, and every host in question
    // reaches a server over HTTP. A stdio server is not a connector these
    // directories can list, so this is a wrong-shape refusal rather than a gap
    // in the run's coverage.
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Directory readiness grades HTTP connectors; this server uses a different transport.",
    );
  }
  const target = config.url;

  let created: { runId: string; jobId: string; reused: boolean };
  try {
    created = await input.convex.mutation(
      "claudeReadinessRuns:requestReadinessRun" as any,
      {
        projectId: input.projectId,
        serverId: input.serverId,
        serverUrl: target,
        readinessKind: input.publisher,
        ...(input.submissionMode
          ? { submissionMode: input.submissionMode }
          : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        includeLlmObservations: input.includeLlmObservations,
        authMode: config.useOAuth ? "provided-token" : "headless",
      },
    );
  } catch (error) {
    throw input.translateError(error);
  }

  // A REPLAY EXECUTES NOTHING. The run it names is already in flight or
  // already finished; starting a second execution against the same lease would
  // dial a third party's server twice for one logical request, which is the
  // exact thing the idempotency key was sent to prevent.
  //
  // It costs one extra read, though, because the caller needs the status the
  // run ACTUALLY has rather than the `pending` a fresh start would report. A
  // failure to read it is not a failure to start: fall back to `pending` and
  // let the caller poll, which is what it would have done anyway.
  let status: HostedReadinessRunStatus = "pending";
  if (created.reused) {
    try {
      const existing = (await input.convex.query(
        "claudeReadinessRuns:getReadinessRun" as any,
        { runId: created.runId },
      )) as { status?: HostedReadinessRunStatus } | null;
      if (existing?.status) status = existing.status;
    } catch {
      // Deliberately swallowed — see above.
    }
  } else {
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (input.authorized.oauthAccessToken) {
      headers.authorization = `Bearer ${input.authorized.oauthAccessToken}`;
    }

    void executeHostedReadinessRun({
      lease: { runId: created.runId, jobId: created.jobId },
      publisher: input.publisher,
      target,
      submissionMode: input.submissionMode,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      // The DNS-pinned transport: resolve once, refuse the disallowed answers,
      // pin the surviving addresses into the socket, re-run it on every hop.
      // A readiness run follows redirects by design, so a check performed only
      // on the first URL would be a check on the least interesting hop.
      fetchFn: createStreamingPinnedFetch({
        targetLabel: "MCP server",
        chainTimeoutMs: 30_000,
        bodyIdleTimeoutMs: 120_000,
        maxResponseBytes: 32 * 1024 * 1024,
      }),
      includeLlmObservations: input.includeLlmObservations,
      analyticsActor: input.analyticsActor,
    }).catch((error) => {
      // `executeHostedReadinessRun` never throws — every exit lands the run
      // somewhere terminal. This catch exists for the impossible case, so an
      // unhandled rejection cannot take the process with it.
      reportRouteFailure(
        "[readiness] detached hosted run escaped its own handler",
        error,
        {
          source: "readiness.hosted_run",
          // OUR bug, not the graded server's: the worker contracts never to
          // throw, so reaching this means the contract broke rather than that
          // somebody's MCP server misbehaved.
          hop: "mcpjam_internal",
          context: { runId: created.runId },
        },
      );
    });
  }

  return {
    runId: created.runId,
    projectId: input.projectId,
    serverId: input.serverId,
    readinessKind: input.publisher,
    status,
    deduped: created.reused,
    includeLlmObservations: input.includeLlmObservations,
  };
}

/**
 * The run row as every surface renders it.
 *
 * Shared for the same reason the start is: two renderers would eventually
 * disagree about whether a run whose observations were refused for credit is
 * `completed`. It is — the lanes graded fine — and `llmObservations.status`
 * carries the refusal on its own axis. A DTO that folded the two together
 * would make a billing outage look like a grading failure.
 */
export function toReadinessRunDto(
  run: Record<string, any>,
  options: { projectId: string; reportUrl?: (runId: string) => string },
) {
  const hasReport = run.hasReport === true;
  return {
    id: run.id,
    readinessKind: run.readinessKind ?? "claude",
    serverId: run.serverId ?? null,
    serverUrl: run.serverUrl,
    submissionMode: run.submissionMode ?? null,
    status: run.status,
    overallStatus: run.overallStatus ?? null,
    lanes: run.lanes ?? [],
    stages: run.stages ?? [],
    authMode: run.authMode ?? null,
    capabilities: run.capabilities ?? [],
    attemptCount: run.attemptCount,
    terminalReason: run.terminalReason ?? null,
    errorMessage: run.errorMessage ?? null,
    policySnapshotDate: run.policySnapshotDate ?? null,
    engineVersion: run.engineVersion ?? null,
    sdkVersion: run.sdkVersion ?? null,
    // The AI axis, ALWAYS present and independent of `status`. A run whose
    // lanes graded cleanly is `completed` even when the observation call was
    // refused for credit, and a reader has to be able to see both.
    includeLlmObservations: run.includeLlmObservations ?? false,
    llmObservations: run.llmObservations ?? {
      status: "not-requested",
      reason: "not_requested",
    },
    hasReport,
    reportUrl:
      hasReport && options.reportUrl ? options.reportUrl(run.id) : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
