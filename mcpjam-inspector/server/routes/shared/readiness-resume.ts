/**
 * Resuming a hosted readiness run that recovery re-queued.
 *
 * A run grades a saved server with its requester's credentials, which the
 * start route gets from their bearer and hands the worker in memory. When the
 * node running it stops, recovery re-queues the run, and no other node can run
 * it: the credentials stopped with that node. So the requester runs it again,
 * through a request that carries their bearer. The backend checks that they
 * started it and hands this node a new lease, the run already `running`; the
 * saved server is authorized as a start authorizes it; and the worker executes
 * detached on that lease without claiming it again.
 *
 * As for the start, AUTHORIZATION IS THE CALLER'S JOB: the surface passes its
 * own authorize exchange, called once the backend has said which server the
 * run grades.
 */

import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type {
  DirectoryFeatureClaim,
  DirectoryLazyAuthProbeConfig,
  OpenAISubmissionMode,
} from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { logger } from "../../utils/logger.js";
import type { ServerAnalyticsActor } from "../../utils/analytics.js";
import {
  failReadinessRun,
  heartbeatReadinessRun,
  type ReadinessLease,
} from "../../services/readiness/backend-client.js";
import {
  executeHostedReadinessRunDetached,
  type AuthorizedReadinessServer,
  type HostedReadinessReceipt,
  type ReadinessPublisher,
} from "./readiness-runs.js";

/** The run's own start inputs, as the backend's resume hands them back. */
interface ResumedRun {
  runId: string;
  /** New: the lease that was re-queued belongs to no node any more. */
  jobId: string;
  readinessKind: ReadinessPublisher;
  submissionMode?: OpenAISubmissionMode;
  projectId: string;
  serverId?: string;
  serverUrl: string;
  options: {
    includeLlmObservations: boolean;
    lazyAuthProbe?: DirectoryLazyAuthProbeConfig;
    claimedFeatures?: DirectoryFeatureClaim[];
  };
}

const resumeMutation = makeFunctionReference<
  "mutation",
  { runId: string },
  ResumedRun
>("readinessRunClaims:resumeReadinessRun");

const NO_SERVER =
  "This run has no saved server to grade, so it was not resumed. Start a new run from a saved server.";
const NOT_AUTHORIZED =
  "Access to this run's server could not be confirmed, so it was not resumed. Check that you can still open the server, then start a new run.";
const SERVER_CHANGED =
  "The server's saved address changed after this run started, so it was not resumed. Start a new run to grade the server as it is saved now.";
const LEASE_MOVED =
  "This run was cancelled or picked up elsewhere while its server was being checked, so it was not resumed here. Check the run's status.";
const AUTHORIZE_TIMED_OUT =
  "Checking access to this run's server took too long, so it was not resumed. It can be resumed again in about 10 minutes.";

/**
 * How long authorize may take. Far inside the backend's ten-minute lease, so
 * the lease this node holds is still its own when the answer arrives.
 */
const AUTHORIZE_TIMEOUT_MS = 30_000;

/**
 * Only these answers from authorize say the caller may not grade the server:
 * signed out, refused, or the server is gone. Anything else (an outage, a
 * timeout) says nothing about access.
 */
function isAccessRefusal(error: unknown): boolean {
  return (
    error instanceof WebRouteError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function authorizeWithin<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new WebRouteError(504, ErrorCode.TIMEOUT, AUTHORIZE_TIMED_OUT)),
      ms,
    );
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

export interface ResumeHostedReadinessRunInput {
  convex: ConvexHttpClient;
  runId: string;
  /** The submission the run grades, read off the run: its answers are frozen. */
  submissionId?: string;
  /** The surface's authorize exchange, with the caller's bearer. */
  authorize: (
    projectId: string,
    serverId: string,
  ) => Promise<AuthorizedReadinessServer>;
  analyticsActor?: ServerAnalyticsActor;
  /** Maps a Convex refusal onto the surface's own error vocabulary. */
  translateError: (error: unknown) => Error;
}

/**
 * Fail the run this node holds. A write that does not land leaves the run to
 * recovery when its lease lapses, which is where it was before the resume.
 */
async function failResumedRun(
  lease: ReadinessLease,
  terminalReason: string,
  message: string,
): Promise<void> {
  try {
    await failReadinessRun(lease, terminalReason, message);
  } catch (error) {
    logger.warn("[readiness] a resumed run could not be failed", {
      runId: lease.runId,
      terminalReason,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Authorize the server the run grades. Past the resume this node holds the
 * run `running`, so a definite refusal fails the run with its reason. A
 * failure that says nothing about access leaves the run alone: recovery
 * re-queues it when the lease lapses, and it can be resumed again.
 */
async function authorizeResumedServer(
  input: ResumeHostedReadinessRunInput,
  resumed: ResumedRun,
  lease: ReadinessLease,
): Promise<{ serverId: string; authorized: AuthorizedReadinessServer }> {
  const serverId = resumed.serverId;
  if (!serverId) {
    await failResumedRun(lease, "server_missing", NO_SERVER);
    throw new WebRouteError(409, ErrorCode.CONFLICT, NO_SERVER);
  }
  let authorized: AuthorizedReadinessServer;
  try {
    authorized = await authorizeWithin(
      input.authorize(resumed.projectId, serverId),
      AUTHORIZE_TIMEOUT_MS,
    );
  } catch (error) {
    if (isAccessRefusal(error)) {
      await failResumedRun(lease, "server_unauthorized", NOT_AUTHORIZED);
    } else {
      logger.warn("[readiness] authorize failed; the run waits for recovery", {
        runId: lease.runId,
        status: error instanceof WebRouteError ? error.status : undefined,
      });
    }
    throw error;
  }
  // Whoever moved the lease while authorize ran (a cancel, recovery) owns
  // the run now. The heartbeat both checks and renews the lease.
  if (!(await heartbeatReadinessRun(lease)).alive) {
    throw new WebRouteError(409, ErrorCode.CONFLICT, LEASE_MOVED);
  }
  // The credential belongs to the server as saved now, so it must not go to
  // the address the run recorded if the two differ; grading the new address
  // would answer a question the run was not started with.
  const config = authorized.serverConfig;
  if (config.transportType !== "http" || config.url !== resumed.serverUrl) {
    await failResumedRun(lease, "server_changed", SERVER_CHANGED);
    throw new WebRouteError(409, ErrorCode.CONFLICT, SERVER_CHANGED);
  }
  return { serverId, authorized };
}

/**
 * Take back a re-queued run and execute it again, detached, with the
 * caller's credentials. Only the run's requester gets past the backend.
 */
export async function resumeHostedReadinessRun(
  input: ResumeHostedReadinessRunInput,
): Promise<HostedReadinessReceipt> {
  let resumed: ResumedRun;
  try {
    resumed = await input.convex.mutation(resumeMutation, {
      runId: input.runId,
    });
  } catch (error) {
    throw input.translateError(error);
  }
  const lease = { runId: resumed.runId, jobId: resumed.jobId };
  const { serverId, authorized } = await authorizeResumedServer(
    input,
    resumed,
    lease,
  );

  const { includeLlmObservations, lazyAuthProbe, claimedFeatures } =
    resumed.options;
  executeHostedReadinessRunDetached(
    {
      lease,
      leaseClaimed: true,
      publisher: resumed.readinessKind,
      target: resumed.serverUrl,
      submissionMode: resumed.submissionMode,
      includeLlmObservations,
      // As the start forwards them: only what the requester asked for.
      ...(lazyAuthProbe?.enabled === true ? { lazyAuthProbe } : {}),
      ...(claimedFeatures?.length ? { claimedFeatures } : {}),
      ...(input.submissionId ? { submissionId: input.submissionId } : {}),
      analyticsActor: input.analyticsActor,
    },
    authorized,
  );
  logger.info("[readiness] resumed a re-queued run", { runId: lease.runId });

  return {
    runId: resumed.runId,
    projectId: resumed.projectId,
    serverId,
    readinessKind: resumed.readinessKind,
    status: "running",
    deduped: false,
    includeLlmObservations,
  };
}
