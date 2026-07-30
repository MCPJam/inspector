/**
 * github-checks-worker.ts — polling executor for GitHub PR check runs.
 *
 * Same pull/claim architecture as `scheduled-evals-worker.ts`: the backend
 * never calls the Inspector. A PR webhook lands a trigger row in Convex; this
 * loop claims one at a time over the service-token-gated
 * `/internal/v1/github-checks/*` routes, builds the PR's MCP server in a
 * disposable sandbox, and drives the EXISTING `prepareEvalRun()` → `execute()`
 * pipeline against it.
 *
 * The worker never talks to GitHub, and it holds no GitHub credential. It
 * reports an OUTCOME; the control plane turns that into a check conclusion.
 * That split is why a compromised worker cannot write to anyone's repo.
 *
 * Two invariants this file is responsible for, and they are the reason every
 * exit path goes through `report()`:
 *
 *   1. A claimed trigger ALWAYS gets a verdict. An unreported claim sits until
 *      the backend's heartbeat sweep fails it ~5 minutes later, which shows up
 *      on someone's PR as a check that hung then went neutral.
 *   2. The verdict distinguishes the PR's fault from ours. `build_failed` and
 *      `server_unhealthy` are the PR's (→ check failure); `infra_error` is ours
 *      (→ neutral). Getting that backwards puts a red X on a good PR, or hides
 *      a real breakage.
 *
 * Gated by `GITHUB_CHECKS_WORKER_ENABLED === '1'`; the backend has its own
 * `GITHUB_CHECKS_ENABLED` gate and 404s this whole surface when it is off.
 */

import { WEB_CALL_TIMEOUT_MS } from "../config.js";
import { logger } from "../utils/logger";
import { getConvexBearerForDelegation } from "../utils/v1-convex-token.js";
import { createAuthorizedManager } from "../routes/web/auth.js";
import { prepareEvalRun } from "../routes/shared/evals.js";
import { createConvexClient } from "./evals/route-helpers.js";
import { resolveCheckRecipe } from "./github-checks/recipes.js";
import {
  buildAndStart,
  CheckStepError,
  clampOutput,
  cloneAndCheckout,
  killCheckSandbox,
  provisionCheckSandbox,
  type CheckSandbox,
} from "./github-checks/sandbox.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_JITTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/** Per-request cap on service-route calls so a stalled Convex can't wedge the loop. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;
/**
 * Heartbeat cadence. The backend fails a claim whose heartbeat is >5 minutes
 * stale, so 60s leaves room for ~5 consecutive misses before a healthy worker
 * gets its check taken away mid-build.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

const SERVICE_BASE = "/internal/v1/github-checks";

/**
 * The claim payload, HAND-MIRRORED from the backend's `ClaimedGithubCheck`
 * (`convex/github/checkTriggers.ts`). The two repos share no types, so this
 * shape IS the contract: adding a field is a two-repo change, and unknown
 * fields on the wire are ignored rather than rejected.
 */
export type ClaimedGithubCheck = {
  triggerId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  organizationId: string;
  projectId: string;
  createdByExternalId: string;
  suiteId: string;
};

/**
 * The verdict vocabulary, also hand-mirrored. The backend maps these to check
 * conclusions (`convex/github/checkRuns.ts`); an unknown value is rejected by
 * the complete route rather than defaulted, so a typo here fails loudly instead
 * of mislabeling a PR.
 */
export type GithubCheckOutcome =
  | "passed"
  | "evals_failed"
  | "build_failed"
  | "server_unhealthy"
  | "recipe_unresolvable"
  | "unsupported_fork"
  | "infra_error";

export type CheckSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
};

export type CheckReport = {
  triggerId: string;
  outcome: GithubCheckOutcome;
  runId?: string;
  summary?: CheckSummary;
  detailsMarkdown?: string;
  failureReason?: string;
};

export function isGithubChecksWorkerEnabled(): boolean {
  return process.env.GITHUB_CHECKS_WORKER_ENABLED === "1";
}

function requiredEnv(): { convexUrl: string; serviceToken: string } | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) return null;
  return { convexUrl, serviceToken };
}

async function postServiceRoute(
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  const env = requiredEnv();
  if (!env) {
    throw new Error(
      "github-checks worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN"
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVICE_ROUTE_TIMEOUT_MS
  );
  let response: Response;
  try {
    response = await fetch(`${env.convexUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    // Tolerated; status carries the signal.
  }
  return { status: response.status, body: parsed };
}

async function claimNext(
  claimedBy: string
): Promise<ClaimedGithubCheck | null | "disabled"> {
  const { status, body } = await postServiceRoute(`${SERVICE_BASE}/claim`, {
    claimedBy,
  });
  // 404 = GITHUB_CHECKS_ENABLED is off backend-side. Treat as "nothing to do"
  // with a long backoff so flipping the flag needs no Inspector restart.
  if (status === 404) return "disabled";
  if (status !== 200 || !body?.ok) {
    throw new Error(`claim failed (${status}): ${JSON.stringify(body)}`);
  }
  return (body.claimed as ClaimedGithubCheck | null) ?? null;
}

async function reportOutcome(report: CheckReport): Promise<void> {
  try {
    const { status, body } = await postServiceRoute(
      `${SERVICE_BASE}/complete`,
      report as unknown as Record<string, unknown>
    );
    if (status !== 200 || !body?.ok) {
      logger.warn("[github-checks] completion rejected", {
        triggerId: report.triggerId,
        status,
      });
    }
  } catch (error) {
    // Best effort: an unreported claim is failed by the backend's heartbeat
    // sweep, which concludes the check `infra_error` rather than leaving it
    // running forever.
    logger.warn("[github-checks] failed to report outcome", {
      triggerId: report.triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sendHeartbeat(
  triggerId: string,
  claimedBy: string
): Promise<void> {
  await postServiceRoute(`${SERVICE_BASE}/heartbeat`, { triggerId, claimedBy });
}

async function recordEphemeralServer(
  triggerId: string,
  serverId: string
): Promise<void> {
  await postServiceRoute(`${SERVICE_BASE}/ephemeral-server`, {
    triggerId,
    serverId,
  });
}

/**
 * Map a thrown error to an outcome.
 *
 * `CheckStepError` already carries its verdict (the sandbox module decided
 * whether a failure was the PR's or ours), so it wins outright. Beyond that,
 * only ONE marker is matched: the backend's canonical `billing_limit_reached`
 * code, which is an MCPJam-side limit and must never show as the PR's failure.
 * Everything else is `infra_error` — deliberately, because the alternative is
 * guessing from a message, and a wrong guess means a red X on a good PR.
 */
export function classifyCheckFailure(error: unknown): {
  outcome: GithubCheckOutcome;
  failureReason: string;
  detailsMarkdown?: string;
} {
  if (error instanceof CheckStepError) {
    return {
      outcome: error.outcome,
      failureReason: error.message.slice(0, 200),
      ...(error.detailsMarkdown
        ? { detailsMarkdown: error.detailsMarkdown }
        : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/billing_limit_reached/i.test(message)) {
    return {
      outcome: "infra_error",
      failureReason: "billing_limit_reached",
    };
  }
  return { outcome: "infra_error", failureReason: message.slice(0, 200) };
}

/** Terminal run result → outcome. Only `passed` is a pass. */
export function outcomeForRunResult(
  result: string | null | undefined
): GithubCheckOutcome {
  return result === "passed" ? "passed" : "evals_failed";
}

/**
 * Injectable collaborators. Every external effect the executor performs is one
 * of these, so the failure-path tests drive real control flow (including the
 * `finally` cleanup and the heartbeat lifecycle) without an E2B box, a Convex
 * deployment, or an MCP server.
 */
export type CheckExecutionDeps = {
  resolveRecipe: typeof resolveCheckRecipe;
  provisionSandbox: typeof provisionCheckSandbox;
  cloneAndCheckout: typeof cloneAndCheckout;
  buildAndStart: typeof buildAndStart;
  killSandbox: typeof killCheckSandbox;
  getBearer: (externalId: string, organizationId: string) => Promise<string>;
  createEphemeralServer: (args: {
    bearer: string;
    projectId: string;
    name: string;
    url: string;
  }) => Promise<string>;
  deleteEphemeralServer: (args: {
    bearer: string;
    serverId: string;
  }) => Promise<void>;
  recordServer: (triggerId: string, serverId: string) => Promise<void>;
  runEvalSuite: (args: {
    claimed: ClaimedGithubCheck;
    bearer: string;
    serverId: string;
    serverName: string;
  }) => Promise<{ runId: string; result?: string; summary?: CheckSummary }>;
  report: (report: CheckReport) => Promise<void>;
  heartbeat: (triggerId: string, claimedBy: string) => Promise<void>;
  heartbeatIntervalMs: number;
};

async function defaultCreateEphemeralServer(args: {
  bearer: string;
  projectId: string;
  name: string;
  url: string;
}): Promise<string> {
  const client = createConvexClient(args.bearer);
  const serverId = await client.mutation("servers:createServer" as any, {
    projectId: args.projectId,
    name: args.name,
    enabled: true,
    transportType: "http",
    url: args.url,
  });
  return String(serverId);
}

async function defaultDeleteEphemeralServer(args: {
  bearer: string;
  serverId: string;
}): Promise<void> {
  const client = createConvexClient(args.bearer);
  await client.mutation("servers:deleteServer" as any, {
    serverId: args.serverId,
  });
}

/**
 * Run the dedicated suite against the just-built server.
 *
 * The `serverIds` override is what makes this work at all: the suite is a
 * persisted `[github-checks] …` suite whose own saved server refs point at some
 * previous check's (now deleted) ephemeral row. Overriding on every run means
 * the suite's stored binding is never consulted — which is also why this suite
 * must never be launched from the UI.
 */
async function defaultRunEvalSuite(args: {
  claimed: ClaimedGithubCheck;
  bearer: string;
  serverId: string;
  serverName: string;
}): Promise<{ runId: string; result?: string; summary?: CheckSummary }> {
  // Empty caller context = plain-JWT caller; the delegated JWT is the principal
  // (same contract as the scheduled worker).
  const authorized = await createAuthorizedManager(
    {},
    args.bearer,
    args.claimed.projectId,
    [args.serverId],
    WEB_CALL_TIMEOUT_MS,
    undefined,
    undefined,
    { serverNames: [args.serverName] }
  );

  try {
    const prepared = await prepareEvalRun(authorized.manager, {
      suiteId: args.claimed.suiteId,
      projectId: args.claimed.projectId,
      tests: [],
      serverIds: [args.serverId],
      serverNames: [args.serverName],
      suiteRerun: true,
      // `source: 'github_check'` would be a two-repo union change; 'api' is the
      // closest existing value and keeps this to one repo (see plan follow-up).
      source: "api",
      convexAuthToken: args.bearer,
      // A claim retry can never double-create a run.
      idempotencyKey: args.claimed.triggerId,
    });

    try {
      await prepared.execute();
    } catch (error) {
      // The runner owns terminal run status (it finalizes failed runs before
      // rethrowing). The run exists, so read its verdict below rather than
      // treating this as an infrastructure failure.
      logger.warn(
        "[github-checks] eval run threw; reading its terminal state",
        {
          triggerId: args.claimed.triggerId,
          runId: prepared.runId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }

    const client = createConvexClient(args.bearer);
    const run = (await client.query("testSuites:getTestSuiteRun" as any, {
      runId: prepared.runId,
    })) as { result?: string; summary?: CheckSummary } | null;

    return {
      runId: prepared.runId,
      ...(run?.result ? { result: run.result } : {}),
      ...(run?.summary ? { summary: run.summary } : {}),
    };
  } finally {
    await authorized.manager.disconnectAllServers().catch(() => {});
  }
}

function defaultDeps(): CheckExecutionDeps {
  return {
    resolveRecipe: resolveCheckRecipe,
    provisionSandbox: provisionCheckSandbox,
    cloneAndCheckout,
    buildAndStart,
    killSandbox: killCheckSandbox,
    getBearer: getConvexBearerForDelegation,
    createEphemeralServer: defaultCreateEphemeralServer,
    deleteEphemeralServer: defaultDeleteEphemeralServer,
    recordServer: recordEphemeralServer,
    runEvalSuite: defaultRunEvalSuite,
    report: reportOutcome,
    heartbeat: sendHeartbeat,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

/**
 * Execute one claimed check end to end. NEVER throws, and every exit path
 * reports an outcome — see the invariants at the top of the file.
 */
export async function executeClaimedCheck(
  claimed: ClaimedGithubCheck,
  claimedBy: string,
  overrides?: Partial<CheckExecutionDeps>
): Promise<void> {
  const deps: CheckExecutionDeps = { ...defaultDeps(), ...overrides };
  const logContext = {
    triggerId: claimed.triggerId,
    repo: claimed.repoFullName,
    pr: claimed.prNumber,
    sha: claimed.headSha.slice(0, 8),
  };

  // The lease is refreshed for the WHOLE duration, including the eval run — a
  // suite legitimately takes many minutes and must not look like a dead worker.
  const heartbeat = setInterval(() => {
    void deps.heartbeat(claimed.triggerId, claimedBy).catch((error) =>
      logger.warn("[github-checks] heartbeat failed", {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }, deps.heartbeatIntervalMs);
  // Don't hold the event loop open on shutdown.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  let sandbox: CheckSandbox | null = null;
  let serverId: string | null = null;
  let bearer: string | null = null;

  // Reporting is the last thing that can fail, and it must not turn a delivered
  // verdict into a thrown error — the poll loop would read that as a transport
  // failure and back off, while the backend's heartbeat sweep would eventually
  // conclude the check `infra_error` anyway.
  const safeReport = async (report: CheckReport): Promise<void> => {
    try {
      await deps.report(report);
    } catch (error) {
      logger.warn("[github-checks] reporting the outcome failed", {
        ...logContext,
        outcome: report.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    const recipe = deps.resolveRecipe(claimed.repoFullName);
    if (!recipe) {
      // Defensive: the backend allowlist and the recipe table are configured
      // together today. Routine once the resolver ladder exists.
      await safeReport({
        triggerId: claimed.triggerId,
        outcome: "recipe_unresolvable",
        failureReason: `no run recipe for ${claimed.repoFullName}`,
      });
      return;
    }

    sandbox = await deps.provisionSandbox({
      triggerId: claimed.triggerId,
      repoFullName: claimed.repoFullName,
      prNumber: claimed.prNumber,
    });
    await deps.cloneAndCheckout(sandbox, {
      repoFullName: claimed.repoFullName,
      prNumber: claimed.prNumber,
      headSha: claimed.headSha,
    });
    // Builds, revokes egress, starts, and waits for `initialize` — in that
    // order, which `buildAndStart` owns precisely so it can't be reordered here.
    const started = await deps.buildAndStart(sandbox, recipe);

    logger.info("[github-checks] PR server is reachable", {
      ...logContext,
      url: started.url,
    });

    bearer = await deps.getBearer(
      claimed.createdByExternalId,
      claimed.organizationId
    );

    const serverName = `gh-check-${claimed.triggerId}`;
    serverId = await deps.createEphemeralServer({
      bearer,
      projectId: claimed.projectId,
      name: serverName,
      url: started.url,
    });
    // Tell the backend before running anything: if this worker dies mid-eval,
    // recovery needs the pointer to soft-delete the row.
    await deps.recordServer(claimed.triggerId, serverId).catch((error) =>
      logger.warn("[github-checks] failed to record ephemeral server", {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      })
    );

    const run = await deps.runEvalSuite({
      claimed,
      bearer,
      serverId,
      serverName,
    });

    const outcome = outcomeForRunResult(run.result);
    await safeReport({
      triggerId: claimed.triggerId,
      outcome,
      runId: run.runId,
      ...(run.summary ? { summary: run.summary } : {}),
      ...(outcome === "evals_failed"
        ? { failureReason: `run result: ${run.result ?? "unknown"}` }
        : {}),
    });
  } catch (error) {
    const classified = classifyCheckFailure(error);
    logger.error("[github-checks] check failed", error, {
      ...logContext,
      outcome: classified.outcome,
    });
    await safeReport({
      triggerId: claimed.triggerId,
      outcome: classified.outcome,
      failureReason: classified.failureReason,
      ...(classified.detailsMarkdown
        ? { detailsMarkdown: clampOutput(rawOf(classified.detailsMarkdown)) }
        : {}),
    });
  } finally {
    clearInterval(heartbeat);
    // Each step best-effort and independent: a failure to delete the server row
    // must not skip killing the box (which costs money), and vice versa. The
    // backend's recovery sweep and E2B's TTL are the backstops for both.
    if (serverId && bearer) {
      await deps.deleteEphemeralServer({ bearer, serverId }).catch((error) =>
        logger.warn("[github-checks] ephemeral server cleanup failed", {
          ...logContext,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
    await deps.killSandbox(sandbox);
  }
}

/**
 * `CheckStepError.detailsMarkdown` is already clamped and fenced. Re-clamping a
 * fenced block would double-fence it, so hand back the fence-free inner text
 * when we recognize our own formatting and let `clampOutput` be idempotent.
 */
function rawOf(detailsMarkdown: string): string {
  const fenced = /^(?:_[^\n]*_\n)?(`{3,})text\n([\s\S]*)\n\1$/.exec(
    detailsMarkdown
  );
  return fenced ? fenced[2] : detailsMarkdown;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      done();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface GithubChecksWorkerHandle {
  /** Aborts polling and resolves once the loop (incl. an in-flight check) settles. */
  stop: () => Promise<void>;
}

/**
 * Start the polling loop. One check in flight per replica; the FLEET-wide cap is
 * enforced backend-side in the claim mutation, because Railway may run several
 * replicas and this loop knows nothing about its siblings.
 */
export function startGithubChecksWorker(options?: {
  claimedBy?: string;
  /** Test seams: override the claim/execute pair. */
  claim?: typeof claimNext;
  execute?: (claimed: ClaimedGithubCheck, claimedBy: string) => Promise<void>;
}): GithubChecksWorkerHandle {
  const abort = new AbortController();
  const claimedBy =
    options?.claimedBy ??
    `inspector-gh-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
  const claim = options?.claim ?? claimNext;
  const execute =
    options?.execute ??
    ((claimed: ClaimedGithubCheck, by: string) =>
      executeClaimedCheck(claimed, by));

  if (!requiredEnv()) {
    logger.warn(
      "[github-checks] worker enabled but CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; not starting"
    );
    return { stop: async () => {} };
  }

  logger.info("[github-checks] worker started", { claimedBy });

  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs =
        POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const claimed = await claim(claimedBy);
        if (claimed === "disabled") {
          waitMs = ERROR_BACKOFF_MS;
        } else if (claimed) {
          await execute(claimed, claimedBy);
          // Drain mode: another PR's check may be queued behind this one.
          waitMs = 1_000;
        }
      } catch (error) {
        logger.warn("[github-checks] poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs, abort.signal);
    }
    logger.info("[github-checks] worker stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      // Bounded by the caller's shutdown force-exit timer; a check that outlasts
      // it is recovered by the backend's heartbeat sweep.
      await loop;
    },
  };
}
