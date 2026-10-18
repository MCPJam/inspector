/**
 * Durable hosted eval runs, Inspector side (backend: `convex/evalRunJobs.ts`).
 *
 * A durable run has a worker job the backend leases to ONE replica at a time.
 * The replica holding it heartbeats the lease, asks the backend to DISPATCH
 * each trial before its first model call, and completes the job at the end.
 * If it dies, another replica claims the job under a new generation and
 * resumes the run through `prepareEvalRun` with the run's idempotency key —
 * the same run, never a second one. Trials the lost replica dispatched are
 * recorded by the backend and never re-run.
 *
 * Only runs whose every input can be rebuilt are durable: hosted, launched
 * with an idempotency key, and with no request-only credentials (keys or
 * OAuth tokens sent with the request). Everything else stays process-owned.
 */
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger";
import { getServiceCredential } from "../service-credential.js";

const JOB_PATH = "/internal/v1/eval-run-jobs";
const GRANT_HEADER = "x-mcpjam-eval-run-grant";
const ROUTE_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

/** Durable runs need the backend routes and a worker to recover them. */
export function durableRunsEnabled(): boolean {
  return HOSTED_MODE && process.env.EVAL_RUN_JOBS_ENABLED === "1";
}

/**
 * The launch inputs a recovering replica needs, and nothing else. Never a
 * credential: the backend refuses inputs that look like one.
 */
export type DurableRunInputs = {
  suiteId: string;
  projectId: string;
  environmentId?: string;
  namedHostId?: string;
  caseIds?: string[];
  iterationOverride?: number;
  runGroupId?: string;
  serverIds: string[];
  serverNames?: string[];
  source: "ui" | "api";
};

export type DurableClaim = {
  jobId: string;
  runId: string;
  suiteId: string;
  gen: number;
  attempt: number;
  organizationId: string;
  externalId: string;
  idempotencyKey: string;
  inputs: string;
  heartbeatMs?: number;
};

export type DispatchOutcome =
  | "ok"
  | "lease_lost"
  | "run_ended"
  | "already_dispatched"
  | "account_suspended"
  | "not_a_member"
  | string;

async function postJobRoute(
  path: string,
  body: Record<string, unknown>,
  grant?: string,
): Promise<{ status: number; body: any }> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = getServiceCredential();
  if (!convexUrl || !serviceToken) {
    throw new Error(
      "Durable eval runs require CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  const response = await fetch(`${convexUrl}${JOB_PATH}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inspector-service-token": serviceToken,
      ...(grant ? { [GRANT_HEADER]: grant } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    // The status carries the signal.
  }
  return { status: response.status, body: parsed };
}

export function workerName(): string {
  return `inspector-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
}

/**
 * Claim one run's job (`runId`), or the next one that needs a worker.
 * `"no_job"`: that run has no job, so it is process-owned. `null`: nothing
 * claimable right now (another replica holds it, or the queue is empty).
 */
export async function claimDurableRun(
  runId?: string,
): Promise<DurableRunHandle | "no_job" | null> {
  const { status, body } = await postJobRoute("claim", {
    claimedBy: workerName(),
    ...(runId ? { runId } : {}),
  });
  if (status !== 200 || !body?.ok) {
    throw new Error(`eval run job claim failed (${status})`);
  }
  if (!body.claimed) return body.noJob ? "no_job" : null;
  return new DurableRunHandle(body.job as DurableClaim, body.grant as string);
}

export class DurableRunHandle {
  private grant: string;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** True once the backend said another replica owns the run now. */
  leaseLost = false;

  constructor(
    readonly claim: DurableClaim,
    grant: string,
  ) {
    this.grant = grant;
  }

  get runId(): string {
    return this.claim.runId;
  }

  /** A resumed run: some trials may already be recorded or lost. */
  get resumed(): boolean {
    return this.claim.attempt > 1;
  }

  /**
   * Keep the lease alive until `stop()`. `onLeaseLost` fires once when the
   * backend refuses the lease; the run must then stop WITHOUT finalizing,
   * because another replica owns it. A failed call only logs: the lease
   * outlives several missed beats.
   */
  startHeartbeat(onLeaseLost: () => void): void {
    const intervalMs = this.claim.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const beat = async () => {
      if (this.stopped) return;
      try {
        const { status, body } = await postJobRoute(
          "heartbeat",
          {},
          this.grant,
        );
        if (status === 409 || body?.leaseOk === false) {
          this.loseLease(onLeaseLost);
          return;
        }
        if (typeof body?.grant === "string") this.grant = body.grant;
      } catch (error) {
        logger.warn("[evals] durable run heartbeat failed", {
          runId: this.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.stopped) this.timer = setTimeout(beat, intervalMs);
    };
    this.timer = setTimeout(beat, intervalMs);
  }

  private loseLease(onLeaseLost: () => void) {
    if (this.leaseLost) return;
    this.leaseLost = true;
    this.stop();
    onLeaseLost();
  }

  /** Clear one trial to call the model. Anything but `ok` means do not run it. */
  async dispatch(iterationId: string): Promise<DispatchOutcome> {
    if (this.leaseLost) return "lease_lost";
    const { status, body } = await postJobRoute(
      "dispatch",
      { iterationId },
      this.grant,
    );
    if (status === 409) {
      this.leaseLost = true;
      return "lease_lost";
    }
    if (status !== 200) throw new Error(`eval run dispatch failed (${status})`);
    return body?.ok ? "ok" : String(body?.reason ?? "refused");
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Release the job once this replica finished (and finalized) the run. */
  async complete(): Promise<void> {
    this.stop();
    if (this.leaseLost) return;
    try {
      await postJobRoute("complete", {}, this.grant);
    } catch (error) {
      // The sweep closes a job whose run has ended.
      logger.warn("[evals] durable run complete failed", {
        runId: this.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
