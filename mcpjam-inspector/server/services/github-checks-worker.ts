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
 * reports FACTS; the control plane derives the check conclusion. That split is
 * why a compromised worker cannot write to anyone's repo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A3b-2: THE VERDICT IS NO LONGER COMPUTED HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The loop is now `/plan/begin` → attempts → `/complete`, and the backend owns
 * candidate ORDERING, CONTINUE/STOP and ATTRIBUTION (`convex/github/
 * checkPlans.ts`). `/complete` carries NO `outcome` field; the outcome is
 * derived from the attempt log and the BOUND `testSuiteRun`. See
 * `github-checks/check-plan.ts` for the full sequence and the three rules
 * (409 = hard stop, degraded mode, unknown action) that must not be softened.
 *
 * The invariant that survives unchanged: A CLAIMED TRIGGER ALWAYS GETS A
 * COMPLETION. An unreported claim sits until the backend's heartbeat sweep
 * fails it ~5 minutes later, which shows up on someone's PR as a check that
 * hung and then went neutral.
 *
 * Gated by `GITHUB_CHECKS_WORKER_ENABLED === '1'`. That gate stops this
 * process from CLAIMING work; it is not a kill switch for the feature. The
 * backend's `GITHUB_CHECKS_ENABLED` gate — which this comment used to claim
 * 404s the whole surface — no longer exists, so with the worker off the
 * webhook still accepts deliveries and still inserts triggers. They sit
 * `pending` until the backend's 30-minute sweep retires them as
 * `worker_unavailable`, concluding each check neutral with an explanation.
 */

import { WEB_CALL_TIMEOUT_MS } from "../config.js";
import { logger } from "../utils/logger";
import { getConvexBearerForDelegation } from "../utils/v1-convex-token.js";
import { createAuthorizedManager } from "../routes/web/auth.js";
import { prepareEvalRun,
  shouldSkipExecution,
} from "../routes/shared/evals.js";
import { createConvexClient } from "./evals/route-helpers.js";
import type { CheckRecipe } from "./github-checks/recipes.js";
import {
  CheckStepError,
  clampOutput,
  isGithubChecksSandboxConfigured,
  killCheckSandbox,
  redactCloneCredential,
  type CheckSandbox,
} from "./github-checks/sandbox.js";
import { resolveAndStart } from "./github-checks/resolve-and-start.js";
import {
  beginCheckPlan,
  CheckStoppedByPlan,
  PlanProtocolError,
  PlanUnreachableError,
  type AttemptAction,
  type AttemptInput,
  type CheckPlanSession,
} from "./github-checks/check-plan.js";
import {
  GITHUB_CHECKS_SERVICE_BASE as SERVICE_BASE,
  githubChecksServiceEnv,
  postServiceRoute,
} from "./github-checks/service-route.js";
import { executePersistedConformanceRun } from "./conformance-run-executor.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_JITTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/**
 * Heartbeat cadence. The backend fails a claim whose heartbeat is >5 minutes
 * stale, so 60s leaves room for ~5 consecutive misses before a healthy worker
 * gets its check taken away mid-build.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How long to wait out a run held for its gating judge.
 *
 * The backend's hold has a 30-minute deadline and a sweep that ends it; one
 * minute of slack covers the sweep landing after the deadline. Inside the lease
 * budget by construction: the claim is refreshed by a heartbeat with no wall
 * cap, and that interval already spans the whole `runEvalSuite` call.
 */
const JUDGE_GRADING_WAIT_MS = 31 * 60_000;
/** How often to re-read a held run. Slow: the judge takes minutes, not ticks. */
const JUDGE_GRADING_POLL_MS = 15_000;

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
  /**
   * Whether the checkout needs an installation token to clone.
   *
   * A REQUIRED boolean, matching the backend, which always sends one (`false`
   * for a row that never recorded a visibility). Optional-with-a-default would
   * mean a wire regression silently degrades to "public" — and "public" is the
   * value that clones without a credential, so the failure mode of guessing
   * would be a private repository's check failing rather than the reverse.
   */
  repoPrivate: boolean;
  /**
   * Dual-read: absent/false means this trigger is legacy eval-only. The backend
   * always sends a boolean on new claims; older workers ignore unknown fields.
   */
  conformanceEnabled?: boolean;
  conformanceSuiteKinds?: Array<"protocol" | "apps" | "tasks" | "oauth">;
  /** Repo-config id for grouping GitHub preview conformance history. */
  repoConfigId?: string;
};

export type CheckSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
};

/**
 * The PLANLESS completion, and the ONLY place this worker still names an
 * outcome.
 *
 * It is reachable in exactly one situation: `/plan/begin` did not give us a
 * plan, so there is nothing to derive a verdict from and the derived shape
 * cannot be used at all. The alternative is leaving a claimed check silent
 * until the heartbeat sweep times it out five minutes later, which is a worse
 * experience for the same conclusion.
 *
 * `infra_error` is the only value it ever carries — never a green, never a
 * PR-blamed outcome, which is the degraded-mode contract. It retires with the
 * legacy explicit-`outcome` `/complete` shape, in the same follow-up.
 */
export type PlanlessCheckReport = {
  triggerId: string;
  outcome: "infra_error";
  failureReason?: string;
  detailsMarkdown?: string;
};

export function isGithubChecksWorkerEnabled(): boolean {
  return process.env.GITHUB_CHECKS_WORKER_ENABLED === "1";
}

function requiredEnv(): { convexUrl: string; serviceToken: string } | null {
  return githubChecksServiceEnv();
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

async function reportPlanlessOutcome(
  report: PlanlessCheckReport
): Promise<void> {
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

/**
 * The backend could not give us a credential for a private repository.
 *
 * A DISTINCT type, because the response it demands is distinct from every other
 * failure in this file: it happens after `/plan/begin` and before anything is
 * provisioned, so it is reported as a ladder-level `clone` attempt on the plan
 * that already exists — never through the planless path, and never as the pull
 * request's fault. Nothing about a PR can cause it.
 */
export class CloneTokenUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`clone token unavailable: ${detail}`);
    this.name = "CloneTokenUnavailableError";
  }
}

/**
 * Mint the clone credential for THIS claim, or find out we no longer hold it.
 *
 * Three answers, and the difference between them is the whole contract:
 *
 *   200 + `cloneToken: null`   nothing was needed. Only legal for a public
 *                              repository; for a private one the caller treats
 *                              it as a mint failure, because a null token and a
 *                              502 leave us equally unable to clone.
 *   200 + `cloneToken: string` use it for clone/fetch and nothing else.
 *   409                        this worker is not the claim holder any more.
 *                              LEASE LOSS — the check has already been
 *                              concluded by somebody else, so we must not
 *                              manufacture a competing completion.
 *   502 (or anything else)     the mint failed backend-side. The message is
 *                              deliberately flat there and stays flat here.
 *   no answer at all           a transport failure or the route's deadline.
 *                              Typed as the 502 case, so it reaches the same
 *                              ladder-level `clone_failed` rather than falling
 *                              through as an untyped throw.
 *
 * The token is NEVER logged, and no branch of this function puts the response
 * body into an error — a 502's body is a constant string, and a 200's body is
 * the secret itself.
 */
async function mintCloneToken(
  triggerId: string,
  claimedBy: string
): Promise<string | null> {
  let status: number;
  let body: any;
  try {
    ({ status, body } = await postServiceRoute(`${SERVICE_BASE}/clone-token`, {
      triggerId,
      claimedBy,
    }));
  } catch (error) {
    // THE ROUTE NEVER ANSWERED — a network failure, a missing service-token
    // env, or the service-route's own 15s deadline. Materially identical to a
    // 502: we hold no credential and cannot clone. It is typed as the same
    // failure so it takes the same branch, because an untyped throw here would
    // fall through to the generic catch, which has no degraded marker for it
    // either — and would complete the freshly opened plan with an EMPTY attempt
    // log. A check that ran nothing and reported nothing is the one shape the
    // plan shell exists to prevent.
    throw new CloneTokenUnavailableError(
      `the clone-token route could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (status === 409) {
    throw new LeaseLostError(String(body?.error ?? "not_the_claim_holder"));
  }
  if (status !== 200 || !body?.ok) {
    throw new CloneTokenUnavailableError(
      `the backend could not mint a clone token (${status})`
    );
  }
  const token = body.cloneToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Test seam: the heartbeat's response validation is the whole point of it. */
export const sendHeartbeatForTests = sendHeartbeat;

/**
 * Test seam: the clone-token contract is a two-repo hand-mirror, so the status
 * mapping (409 ⇒ lease loss, 502 ⇒ mint failure) is worth pinning at the wire.
 */
export const mintCloneTokenForTests = mintCloneToken;

/**
 * Test seam: `repoPrivate` arriving intact is the difference between cloning a
 * private repository and not, and the claim body is where it can get dropped.
 */
export const claimNextForTests = claimNext;

/**
 * Test seam for the real eval integration. The worker tests replace
 * `runEvalSuite` with a stub, which means nothing asserts what
 * `defaultRunEvalSuite` actually passes to `prepareEvalRun` — and the
 * `source: 'github_check'` provenance label lives exactly there.
 */
export const defaultRunEvalSuiteForTests = () => defaultRunEvalSuite;

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
 * DESCRIBE a thrown failure. It no longer classifies one.
 *
 * The outcome used to be decided here, from the error's type: `CheckStepError`
 * carried the sandbox's verdict and `RecipeStartError` the resolver's. Both are
 * gone as verdict sources — attribution moved to `convex/github/checkPlans.ts`,
 * where "a candidate build failure is a miss, not a red X" can change without
 * an Inspector deploy. What is left is DISPLAY: the short reason for the logs
 * and the author-facing markdown for the check output, neither of which has any
 * verdict authority.
 *
 * The one message match that survives is the backend's canonical
 * `billing_limit_reached` code — an MCPJam-side limit, worth naming plainly in
 * the check output so nobody debugs their build over it.
 */
export function describeCheckFailure(error: unknown): {
  failureReason: string;
  detailsMarkdown?: string;
  /**
   * The details are OUR prose, not clamped PR output — the resolver's failure
   * copy is constant text (plus, for `recipe_invalid`, the yaml parser message
   * that `mcpjamYaml.ts` already clamped and fenced itself). Running it through
   * `clampOutput` would wrap a markdown block — headings, a yaml example — in a
   * `text` fence and render it as source, so the caller passes it through.
   */
  detailsPreformatted?: boolean;
} {
  if (error instanceof CheckStoppedByPlan) {
    return {
      failureReason: error.reason.slice(0, 200),
      ...(error.detailsMarkdown
        ? {
            detailsMarkdown: error.detailsMarkdown.slice(
              0,
              RESOLVER_DETAILS_MAX_CHARS
            ),
            ...(error.detailsPreformatted ? { detailsPreformatted: true } : {}),
          }
        : {}),
    };
  }
  if (error instanceof CheckStepError) {
    return {
      failureReason: error.message.slice(0, 200),
      ...(error.detailsMarkdown
        ? { detailsMarkdown: error.detailsMarkdown }
        : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/billing_limit_reached/i.test(message)) {
    return { failureReason: "billing_limit_reached" };
  }
  return { failureReason: message.slice(0, 200) };
}

/**
 * The error, with any clone credential removed from its message AND its stack.
 *
 * A COPY rather than a mutation: the original is what the `finally` and the
 * caller still hold, and rewriting a thrown object's message under them is the
 * kind of action at a distance that is impossible to reason about later.
 *
 * This is the second line of defence, not the first. `sandbox.ts` redacts at the
 * boundary where the credential-bearing text first becomes ours, so the error
 * arriving here is already clean; this exists because `logger.error` is the
 * server's single Sentry capture path, and a secret that reaches Sentry cannot
 * be recalled from it. The constant `AUTHORIZATION:` sweep runs whether or not
 * a token is held; the token-derived forms are removed only when one is.
 */
function redactErrorForLog(error: unknown, cloneToken: string | null): unknown {
  if (!(error instanceof Error)) return error;
  const message = redactCloneCredential(error.message, cloneToken);
  const stack = error.stack
    ? redactCloneCredential(error.stack, cloneToken)
    : error.stack;
  // UNCHANGED ⇒ the ORIGINAL, class and all. Only a genuinely
  // credential-bearing error is replaced, so the overwhelming majority of
  // failures still reach the logger as the typed error they were thrown as —
  // and the constant `AUTHORIZATION:` sweep still runs on every one of them,
  // whether or not a token is currently held.
  if (message === error.message && stack === error.stack) return error;
  const copy = new Error(message);
  copy.name = error.name;
  if (stack) copy.stack = stack;
  return copy;
}

/**
 * Cap on the resolver's own failure copy. Bounded by construction already
 * (constant strings plus one clamped parser message), so this is a backstop
 * against a future message growing without anyone noticing, not a sanitizer.
 */
const RESOLVER_DETAILS_MAX_CHARS = 8_000;

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
  /**
   * Mint the plan SHELL. Called FIRST — before a box is provisioned, before the
   * checkout exists — so that provision, clone and detection failures are
   * attributable through the ordinary attempt path instead of needing a second,
   * planless completion contract forever.
   */
  beginPlan: (claimed: ClaimedGithubCheck) => Promise<CheckPlanSession>;
  /**
   * Mint the private-repository clone credential. Called ONLY when the claim
   * says `repoPrivate`, and only between `beginPlan` and the first provision —
   * see the ordering note in `executeClaimedCheck`.
   */
  mintCloneToken: (
    triggerId: string,
    claimedBy: string
  ) => Promise<string | null>;
  /**
   * The deterministic ladder plus the sandboxes it needs — provisioning,
   * cloning, building, the runtime verification, and a FRESH BOX PER CANDIDATE
   * — executing the BACKEND'S plan, in the backend's order.
   *
   * On success exactly one box is alive (the one in the result); on failure this
   * call has already killed every box it created. `onSandbox` keeps the
   * worker's own handle in step either way, so the `finally` below can never
   * orphan one.
   */
  resolveAndStart: typeof resolveAndStart;
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
    /**
     * Called with the run's id THE MOMENT IT EXISTS, before the suite is
     * executed. That call is what posts the `eval` attempt, and that attempt is
     * what BINDS the run to this check — the backend records it as
     * `plan.boundRunId` and reads the verdict from there. Posting it after the
     * run finished would leave a window in which the check has a running suite
     * and no binding, and a completion in that window can only ever be
     * `infra_error`. A throw from here aborts the run, deliberately: an
     * unbindable run is a run whose result nothing may read.
     */
    onRunStarted?: (runId: string) => Promise<void>;
    /**
     * False once the claim stops being ours.
     *
     * Read only while WAITING OUT a gating judge's hold — there is no point
     * spending half an hour on a check the backend has already concluded, and
     * the completion would be rejected anyway.
     */
    isLeaseHeld?: () => boolean;
  }) => Promise<{ runId: string; result?: string; summary?: CheckSummary }>;
  /**
   * Dual-check: run the conformance suites against the same verified preview
   * server on an INDEPENDENT MCP session. Called only when the backend answers
   * `run_conformance` after the eval bind. Product failures of eval must not
   * skip this; sandbox death / launch infra still may.
   */
  runConformance: (args: {
    claimed: ClaimedGithubCheck;
    bearer: string;
    serverUrl: string;
    candidateId: string;
    onRunStarted?: (runId: string) => Promise<void>;
  }) => Promise<{ runId: string }>;
  /** The PLANLESS completion. Only reachable when `/plan/begin` gave us none. */
  report: (report: PlanlessCheckReport) => Promise<void>;
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
 * SAY whether an eval-phase failure looks like the PR's server dying.
 *
 * `runEvalSuite` throws an ordinary transport error for two very different
 * situations: the PR's server died after passing the health probe, or something
 * on OUR side broke (Convex, the provider, E2B). Rather than pattern-matching
 * error messages — fragile, and wrong the first time a provider rewords a
 * timeout — this asks the box whether the server process is still listening,
 * and speaks up ONLY on a definite "no". A `null` verdict (command channel
 * down, or no answer at all) and a "yes" both leave the error's own text alone.
 *
 * IT NO LONGER RECLASSIFIES THE OUTCOME. Once the eval attempt is posted the
 * plan is terminal and the verdict comes from the BOUND run; there is no legal
 * channel for the worker to assert `server_unhealthy` after that, and inventing
 * one would put the verdict back in this process. So the diagnostic survives as
 * what it always really was — the sentence that tells the author what happened
 * — and it rides to `/complete` as DISPLAY text with no verdict authority.
 */
async function describeEvalFailure(
  error: unknown,
  sandbox: CheckSandbox,
  recipe: CheckRecipe
): Promise<string | undefined> {
  // Our own typed failures and the lease guard already say what they are.
  if (error instanceof CheckStepError || error instanceof LeaseLostError) {
    return undefined;
  }
  if ((await serverStillResponding(sandbox, recipe)) !== false)
    return undefined;
  const message = error instanceof Error ? error.message : String(error);
  return clampOutput(
    `The server answered the health probe, then stopped answering on port ${recipe.port} while the eval suite was running — it either refused the connection or accepted it and sent nothing back. Checked from inside the sandbox, so this is the server process and not the network path to it.\n\n${message}`
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
type RunTerminality =
  | "terminal"
  | "non_terminal"
  /**
   * Every trial finished; the run is HELD for its gating judge.
   *
   * Its own answer rather than `non_terminal`, because the two want opposite
   * treatment on the throwing path below: a non-terminal run is abandoned and
   * must be finalized `failed`, while a held run is one the platform is about
   * to decide — finalizing it would overwrite a verdict that is minutes away.
   */
  | "grading"
  | "unknown";

async function runTerminality(
  client: { query: (name: any, args: any) => Promise<any> },
  runId: string
): Promise<RunTerminality> {
  try {
    const run = (await client.query("testSuites:getTestSuiteRun" as any, {
      runId,
    })) as { status?: string } | null;
    if (!run) return "unknown";
    if (run.status === "grading") return "grading";
    return TERMINAL_RUN_STATUSES.has(String(run.status))
      ? "terminal"
      : "non_terminal";
  } catch {
    return "unknown";
  }
}

/**
 * Read a run, waiting out a gating judge's hold.
 *
 * IT DECIDES NOTHING. It returns the last row it read, and every judgement
 * stays where it was: `runReachedAVerdict` is unchanged and still answers
 * `false` for `grading`, so a wait that runs out throws and the check lands
 * `infra_error` (neutral). That is the property worth having — a gating run is
 * never neutral while its judge is still within its deadline, and it is never
 * RED without a verdict.
 *
 * A read that throws is logged and retried: a transient Convex blip during a
 * 31-minute wait is not evidence about the run.
 */
export async function awaitJudgeVerdict(
  client: { query: (name: any, args: any) => Promise<any> },
  runId: string,
  options: {
    waitMs: number;
    pollMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** False once the claim stops being ours — stop waiting for somebody else. */
    isLeaseHeld?: () => boolean;
  }
): Promise<{
  status?: string;
  result?: string;
  summary?: CheckSummary;
  passCriteria?: { minimumPassRate?: number };
} | null> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.waitMs;

  const read = async () =>
    (await client.query("testSuites:getTestSuiteRun" as any, {
      runId,
    })) as {
      status?: string;
      result?: string;
      summary?: CheckSummary;
      passCriteria?: { minimumPassRate?: number };
    } | null;

  let run = await read();
  while (run?.status === "grading") {
    if (options.isLeaseHeld?.() === false) return run;
    if (now() >= deadline) return run;
    await sleep(options.pollMs);
    try {
      run = await read();
    } catch (error) {
      // Not evidence about the run. Keep the last row and try again.
      logger.warn("[github-checks] failed to re-read a run held for grading", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return run;
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

/**
 * Tidy up a run that `prepareEvalRun` created but that must never be evaluated.
 *
 * By the time this is reachable the run row exists AND so does one pending
 * iteration row per attempt, and the throw that follows bypasses the catch
 * around `execute()` where the normal cleanup lives. Left alone the run sits in
 * `running` with every iteration `pending`, forever.
 *
 * Every abort between "the run exists" and "the run is running" goes through
 * here so the three sites cannot drift: fail the iterations first, then the run,
 * both best effort — failing to tidy up must never replace the reason we are
 * bailing out.
 */
async function abandonPreparedRun(
  client: ReturnType<typeof createConvexClient>,
  prepared: Awaited<ReturnType<typeof prepareEvalRun>>,
  ctx: { triggerId: string; reason: string; what: string }
): Promise<void> {
  const notes = ctx.reason.slice(0, 500);
  await client
    .mutation("testSuites:markSetupPendingIterationsFailed" as any, {
      runId: prepared.runId,
      error: notes,
    })
    .catch((cleanupError: unknown) => {
      logger.warn(
        `[github-checks] failed to fail pending iterations after ${ctx.what}`,
        {
          triggerId: ctx.triggerId,
          runId: prepared.runId,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        }
      );
    });
  if (prepared.recorder) {
    await prepared.recorder
      .finalize({ status: "failed", notes })
      .catch((finalizeError: unknown) => {
        logger.error(
          `[github-checks] failed to finalize ${ctx.what}`,
          finalizeError,
          { triggerId: ctx.triggerId, runId: prepared.runId }
        );
      });
  }
}

async function defaultRunEvalSuite(args: {
  claimed: ClaimedGithubCheck;
  bearer: string;
  serverId: string;
  serverName: string;
  onRunStarted?: (runId: string) => Promise<void>;
  isLeaseHeld?: () => boolean;
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
      // Distinguishes check-triggered runs from real /api/v1 calls in run
      // history and heartbeat accounting (backend union accepts this value).
      source: "github_check",
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
      // Each raced check would otherwise strand another set of pending rows.
      await abandonPreparedRun(client, prepared, {
        triggerId: args.claimed.triggerId,
        reason,
        what: "an unowned eval run",
      });
      throw new CheckStepError("infra_error", reason);
    }

    // BIND THE RUN, NOW. The run row exists, it has been proven to be ours, and
    // nothing has been evaluated yet — so this is the launch moment the `eval`
    // attempt names. Posting it here rather than after `execute()` is what makes
    // the binding hold for the whole run: `run.createdAt >= plan.createdAt` plus
    // "no other plan holds it" is what turns "belongs to the shared suite" into
    // "belongs to THIS check". A throw from here (a 409, an unreachable backend)
    // aborts before a single test runs, which is right — a run nothing may read
    // is a run not worth paying for — but it must not be a run left `running`
    // with pending iterations either, so the abort tidies up the same way the
    // unowned-run branch above does before the error propagates.
    try {
      await args.onRunStarted?.(prepared.runId);
    } catch (bindError) {
      await abandonPreparedRun(client, prepared, {
        triggerId: args.claimed.triggerId,
        reason:
          bindError instanceof Error ? bindError.message : String(bindError),
        what: "an unbindable eval run",
      });
      throw bindError;
    }

    try {
      // A redelivered claim replays the run its trigger id already started. If
      // that run FINISHED, re-executing would run the suite a second time and
      // bill for it — and the verdict this check needs is already recorded on
      // it. Only the execution is skipped; everything below still reads the
      // run's terminality and reports it, which is exactly what a redelivery
      // should do.
      if (shouldSkipExecution(prepared)) {
        logger.info("[github-checks] trigger already ran — not re-executing", {
          triggerId: args.claimed.triggerId,
          runId: prepared.runId,
          status: prepared.status,
        });
      } else {
        await prepared.execute();
      }
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
      //
      // `grading` falls THROUGH to the verdict read below, exactly as a
      // completed run does. The run's trials all finished and the backend is
      // holding it for its judge — the throw was about something after the
      // run, and rethrowing here would land the check neutral on a run that is
      // about to produce a real verdict.
      if (terminality !== "terminal" && terminality !== "grading") {
        throw error;
      }
      if (
        terminality === "terminal" &&
        !(await runCompleted(client, prepared.runId))
      ) {
        throw error;
      }
    }

    // Waits out a gating judge's hold, and decides nothing: `runReachedAVerdict`
    // below is unchanged and still refuses `grading`, so a wait that runs out
    // lands the check `infra_error` (neutral) rather than red on no verdict.
    const run = await awaitJudgeVerdict(client, prepared.runId, {
      waitMs: JUDGE_GRADING_WAIT_MS,
      pollMs: JUDGE_GRADING_POLL_MS,
      ...(args.isLeaseHeld ? { isLeaseHeld: args.isLeaseHeld } : {}),
    });

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

async function defaultRunConformance(args: {
  claimed: ClaimedGithubCheck;
  bearer: string;
  serverUrl: string;
  candidateId: string;
  onRunStarted?: (runId: string) => Promise<void>;
}): Promise<{ runId: string }> {
  // The configured snapshot is passed through INTACT, `oauth` included. The
  // backend refuses to configure OAuth for a check, but a row written before
  // that refusal existed must not be quietly narrowed here: dropping a
  // configured suite greens a check that never examined it. The executor
  // records an OAuth the App cannot perform as an explicit incomplete, which
  // is a non-green verdict and an honest one.
  const suites = args.claimed.conformanceSuiteKinds ?? [
    "protocol",
    "apps",
    "tasks",
  ];
  const target = args.claimed.repoConfigId
    ? {
        kind: "github_repo" as const,
        githubCheckRepoConfigId: args.claimed.repoConfigId,
        serverUrl: args.serverUrl,
      }
    : {
        kind: "external" as const,
        serverRef: args.claimed.repoFullName,
        serverUrl: args.serverUrl,
      };
  const result = await executePersistedConformanceRun({
    convexToken: args.bearer,
    projectId: args.claimed.projectId,
    server: { url: args.serverUrl },
    suites,
    source: "github_app",
    target,
    githubCheckTriggerId: args.claimed.triggerId,
    actorLabel: `github-app:${args.claimed.repoFullName}`,
    onRunStarted: args.onRunStarted,
  });
  return { runId: result.runId };
}

function defaultDeps(): CheckExecutionDeps {
  return {
    beginPlan: (claimed) =>
      beginCheckPlan({
        triggerId: claimed.triggerId,
        repoFullName: claimed.repoFullName,
        headSha: claimed.headSha,
      }),
    mintCloneToken,
    resolveAndStart,
    killSandbox: killCheckSandbox,
    getBearer: getConvexBearerForDelegation,
    createEphemeralServer: defaultCreateEphemeralServer,
    deleteEphemeralServer: defaultDeleteEphemeralServer,
    recordServer: recordEphemeralServer,
    runEvalSuite: defaultRunEvalSuite,
    runConformance: defaultRunConformance,
    report: reportPlanlessOutcome,
    heartbeat: sendHeartbeat,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

/**
 * Execute one claimed check end to end. NEVER throws, and every exit path
 * completes the check — see the invariants at the top of the file.
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
  // completion into a thrown error — the poll loop would read that as a
  // transport failure and back off, while the backend's heartbeat sweep would
  // eventually conclude the check `infra_error` anyway.
  const safeReport = async (report: PlanlessCheckReport): Promise<void> => {
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

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2 — MINT THE PLAN SHELL, BEFORE ANY SANDBOX WORK.
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Everything after this point is attributable through the ordinary
  // attempt/complete path — including a provision that never came up and a
  // clone that 404'd, which is exactly the class of failure operators most need
  // counted. Failing HERE is the one case with no plan to complete against, so
  // it is also the one case that still names an outcome, and only ever the
  // neutral one.
  let session: CheckPlanSession;
  try {
    session = await deps.beginPlan(claimed);
  } catch (error) {
    clearInterval(heartbeat);
    const detail =
      error instanceof PlanProtocolError
        ? `the backend refused to open a plan for this check: ${error.reason}`
        : error instanceof PlanUnreachableError
        ? `the backend could not be reached to open a plan: ${error.detail}`
        : error instanceof Error
        ? error.message
        : String(error);
    logger.warn("[github-checks] could not begin a plan; nothing was run", {
      ...logContext,
      detail,
    });
    // No local fallback, and NOTHING is provisioned: a check we cannot plan is a
    // check we must not execute, because executing it would mean running our own
    // candidate policy invisibly — the one thing degraded mode forbids.
    await safeReport({
      triggerId: claimed.triggerId,
      outcome: "infra_error",
      failureReason: detail.slice(0, 200),
    });
    return;
  }

  /**
   * Complete the check. NO `outcome` — the backend derives it from the attempt
   * log and the bound run.
   */
  const safeComplete = async (input: {
    runId?: string;
    conformanceRunId?: string;
    summary?: CheckSummary;
    detailsMarkdown?: string;
    terminalAttempt?: AttemptInput;
  }): Promise<void> => {
    try {
      await session.complete(input);
    } catch (error) {
      logger.warn("[github-checks] completing the check failed", {
        ...logContext,
        planId: session.planId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * The DEGRADED marker, when the loop stopped because the backend went away.
   *
   * `backend_unreachable` is legal at every phase and either scope, and the
   * backend attributes it to `infra_error` — neutral, never a green, never
   * PR-blamed. It is what makes degraded runs COUNTABLE rather than inferred
   * from a check that simply went quiet.
   */
  const degradedMarker = (error: unknown): AttemptInput | undefined => {
    if (!(error instanceof PlanUnreachableError)) return undefined;
    return {
      ...(error.at?.candidateId ? { candidateId: error.at.candidateId } : {}),
      phase: error.at?.phase ?? "resolve",
      ok: false,
      failureKind: "backend_unreachable",
      durationMs: 0,
      detailsClamped: error.detail.slice(0, 500),
    };
  };

  /** The plan's id for the candidate the backend ACCEPTED, once it has one. */
  let acceptedCandidateId: string | null = null;
  /** Set once the `eval` attempt landed. Dual-check: the plan is NOT terminal. */
  let runBound = false;
  /** Set once the `conformance` attempt landed. */
  let conformanceBound = false;
  /** What the backend said to do after the eval bind. */
  let afterEvalAction: AttemptAction | undefined;
  /** The in-box diagnostic for an eval that died. DISPLAY text, no authority. */
  let evalFailureDetails: string | undefined;

  /**
   * The clone credential, for a private repository only. Held in a local, never
   * written to a field of any long-lived object, and passed exactly one place:
   * the clone.
   */
  let cloneToken: string | null = null;

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3 — MINT THE CLONE CREDENTIAL, AFTER THE PLAN AND BEFORE THE BOX.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The ordering is load-bearing in BOTH directions:
    //
    //   after `beginPlan`   so a mint failure has a plan to be reported
    //                       against, and lands as an ordinary `clone` attempt
    //                       rather than a second planless completion;
    //   before `provision`  so a check we already know cannot clone never costs
    //                       an E2B box, and the failure cannot be confused with
    //                       one the sandbox caused.
    //
    // A PUBLIC claim never calls the route at all. That is not an optimization:
    // it is what keeps the blast radius of a `contents: read` mint proportional
    // to the number of checks that genuinely need one.
    if (claimed.repoPrivate) {
      try {
        cloneToken = await deps.mintCloneToken(claimed.triggerId, claimedBy);
      } catch (error) {
        // THE PHASE DECIDES THE ATTRIBUTION, NOT THE ERROR'S TYPE. `mintCloneToken`
        // already types its own failures, but this step must hold whatever the
        // dep throws: anything that is not a lease loss means we reached the
        // clone with no credential, and it has to land as `clone_failed` on the
        // plan we just opened. Letting an untyped throw through would take the
        // generic path, which has no degraded marker for it either — and would
        // complete a fresh plan with an EMPTY attempt log, a check that ran
        // nothing and reported nothing.
        if (error instanceof LeaseLostError) throw error;
        throw error instanceof CloneTokenUnavailableError
          ? error
          : new CloneTokenUnavailableError(
              error instanceof Error ? error.message : String(error)
            );
      }
      if (!cloneToken) {
        // A null token is only ever legal for a public repository. Here it means
        // the same thing a 502 does — we cannot clone — so it gets the same
        // answer rather than a silent anonymous attempt that would 404 and read
        // as the repository having vanished.
        throw new CloneTokenUnavailableError(
          "the backend returned no clone token for a private repository"
        );
      }
      assertLeaseHeld();
    }

    // Runs the deterministic ladder against the checkout, then executes the
    // BACKEND'S candidates in the BACKEND'S order, reporting every phase, and
    // leaves the accepted box running a verified server. Provisioning, cloning,
    // building, the probe and the listener-identity check all
    // live in there, because the fresh-box-per-candidate policy is only
    // expressible where the boxes are made.
    const resolved = await deps.resolveAndStart(
      {
        triggerId: claimed.triggerId,
        repoFullName: claimed.repoFullName,
        prNumber: claimed.prNumber,
        headSha: claimed.headSha,
        ...(cloneToken ? { cloneToken } : {}),
      },
      {
        plan: session,
        // Keeps this function's handle on the LIVE box current, so the
        // `finally` below kills whatever is still alive and never a box that
        // was already torn down and replaced.
        onSandbox: (box) => {
          sandbox = box;
        },
        assertLeaseHeld,
      }
    );
    sandbox = resolved.sandbox;
    acceptedCandidateId = resolved.candidateId;
    const recipe = resolved.recipe;
    const started = resolved.started;
    assertLeaseHeld();

    logger.info("[github-checks] PR server is reachable", {
      ...logContext,
      planId: session.planId,
      candidate: resolved.candidateId,
      url: started.url,
      rung: resolved.provenance.recipeRung,
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
        // STEP 9 — the attempt that BINDS the run, posted AT LAUNCH.
        onRunStarted: async (runId) => {
          const decision = await session.attempt({
            candidateId: resolved.candidateId,
            phase: "eval",
            ok: true,
            runId,
            durationMs: 0,
          });
          afterEvalAction = decision.action;
          runBound = true;
        },
        isLeaseHeld: () => leaseLost === null,
      })
      .catch(async (error: unknown) => {
        evalFailureDetails = await describeEvalFailure(
          error,
          runningBox,
          recipe
        );
        assertLeaseHeld();

        if (
          !runBound &&
          !(error instanceof PlanProtocolError) &&
          !(error instanceof PlanUnreachableError)
        ) {
          await session
            .attempt({
              candidateId: resolved.candidateId,
              phase: "eval",
              ok: false,
              failureKind: "sandbox_error",
              durationMs: 0,
              detailsClamped:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : String(error).slice(0, 500),
            })
            .catch(() => {});
        }
        throw error;
      });

    assertLeaseHeld();

    let conformanceRunId: string | undefined;
    // Dual-check: product failures of eval still run conformance. Infra
    // throws above skip it so a dead box is not probed twice.
    if (afterEvalAction === "run_conformance") {
      try {
        const conformance = await deps.runConformance({
          claimed,
          bearer,
          serverUrl: started.url,
          candidateId: resolved.candidateId,
          onRunStarted: async (boundId) => {
            await session.attempt({
              candidateId: resolved.candidateId,
              phase: "conformance",
              ok: true,
              conformanceRunId: boundId,
              durationMs: 0,
            });
            conformanceBound = true;
          },
        });
        conformanceRunId = conformance.runId;
      } catch (error: unknown) {
        assertLeaseHeld();
        if (
          !conformanceBound &&
          !(error instanceof PlanProtocolError) &&
          !(error instanceof PlanUnreachableError)
        ) {
          await session
            .attempt({
              candidateId: resolved.candidateId,
              phase: "conformance",
              ok: false,
              failureKind: "sandbox_error",
              durationMs: 0,
              detailsClamped:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : String(error).slice(0, 500),
            })
            .catch(() => {});
        }
        logger.warn("[github-checks] conformance family failed to launch", {
          ...logContext,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await safeComplete({
      runId: run.runId,
      ...(conformanceRunId ? { conformanceRunId } : {}),
      ...(run.summary ? { summary: run.summary } : {}),
    });
  } catch (error) {
    if (error instanceof LeaseLostError) {
      // Nothing to complete: the backend already concluded this check, which is
      // why the lease was taken away. Completing anyway would just be rejected.
      // The `finally` below still tears the sandbox down.
      logger.warn("[github-checks] abandoned a check whose lease was lost", {
        ...logContext,
        reason: error.reason,
      });
      return;
    }
    if (error instanceof CloneTokenUnavailableError) {
      // Reported ON THE PLAN, as a LADDER-scoped `clone` attempt: no candidate
      // exists yet (nothing has been provisioned, let alone detected), and the
      // backend attributes a ladder `clone_failed` as `infra_error`. It is ours
      // — an app installation, a GitHub outage, a minting bug — and there is no
      // reading of it that is the pull request's fault.
      const detail = redactCloneCredential(error.detail, cloneToken).slice(
        0,
        500
      );
      logger.error(
        "[github-checks] could not mint a clone token",
        redactErrorForLog(error, cloneToken),
        { ...logContext, planId: session.planId, detail }
      );
      await safeComplete({
        detailsMarkdown:
          "MCPJam could not obtain a credential to clone this private repository, so nothing was built or evaluated. This is an MCPJam-side failure, not a problem with the pull request — check that the MCPJam GitHub App is still installed on this repository and retry the check.",
        terminalAttempt: {
          phase: "clone",
          ok: false,
          failureKind: "clone_failed",
          durationMs: 0,
          detailsClamped: detail,
        },
      });
      return;
    }
    const described = describeCheckFailure(error);
    // Redacted BEFORE any of it is logged, completed or clamped. A clone that
    // failed inside the box is the one failure whose text can have touched the
    // credential, and `describeCheckFailure` is a formatter — it has no idea a
    // secret is in play.
    const failureReason = redactCloneCredential(
      described.failureReason,
      cloneToken
    );
    logger.error(
      "[github-checks] check failed",
      redactErrorForLog(error, cloneToken),
      {
        ...logContext,
        planId: session.planId,
        reason: failureReason,
        candidate: acceptedCandidateId,
      }
    );
    // NO OUTCOME. Every failure that got this far was reported as an attempt at
    // the phase it happened at; the backend derives what it adds up to. The only
    // things travelling here are display text and — when the backend went away
    // mid-flight — the degraded marker.
    const rawDetails = described.detailsMarkdown ?? evalFailureDetails;
    const details = rawDetails
      ? redactCloneCredential(rawDetails, cloneToken)
      : undefined;
    const marker = degradedMarker(error);
    await safeComplete({
      ...(details
        ? {
            detailsMarkdown: described.detailsPreformatted
              ? details
              : clampOutput(rawOf(details)),
          }
        : {}),
      ...(marker
        ? {
            terminalAttempt: {
              ...marker,
              ...(marker.detailsClamped
                ? {
                    detailsClamped: redactCloneCredential(
                      marker.detailsClamped,
                      cloneToken
                    ),
                  }
                : {}),
            },
          }
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

  // `CONVEX_URL` is a SEPARATE variable from `CONVEX_HTTP_URL` above, and it is
  // read later and deeper: `createConvexClient` throws "CONVEX_URL is not set"
  // when the ephemeral server is created, which is AFTER the box is provisioned
  // and the PR is built. A deployment holding one but not the other would claim a
  // trigger, spend ten minutes on it, and conclude `infra_error` — for the same
  // reason as the sandbox gate below, checked here instead.
  if (!process.env.CONVEX_URL) {
    logger.warn(
      "[github-checks] worker enabled but CONVEX_URL missing; not starting (queued checks stay claimable)"
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
