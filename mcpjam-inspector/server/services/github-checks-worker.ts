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
import {
  resolveCheckRecipe,
  type CheckRecipe,
} from "./github-checks/recipes.js";
import {
  buildAndStart,
  CheckStepError,
  clampOutput,
  cloneAndCheckout,
  isGithubChecksSandboxConfigured,
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
  // The timer stays armed through the BODY read, not just the headers: a
  // response that stalls mid-body would otherwise hang the poll loop for as long
  // as the socket stays open, and the loop is what recovers from a sick backend.
  try {
    const response = await fetch(`${env.convexUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch (error) {
      // A malformed body is tolerated — the status carries the signal. A body
      // read that hit the abort deadline is NOT: silently returning
      // `body: null` would make a timed-out call look like a successful one
      // whose response merely lacked a body. Rethrown as a TIMEOUT, since the
      // underlying error is a parse failure and would otherwise read in the
      // logs (and in an `infra_error` detail) as a malformed-response bug.
      if (controller.signal.aborted) {
        throw new Error(
          `service route ${path} timed out after ${SERVICE_ROUTE_TIMEOUT_MS}ms while reading the response body`,
          { cause: error }
        );
      }
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
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

/**
 * Refresh the lease, and THROW if the backend refused.
 *
 * A silently-discarded status is the dangerous version of this call: the
 * interval would treat every rejected heartbeat as a success, and after five
 * minutes of that the backend's sweep concludes the check `infra_error` while
 * this worker is still happily running it. Failing loudly at least puts the
 * reason in the logs next to the check that got taken away.
 */
async function sendHeartbeat(
  triggerId: string,
  claimedBy: string
): Promise<void> {
  const { status, body } = await postServiceRoute(`${SERVICE_BASE}/heartbeat`, {
    triggerId,
    claimedBy,
  });
  if (status !== 200 || !body?.ok) {
    throw new Error(`heartbeat rejected (${status}): ${JSON.stringify(body)}`);
  }
  // The route answers 200 with `result.ok: false` when this worker no longer
  // holds the claim (lease recovered, row superseded). That is DEFINITIVE, not a
  // transient failure: the backend has already concluded this check and will
  // reject the completion, so the work in flight is worthless.
  if (body.result && body.result.ok === false) {
    throw new LeaseLostError(String(body.result.error ?? "unknown"));
  }
}

/**
 * The backend no longer considers this worker the holder of the claim.
 *
 * Distinct from a transport failure on purpose: a failed REQUEST is worth
 * retrying on the next beat, whereas a lost LEASE means the check has already
 * been concluded by someone else and every further minute of building or
 * evaluating is wasted — up to the sandbox's full lifetime.
 */
export class LeaseLostError extends Error {
  constructor(readonly reason: string) {
    super(`lease lost: ${reason}`);
    this.name = "LeaseLostError";
  }
}

/** Test seam: the heartbeat's response validation is the whole point of it. */
export const sendHeartbeatForTests = sendHeartbeat;

/**
 * Register the ephemeral `servers` row, and THROW if the backend refused.
 *
 * Same reasoning as the heartbeat: a discarded status makes a rejected
 * registration look successful, and the consequence is specific — recovery loses
 * the pointer it needs to soft-delete the row, so a worker that dies mid-check
 * leaks a live server row that nothing reaps. The caller keeps going (the PR
 * still deserves its verdict) but the failure lands in the logs.
 */
async function recordEphemeralServer(
  triggerId: string,
  serverId: string
): Promise<void> {
  const { status, body } = await postServiceRoute(
    `${SERVICE_BASE}/ephemeral-server`,
    { triggerId, serverId }
  );
  if (status !== 200 || !body?.ok) {
    throw new Error(
      `ephemeral-server registration rejected (${status}): ${JSON.stringify(
        body
      )}`
    );
  }
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
 * The run's verdict, derived when the record does not carry one.
 *
 * The recorder finalizes a run with `status: "completed"` and a `summary` but
 * does NOT always populate `result`. Reading `result` alone therefore turns a
 * run that passed every test into `evals_failed` — a red X on a good PR, which
 * is the exact failure mode the outcome taxonomy exists to prevent. The client
 * has the same derivation (`computeEffectiveRunResult` in
 * `client/src/components/evals/suite-runs-list.tsx`); this is the server-side
 * mirror, kept here because the worker must not import client code.
 *
 * The percentage is computed from `passed`/`total` and NOT read from
 * `summary.passRate`. The stored field is a 0-1 FRACTION (`evals-runner.ts`
 * writes `passed / total`) while `minimumPassRate` is a 0-100 PERCENTAGE, so
 * comparing them directly fails every run: a perfect run stores `1`, which is
 * below any threshold. The client recomputes from the counts for the same
 * reason — it never reads the stored rate either.
 */
export function effectiveRunResult(
  run: {
    status?: string;
    result?: string;
    summary?: CheckSummary | null;
    passCriteria?: { minimumPassRate?: number } | null;
  } | null
): string | undefined {
  if (!run) return undefined;
  if (run.result) return run.result;
  if (run.status === "completed") {
    const total = run.summary?.total ?? 0;
    if (total > 0) {
      // ROUNDED, like the client's `computeRunEffectiveStats`. Rounding the same
      // way is what keeps the check's verdict and the eval UI's badge from
      // disagreeing on a fractional rate (2/3 is 67% to both, not 66.67% to one).
      const passRatePercent = Math.round(
        ((run.summary?.passed ?? 0) / total) * 100
      );
      return passRatePercent >= (run.passCriteria?.minimumPassRate ?? 100)
        ? "passed"
        : "failed";
    }
    // Completed with no counts at all — nothing to derive from. Left undefined
    // so the caller reports `evals_failed` rather than inventing a pass.
    return undefined;
  }
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "timed_out") return "timed_out";
  if (run.status === "failed") return "failed";
  return undefined;
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

/**
 * How long the post-failure liveness check gets. Short on purpose: it runs only
 * after the eval already failed, and it is a diagnostic, not a retry.
 */
const EVAL_FAILURE_PROBE_TIMEOUT_MS = 15_000;

/** Sentinels the in-box liveness check prints. Matched exactly, never parsed. */
const HTTP_ANSWERED_MARKER = "MCPJAM_CHECK_HTTP_ANSWERED";
const HTTP_SILENT_MARKER = "MCPJAM_CHECK_HTTP_SILENT";
const PORT_CLOSED_MARKER = "MCPJAM_CHECK_PORT_CLOSED";
/**
 * How long the in-box request waits for response headers. Generous next to the
 * milliseconds a healthy server took at startup, because the only thing a short
 * budget buys here is a chance of blaming a merely slow server.
 */
const IN_BOX_RESPONSE_TIMEOUT_MS = 10_000;
/**
 * The version the liveness request names. Which revision it is does not matter —
 * only whether response headers come back at all — so this is deliberately a local
 * literal rather than a coupling to the health probe's negotiation constants.
 */
const LIVENESS_PROBE_PROTOCOL_VERSION = "2025-11-25";

/**
 * Whether the PR's server is still ANSWERING — asked from INSIDE the sandbox.
 *
 * Deliberately not a fetch to the public URL. That path traverses E2B's ingress,
 * DNS and TLS, and the health probe reports every one of those failures exactly the
 * way it reports a dead server: `false`. Blaming the PR for an ingress outage of
 * OURS would be a red X on an innocent PR, so the question goes over the command
 * RPC, where a loopback request can only be answered by the server process itself.
 *
 * It sends a real HTTP request rather than merely opening a socket, because a bound
 * listener proves very little: a server whose event loop is wedged, deadlocked or
 * thrashing still accepts connections while answering nothing, and that is the PR's
 * bug to own. What it does NOT do is validate the MCP answer. That would mean
 * reimplementing media-type selection, SSE framing and JSON-RPC validation inside a
 * shell one-liner — the semantics this module gets right in typed, tested code — and
 * a simplified copy would drift from the client and reintroduce the very mismatch
 * class it was meant to catch. So the question asked is "does it still answer HTTP
 * at all", and a server that answers WRONGLY stays neutral.
 *
 * Three-valued on purpose: `null` is "could not tell", which the caller must treat
 * as neutral, because the command channel failing is itself our symptom. Node is
 * the one interpreter the dedicated template is guaranteed to carry (node + git),
 * so this is a node one-liner rather than `curl`, and it always exits 0 and answers
 * through stdout — an exit code cannot distinguish "connection refused" from "the
 * command never ran".
 */
async function serverStillResponding(
  sandbox: CheckSandbox,
  recipe: CheckRecipe
): Promise<boolean | null> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LIVENESS_PROBE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcpjam-github-checks-liveness", version: "1.0.0" },
    },
  });
  const script =
    `const http=require('http');let said=false;` +
    `const say=(m)=>{if(!said){said=true;console.log(m);}};` +
    `const body=${JSON.stringify(body)};` +
    `const req=http.request({host:'127.0.0.1',port:${recipe.port},` +
    `path:${JSON.stringify(recipe.mcpPath)},method:'POST',headers:{` +
    `'content-type':'application/json',` +
    `'accept':'application/json, text/event-stream',` +
    `'content-length':Buffer.byteLength(body)}},` +
    `(res)=>{say('${HTTP_ANSWERED_MARKER} '+res.statusCode);res.destroy();});` +
    `req.on('error',(e)=>say(e&&e.code==='ECONNREFUSED'?'${PORT_CLOSED_MARKER}':'err '+(e&&e.code)));` +
    `req.setTimeout(${IN_BOX_RESPONSE_TIMEOUT_MS},()=>{say('${HTTP_SILENT_MARKER}');req.destroy();});` +
    `req.end(body);`;
  let stdout = "";
  try {
    const result = (await sandbox.commands.run(
      `node -e ${JSON.stringify(script)}`,
      { timeoutMs: EVAL_FAILURE_PROBE_TIMEOUT_MS }
    )) as { stdout?: unknown } | null;
    stdout = typeof result?.stdout === "string" ? result.stdout : "";
  } catch {
    // The box did not answer at all. That is an E2B problem, which is ours.
    return null;
  }
  const answered = new RegExp(`${HTTP_ANSWERED_MARKER} (\\d{3})`).exec(stdout);
  if (answered) {
    // A 5xx is the server failing on its own terms — it is running, it is not
    // serving, and that is the PR's code either way.
    //
    // A 4xx deliberately does NOT blame it. This request is a simplified,
    // legacy-shaped `initialize` with none of the modern `_meta` envelope headers
    // the real client sends, so a modern-only server can reject it correctly while
    // remaining perfectly drivable by the eval run. Reading that as the PR's fault
    // would put a red X on a working server, which is the error this whole
    // predicate is shaped to avoid.
    return Number(answered[1]) < 500;
  }
  // Refused, or accepted the connection and then said nothing at all. Either way
  // the server is not serving, and it is the PR's process.
  if (
    stdout.includes(PORT_CLOSED_MARKER) ||
    stdout.includes(HTTP_SILENT_MARKER)
  ) {
    return false;
  }
  // Some other socket error, or no output at all: not evidence of anything, so it
  // must not become evidence against the PR.
  return null;
}

/**
 * Decide whether an eval-phase failure belongs to the PR or to us.
 *
 * `runEvalSuite` throws an ordinary transport error for two very different
 * situations: the PR's server died after passing the health probe, or something on
 * OUR side broke (Convex, the provider, E2B). Both used to land on neutral
 * `infra_error`, which lets a PR whose server crashes seconds after `initialize`
 * escape the `server_unhealthy` it earned.
 *
 * Rather than pattern-matching error messages — fragile, and wrong the first time a
 * provider rewords a timeout — this asks the box whether the server process is
 * still listening, and reclassifies ONLY on a definite "no". A `null` verdict
 * (command channel down, or no answer at all) and a "yes" both leave the original
 * error alone, so they stay neutral. Ambiguity must never produce a red X.
 */
async function attributeEvalFailure(
  error: unknown,
  sandbox: CheckSandbox,
  recipe: CheckRecipe
): Promise<unknown> {
  // Our own typed failures and the lease guard already know what they are.
  if (error instanceof CheckStepError || error instanceof LeaseLostError) {
    return error;
  }
  if ((await serverStillResponding(sandbox, recipe)) !== false) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CheckStepError(
    "server_unhealthy",
    "the server stopped answering after it started",
    clampOutput(
      `The server answered the health probe, then stopped answering on port ${recipe.port} while the eval suite was running — it either refused the connection or accepted it and sent nothing back. Checked from inside the sandbox, so this is the server process and not the network path to it.\n\n${message}`
    )
  );
}

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
 * Run statuses the eval runner treats as final. `timed_out` is included because
 * the runner stamps it before rethrowing — re-finalizing as `failed` would
 * overwrite a real timeout verdict.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Whether the run already has a terminal record — with `unknown` kept distinct
 * from `non_terminal`.
 *
 * That distinction is the point. `unknown` means the LOOKUP failed, not that the
 * run is unfinished, and treating it as unfinished means finalizing the run
 * `failed` on the strength of a transient Convex outage — overwriting a verdict
 * that may well have been a pass. Callers must not write on `unknown`; leaving
 * the run alone lands the check as `infra_error` (neutral), which is the honest
 * answer when we cannot see the run.
 */
type RunTerminality = "terminal" | "non_terminal" | "unknown";

async function runTerminality(
  client: { query: (name: any, args: any) => Promise<any> },
  runId: string
): Promise<RunTerminality> {
  try {
    const run = (await client.query("testSuites:getTestSuiteRun" as any, {
      runId,
    })) as { status?: string } | null;
    if (!run) return "unknown";
    return TERMINAL_RUN_STATUSES.has(String(run.status))
      ? "terminal"
      : "non_terminal";
  } catch {
    return "unknown";
  }
}

/**
 * Whether a run's status means an eval verdict was actually reached.
 *
 * Only `completed` does. The runner writes it on its own success path; `timed_out`,
 * `cancelled` and `failed` all mean the machinery stopped, and two of those arrive
 * WITHOUT a throw — a lifecycle stop (iteration or whole-run timeout) is finalized
 * and returned normally. Since `outcomeForRunResult` calls everything that is not
 * `passed` a PR failure, letting one of those through is a red X on a PR whose
 * assertions were never judged.
 */
export function runReachedAVerdict(status: string | undefined): boolean {
  return status === "completed";
}

/**
 * Did the runner FINISH the run, as opposed to abandoning it?
 *
 * `status: 'completed'` is written only on the runner's own success path, so it
 * is the one status that means a verdict was actually reached. Everything else
 * (`failed`, `timed_out`, `cancelled`) after a throw means the machinery gave
 * up, which is ours to own — neutral, not the PR's failure.
 */
async function runCompleted(
  client: { query: (name: any, args: any) => Promise<any> },
  runId: string
): Promise<boolean> {
  try {
    const run = (await client.query("testSuites:getTestSuiteRun" as any, {
      runId,
    })) as { status?: string } | null;
    return run?.status === "completed";
  } catch {
    return false;
  }
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
/**
 * Which check's server this run's frozen environment names.
 *
 * The dedicated suite is shared, and `refreshSnapshot: true` rewrites its stored
 * environment before the run-start mutation freezes it — two mutations, no
 * atomicity. Two checks running at once (two workers, or two replicas of one) can
 * therefore interleave as: A rewrites → B rewrites → A starts and freezes B's
 * server. A would then evaluate the wrong PR's server, or fail when B deletes it,
 * and either way report a verdict about somebody else's code.
 *
 * This does not fix that race — it detects the case it can prove. Every check names
 * its server `gh-check-<triggerId>`, so:
 *
 *   - the snapshot mentions OUR trigger → `ours`;
 *   - it mentions some other check's trigger and not ours → `stolen`, and the check
 *     is abandoned as neutral rather than reporting a verdict from it;
 *   - it mentions no `gh-check-` server at all → `ours`. Nothing is proven, and the
 *     snapshot's shape is the backend's contract rather than this module's, so an
 *     unrecognised one must not fail every check;
 *   - the query itself fails → `unverifiable`, which the caller also treats as
 *     neutral. Being unable to look is different from looking and finding nothing:
 *     it removes the only guard against publishing a verdict about another PR's
 *     server, and a failed read of ours is ours to own.
 */
export async function verifyRunSnapshot(
  client: ReturnType<typeof createConvexClient>,
  runId: string,
  triggerId: string
): Promise<"ours" | "stolen" | "unverifiable"> {
  let snapshot: unknown;
  try {
    const run = (await client.query("testSuites:getTestSuiteRun" as any, {
      runId,
    })) as { configSnapshot?: { environment?: unknown } } | null;
    snapshot = run?.configSnapshot?.environment;
  } catch {
    // We could not LOOK. During a race that is the one check standing between a
    // wrong-PR verdict and publishing it, so it fails closed — and a Convex read
    // of ours failing is our problem to own, which is what neutral means here.
    return "unverifiable";
  }
  if (snapshot === undefined || snapshot === null) return "ours";
  // Serialized rather than walked: the snapshot carries servers, bindings and
  // display copies in shapes owned by the backend, and a name match anywhere in it
  // is the signal — the ids are unique per ephemeral server.
  const named = [
    ...JSON.stringify(snapshot).matchAll(/gh-check-([A-Za-z0-9_-]+)/g),
  ].map((match) => match[1]);
  // A shape we do not recognise is NOT the same as being unable to look. Failing
  // closed on it would break every check the first time the backend's snapshot
  // shape changed, which is a self-inflicted outage rather than a safeguard.
  if (named.length === 0) return "ours";
  return named.includes(triggerId) ? "ours" : "stolen";
}

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
      // REQUIRED, not incidental. `serverIds` is honored by the manager and by
      // cap math, but it is NOT forwarded to the run-start mutation — the run's
      // `configSnapshot.environment` comes from the suite's PERSISTED
      // environment, and `suiteRerun: true` alone suppresses updating it
      // (`authorEvalSuite`: `shouldUpdateSnapshot = !suiteRerun ||
      // refreshSnapshot`). Without this flag the snapshot keeps naming the
      // previous check's ephemeral server, which no longer exists, and the
      // runner fails against a dead reference instead of testing the PR.
      //
      // This is the "suite binding rewrite" the design already called out as
      // expected: the dedicated suite's stored server ref is rewritten every
      // run. Harmless because we always override `serverIds` too — and the
      // reason this suite is named `[github-checks] …` and must never be
      // launched from the UI.
      refreshSnapshot: true,
      // `source: 'github_check'` would be a two-repo union change; 'api' is the
      // closest existing value and keeps this to one repo (see plan follow-up).
      source: "api",
      convexAuthToken: args.bearer,
      // A claim retry can never double-create a run.
      idempotencyKey: args.claimed.triggerId,
    });

    const client = createConvexClient(args.bearer);

    // The suite is SHARED by every check, and rewriting its environment then
    // starting the run are two separate mutations. Another check's rewrite can
    // land in between, so this run's frozen snapshot can name ITS ephemeral
    // server instead of ours. Verified before anything is evaluated, because a
    // verdict from a run that tested a different PR's server is worse than no
    // verdict at all. See `verifyRunSnapshot` for what is provable.
    const ownership = await verifyRunSnapshot(
      client,
      prepared.runId,
      args.claimed.triggerId
    );
    if (ownership !== "ours") {
      const reason =
        ownership === "stolen"
          ? "another check's server was snapshotted onto this run"
          : "could not verify which server this run was bound to";
      // The run row already exists — `prepareEvalRun` created it — and this throw
      // bypasses the catch around `execute()` where the non-terminal finalize
      // lives. Left alone it would sit in `running` forever, and every raced check
      // would leave another one behind. Best effort: failing to tidy up must not
      // replace the reason we are bailing out.
      if (prepared.recorder) {
        await prepared.recorder
          .finalize({ status: "failed", notes: reason })
          .catch((finalizeError: unknown) => {
            logger.error(
              "[github-checks] failed to finalize an unowned eval run",
              finalizeError,
              { triggerId: args.claimed.triggerId, runId: prepared.runId }
            );
          });
      }
      throw new CheckStepError("infra_error", reason);
    }

    try {
      await prepared.execute();
    } catch (error) {
      // A throw from `execute()` is NOT an eval verdict, and must not be read as
      // one. `runEvalSuiteWithAiSdk` finalizes a normal run — pass or fail —
      // with `status: 'completed'` and a summary; its outer catch writes
      // `status: 'failed'` for any UNEXPECTED exception (Convex unreachable, tool
      // discovery blew up, the transport died) before rethrowing. So a `failed`
      // status here says "the machinery broke", not "the PR's assertions
      // failed" — deriving `evals_failed` from it is a red X on a PR that was
      // never actually judged.
      //
      // Two jobs then: make sure the run does not sit non-terminal forever, and
      // let the original error propagate so it classifies as `infra_error`
      // (neutral). The one exception is a run the runner DID finish
      // (`completed`), where a late throw cannot invalidate a delivered verdict.
      logger.warn("[github-checks] eval run threw; checking its run state", {
        triggerId: args.claimed.triggerId,
        runId: prepared.runId,
        error: error instanceof Error ? error.message : String(error),
      });

      const terminality = await runTerminality(client, prepared.runId);
      if (terminality === "non_terminal" && prepared.recorder) {
        await prepared.recorder
          .finalize({
            status: "failed",
            notes:
              error instanceof Error
                ? error.message.slice(0, 500)
                : String(error).slice(0, 500),
          })
          .catch((finalizeError: unknown) => {
            logger.error(
              "[github-checks] failed to finalize a non-terminal eval run",
              finalizeError,
              { triggerId: args.claimed.triggerId, runId: prepared.runId }
            );
          });
      }

      // `unknown` (we could not read the run) also lands here: not being able to
      // see the run is not evidence the PR failed.
      if (
        terminality !== "terminal" ||
        !(await runCompleted(client, prepared.runId))
      ) {
        throw error;
      }
    }

    const run = (await client.query("testSuites:getTestSuiteRun" as any, {
      runId: prepared.runId,
    })) as {
      status?: string;
      result?: string;
      summary?: CheckSummary;
      passCriteria?: { minimumPassRate?: number };
    } | null;

    // Only `completed` carries a verdict — the same rule `runCompleted` states for
    // the throwing path, applied here too. The runner reaches THIS path without
    // throwing for a lifecycle stop as well: an iteration or whole-run timeout is
    // finalized `timed_out` and returned normally, and `cancelled` arrives the same
    // way. `effectiveRunResult` would hand those straight to `outcomeForRunResult`,
    // which calls everything that is not `passed` a PR failure — so a provider
    // timeout or a cancelled run would put a red X on a PR whose assertions were
    // never judged. Raising instead lands them as `infra_error` (neutral).
    if (!runReachedAVerdict(run?.status)) {
      throw new Error(
        `eval run ${prepared.runId} did not complete (status: ${
          run?.status ?? "unknown"
        })`
      );
    }

    const result = effectiveRunResult(run);
    return {
      runId: prepared.runId,
      ...(result ? { result } : {}),
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

  // Set once the backend tells us the claim is no longer ours. Checked at each
  // step boundary below: there is no point building or evaluating for a check
  // somebody else has already concluded, and the completion would be rejected.
  let leaseLost: LeaseLostError | null = null;

  // The lease is refreshed for the WHOLE duration, including the eval run — a
  // suite legitimately takes many minutes and must not look like a dead worker.
  const heartbeat = setInterval(() => {
    void deps.heartbeat(claimed.triggerId, claimedBy).catch((error) => {
      if (error instanceof LeaseLostError) {
        // Definitive. Stop beating and let the next step boundary bail out.
        leaseLost = error;
        clearInterval(heartbeat);
        logger.warn("[github-checks] lease lost; abandoning this check", {
          ...logContext,
          reason: error.reason,
        });
        return;
      }
      logger.warn("[github-checks] heartbeat failed", {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, deps.heartbeatIntervalMs);
  // Don't hold the event loop open on shutdown.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  /** Throw out of the pipeline if the claim stopped being ours. */
  const assertLeaseHeld = () => {
    if (leaseLost) throw leaseLost;
  };

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
    assertLeaseHeld();
    await deps.cloneAndCheckout(sandbox, {
      repoFullName: claimed.repoFullName,
      prNumber: claimed.prNumber,
      headSha: claimed.headSha,
    });
    assertLeaseHeld();
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

    // The last and most valuable boundary: the eval run is the twenty-minute part.
    assertLeaseHeld();
    // Captured because the failure path reads it from inside a closure, and
    // `sandbox` is a reassignable nullable whose narrowing does not survive that.
    const runningBox = sandbox;
    const run = await deps
      .runEvalSuite({
        claimed,
        bearer,
        serverId,
        serverName,
      })
      .catch(async (error: unknown) => {
        // A failure here may be the PR's server dying mid-run rather than an
        // outage of ours, and the difference decides who gets the red X.
        const attributed = await attributeEvalFailure(
          error,
          runningBox,
          recipe
        );
        // The diagnostic above talks to the box, so it takes real time — long
        // enough for the lease to be taken away while it runs. Re-checked here so
        // a check somebody else has already concluded is abandoned rather than
        // reported on, which is what every other step boundary does.
        assertLeaseHeld();
        throw attributed;
      });

    // The eval is the widest window in this flow — twenty minutes — so the lease
    // can be taken away while it runs and still resolve normally. The failure path
    // re-checks; this one has to as well, or a check the backend already concluded
    // gets a verdict reported over the top of it.
    assertLeaseHeld();

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
    if (error instanceof LeaseLostError) {
      // Nothing to report: the backend already concluded this check, which is why
      // the lease was taken away. Reporting anyway would just be rejected. The
      // `finally` below still tears the sandbox down.
      logger.warn("[github-checks] abandoned a check whose lease was lost", {
        ...logContext,
        reason: error.reason,
      });
      return;
    }
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
  // Checked BEFORE the listener goes on, because an `abort` that already fired
  // never fires again: a listener added afterwards waits out the whole delay. The
  // loop can reach here post-abort whenever `claim()` or `execute()` settles after
  // `stop()`, and the delay may be the 60s backoff — long past the caller's
  // shutdown deadline, which then force-exits an otherwise idle worker.
  if (signal?.aborted) return Promise.resolve();
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

  // Claiming without a usable sandbox configuration is WORSE than not starting:
  // every queued trigger would be claimed, fail to provision, and be concluded
  // `infra_error` — permanently, since a verdict is final. Not polling leaves
  // those checks queued until the deployment is fixed.
  if (!isGithubChecksSandboxConfigured()) {
    logger.warn(
      "[github-checks] worker enabled but E2B_API_KEY / GITHUB_CHECKS_E2B_TEMPLATE_ID missing; not starting (queued checks stay claimable)"
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
