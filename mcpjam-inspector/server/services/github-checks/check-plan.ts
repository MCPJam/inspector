/**
 * The BACKEND-OWNED plan / verdict loop, from the worker's side.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE MOVED OUT OF THE INSPECTOR, AND WHY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Settled architecture (plan 5, 08-03): the moat is the DATA FLYWHEEL, not the
 * security logic. Sandbox execution stays open and inspectable — attackers
 * observe behaviour anyway, and correctness must never depend on secrecy. What
 * compounds across repositories is which recipes worked, why attempts failed,
 * and how candidates get ordered. So:
 *
 *   THE INSPECTOR STOPPED    ordering candidates; deciding continue/stop;
 *                            computing the final outcome. `resolveAndStart`'s
 *                            local attribution mapping is gone — it reports a
 *                            `failureKind` and the backend derives the verdict.
 *   THE INSPECTOR KEPT       deterministic `mcpjam.yaml` parsing and detection;
 *                            clone/build/start/probe; E2B lifecycle; cleanup;
 *                            `/proc` listener identity; telemetry. All still in
 *                            the open.
 *
 * The accepted cost, named: a check now depends on this backend mid-flight, so
 * a self-hosted Inspector cannot run checks standalone. That is the moat
 * working as intended, and it is a deliberate position rather than an emergent
 * one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEQUENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. claim (unchanged)
 *   2. POST /plan/begin { triggerId, repoFullName, headSha } → { planId }
 *      ← FIRST, before ANY sandbox work. Provisioning, cloning and detection
 *        all fail BEFORE candidates exist, and a derived completion REQUIRES a
 *        planId; minting the shell up front is what makes those failures
 *        attributable through the ordinary path instead of needing a second,
 *        planless completion contract forever.
 *   3. provision → clone → bounded reads, each reported as a LADDER attempt
 *      (no candidateId)
 *   4. the deterministic ladder → localCandidates
 *   5. compute the evidence digest (this repo is the SOLE encoder)
 *   6. POST /plan/candidates → { candidates[], stopPolicy }
 *   7. execute the candidates IN THE PLAN'S ORDER, fresh box per candidate
 *   8. obey the typed ACTION returned by every /attempt
 *   9. on `run_eval`: launch the suite, then IMMEDIATELY post
 *      { phase:'eval', ok:true, runId } — that attempt is what BINDS the run
 *   9b. on `run_conformance` (opt-in dual-check): launch conformance against an
 *      independent MCP session, then IMMEDIATELY post
 *      { phase:'conformance', ok:true, conformanceRunId }
 *   10. POST /complete { triggerId, planId, runId, conformanceRunId? } — NO `outcome` field
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE RULES THAT ARE EASY TO SOFTEN AND MUST NOT BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. A 409 IS A HARD STOP, NEVER RETRIED. It means we violated the state
 *    machine — we cited a candidate out of order, reported a phase backwards,
 *    kept going after a stop, or asserted something untrue about this check.
 *    Retrying cannot make any of those true. The reason is surfaced in the
 *    check output and the run stops.
 * 2. DEGRADED MODE IS A CONTRACT. Backend unreachable after the claim ⇒ stop
 *    conservatively and report `backend_unreachable`, which the backend
 *    attributes as `infra_error`. Never a green, never a PR-blamed outcome, and
 *    NEVER a silent local fallback to our own candidate policy — behaviour must
 *    not differ invisibly between healthy and degraded runs.
 * 3. AN UNKNOWN ACTION IS THE SAME CASE. A response we cannot interpret is no
 *    more evidence about the pull request than no response at all, so it fails
 *    closed to `complete` + the degraded marker.
 */

import { logger } from "../../utils/logger.js";
import type { CheckRecipe } from "./recipes.js";
import type { OwnershipProof, RecipeRung } from "./resolver/index.js";
import {
  GITHUB_CHECKS_SERVICE_BASE,
  postServiceRoute,
  type PostServiceRoute,
} from "./service-route.js";

// ---------------------------------------------------------------------------
// The wire vocabulary, hand-mirrored from `convex/github/checkPlans.ts`
// ---------------------------------------------------------------------------

/**
 * Where in a check's life an attempt landed.
 *
 * `provision`, `clone` and `resolve` are also the LADDER phases — reportable
 * with no `candidateId` while the plan is still candidate-less. Which one a row
 * is is decided by whether it carries a `candidateId`, never by the phase name.
 */
export const ATTEMPT_PHASES = [
  "resolve",
  "provision",
  "clone",
  "build",
  "start",
  "probe",
  "verify",
  "eval",
  "conformance",
] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

/**
 * Everything an attempt may fail as.
 *
 * `evals_failed` IS NOT A MEMBER, and that is the point: it was removed from
 * the backend union entirely and sending it is a 400. "Evals failed" is a
 * statement about the PULL REQUEST, and those come only from the backend
 * reading the BOUND `testSuiteRun` — never from a worker assertion, which could
 * otherwise produce a red verdict from a candidate-less `resolve` attempt with
 * no run involved at all. A failed eval LAUNCH is `ok: false` with an
 * infrastructure kind.
 */
export const ATTEMPT_FAILURE_KINDS = [
  "recipe_invalid",
  "build_failed",
  "probe_failed",
  "listener_mismatch",
  "listener_unknown",
  "provision_failed",
  "clone_failed",
  // RETIRED, deliberately kept. Nothing sends this any more — the egress
  // lockdown it described is gone (see `sandbox.ts`). It stays because the
  // value is mirrored by hand in the backend's `checkAttempts.failureKind`
  // union and already exists on historical corpus rows; dropping it here is
  // safe (the backend still accepts it), dropping it THERE first would not be.
  // Retiring it on both sides is a follow-up, in backend-first order.
  "lockdown_failed",
  "sandbox_error",
  "lease_lost",
  "backend_unreachable",
  "budget_exhausted",
  "no_candidates",
] as const;
export type AttemptFailureKind = (typeof ATTEMPT_FAILURE_KINDS)[number];

/**
 * What the backend tells the worker to do next. A TYPED action, not
 * `continue: boolean` — that boolean meant both "this candidate was accepted,
 * stop searching" and "abort the check", and guessing wrong either runs an eval
 * against a server nobody verified or skips the eval the search existed for.
 */
export const ATTEMPT_ACTIONS = [
  "continue_phase",
  "try_next_candidate",
  "run_eval",
  "run_conformance",
  "complete",
] as const;
export type AttemptAction = (typeof ATTEMPT_ACTIONS)[number];

export function isAttemptAction(value: unknown): value is AttemptAction {
  return (
    typeof value === "string" &&
    (ATTEMPT_ACTIONS as readonly string[]).includes(value)
  );
}

/** One candidate the backend planned, in the order it must be executed. */
export type PlannedCandidate = {
  candidateId: string;
  recipe: CheckRecipe;
  rung: RecipeRung;
  evidence: string[];
  ownershipProof: OwnershipProof;
  /** `cache` | `detected` | `agentic` — the A4 seam. Display/telemetry only. */
  source?: string;
};

export type PlanStopPolicy = { maxCandidates: number; wallClockMs: number };

export type PlanCandidateInput = {
  recipe: CheckRecipe;
  rung: RecipeRung;
  evidence: string[];
  ownershipProof: OwnershipProof;
};

export type AttemptInput = {
  candidateId?: string;
  phase: AttemptPhase;
  ok: boolean;
  failureKind?: AttemptFailureKind;
  durationMs: number;
  detailsClamped?: string;
  /** REQUIRED when `phase === 'eval' && ok`, REFUSED anywhere else. */
  runId?: string;
  /** REQUIRED when `phase === 'conformance' && ok`, REFUSED anywhere else. */
  conformanceRunId?: string;
};

export type AttemptDecision = {
  action: AttemptAction;
  reason?: string;
  /**
   * The backend answered with an action this build does not know. The caller
   * must treat it as `complete` plus the degraded marker — see rule 3 above.
   */
  unknownAction?: boolean;
};

// ---------------------------------------------------------------------------
// Failures, kept APART because the correct response to each one differs
// ---------------------------------------------------------------------------

/**
 * The backend REFUSED (4xx). We violated the state machine or sent something
 * invalid; the reason names which. NEVER retried, and never fallen back from.
 */
export class PlanProtocolError extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
    readonly status: number
  ) {
    super(`${step} refused (${status}): ${reason}`);
    this.name = "PlanProtocolError";
  }
}

/**
 * The backend could not be REACHED (transport failure, 5xx, or the surface is
 * switched off / not deployed). The degraded-mode marker travels with it so the
 * completion can say WHERE the loop stopped.
 */
export class PlanUnreachableError extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
    /** The attempt this call was carrying, when it was carrying one. */
    readonly at?: { phase: AttemptPhase; candidateId?: string }
  ) {
    super(`${step} unreachable: ${detail}`);
    this.name = "PlanUnreachableError";
  }
}

/**
 * The backend said STOP, or a failure was reported and the plan is finished.
 *
 * Carries no outcome, deliberately: the worker's job from here is to post
 * `/complete` and let the backend derive one. `detailsMarkdown` is the
 * author-facing copy (the resolver's "add an mcpjam.yaml" block, a clamped
 * build log tail) — display only, with no verdict authority.
 */
export class CheckStoppedByPlan extends Error {
  constructor(
    readonly reason: string,
    readonly detailsMarkdown?: string,
    /** Preformatted markdown (our prose) vs clamped untrusted output. */
    readonly detailsPreformatted?: boolean
  ) {
    super(`check stopped: ${reason}`);
    this.name = "CheckStoppedByPlan";
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * The seam the orchestrator and the worker both speak to. An interface rather
 * than the class, so the unit tests drive the whole loop through a fake without
 * a Convex deployment — which is the only way the 409, degraded and
 * unknown-action paths are testable at all.
 */
export interface CheckPlanSession {
  readonly planId: string;
  candidates(input: {
    evidenceDigest: string;
    resolverVersion: string;
    localCandidates: PlanCandidateInput[];
  }): Promise<{ candidates: PlannedCandidate[]; stopPolicy: PlanStopPolicy }>;
  attempt(input: AttemptInput): Promise<AttemptDecision>;
  complete(input: {
    runId?: string;
    conformanceRunId?: string;
    summary?: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
    };
    detailsMarkdown?: string;
    /**
     * The DEGRADED marker only. Ordinary attempts go through `attempt()` as
     * they happen; an inline one here exists so a run that lost the backend
     * mid-flight can still say so on the first call that gets through.
     */
    terminalAttempt?: AttemptInput;
  }): Promise<void>;
}

/**
 * How many times a call may be REPLAYED after a transport failure.
 *
 * One, and only where the idempotency key makes it safe: `/attempt` persists
 * the original response against the key and replays it byte-for-byte, so a
 * retry can never observe a different action than the first call returned.
 * `/plan/begin` and `/plan/candidates` are idempotent by construction (same
 * trigger → same plan; same digest + resolver → the issued plan replayed).
 */
const TRANSPORT_RETRIES = 1;

export class HttpCheckPlanSession implements CheckPlanSession {
  /**
   * Monotone per-session counter behind every idempotency key.
   *
   * A caller-generated key, never a natural one: a natural key (plan +
   * candidate + phase) silently collapses two legitimately distinct attempts —
   * a retried phase and a genuine re-execution — and the ambiguity only ever
   * surfaces as corrupted corpus data. A fresh key per DISTINCT attempt, the
   * same key on a transport RETRY, is exactly the distinction the backend's
   * `requestFingerprint` check expects.
   */
  private attemptSeq = 0;

  constructor(
    private readonly triggerId: string,
    readonly planId: string,
    private readonly post: PostServiceRoute
  ) {}

  async candidates(input: {
    evidenceDigest: string;
    resolverVersion: string;
    localCandidates: PlanCandidateInput[];
  }): Promise<{ candidates: PlannedCandidate[]; stopPolicy: PlanStopPolicy }> {
    const body = await this.call(
      "plan/candidates",
      `${GITHUB_CHECKS_SERVICE_BASE}/plan/candidates`,
      {
        planId: this.planId,
        evidenceDigest: input.evidenceDigest,
        resolverVersion: input.resolverVersion,
        localCandidates: input.localCandidates,
      }
    );
    const candidates = Array.isArray(body?.candidates)
      ? (body.candidates as PlannedCandidate[])
      : [];
    const stopPolicy: PlanStopPolicy = {
      maxCandidates: Number(
        body?.stopPolicy?.maxCandidates ?? candidates.length
      ),
      wallClockMs: Number(body?.stopPolicy?.wallClockMs ?? 0),
    };
    return { candidates, stopPolicy };
  }

  async attempt(input: AttemptInput): Promise<AttemptDecision> {
    this.attemptSeq += 1;
    const idempotencyKey = `${this.planId}:${input.candidateId ?? "ladder"}:${
      input.phase
    }:${this.attemptSeq}`;
    const body = await this.call(
      "attempt",
      `${GITHUB_CHECKS_SERVICE_BASE}/attempt`,
      {
        triggerId: this.triggerId,
        planId: this.planId,
        ...(input.candidateId ? { candidateId: input.candidateId } : {}),
        phase: input.phase,
        ok: input.ok,
        ...(input.failureKind ? { failureKind: input.failureKind } : {}),
        durationMs: Math.max(0, Math.round(input.durationMs)),
        ...(input.detailsClamped
          ? { detailsClamped: input.detailsClamped }
          : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.conformanceRunId
          ? { conformanceRunId: input.conformanceRunId }
          : {}),
        idempotencyKey,
      },
      { phase: input.phase, candidateId: input.candidateId }
    );
    if (!isAttemptAction(body?.action)) {
      // FAIL CLOSED. An action we do not understand is a contract we do not
      // understand, and the only safe reading of that is a neutral stop.
      logger.warn(
        "[github-checks] unrecognized attempt action; failing closed",
        {
          planId: this.planId,
          phase: input.phase,
          action: String(body?.action),
        }
      );
      return {
        action: "complete",
        reason: "unknown_action",
        unknownAction: true,
      };
    }
    return {
      action: body.action,
      ...(typeof body?.reason === "string" ? { reason: body.reason } : {}),
    };
  }

  async complete(input: {
    runId?: string;
    conformanceRunId?: string;
    summary?: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
    };
    detailsMarkdown?: string;
    terminalAttempt?: AttemptInput;
  }): Promise<void> {
    const base: Record<string, unknown> = {
      triggerId: this.triggerId,
      planId: this.planId,
      // NO `outcome`. The backend derives it from the attempts it holds and the
      // run it is BOUND to; sending one would take the legacy explicit path and
      // put the verdict back in this process, which is the whole thing A3b
      // moved.
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.conformanceRunId
        ? { conformanceRunId: input.conformanceRunId }
        : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.detailsMarkdown
        ? { detailsMarkdown: input.detailsMarkdown }
        : {}),
    };

    if (!input.terminalAttempt) {
      await this.call(
        "complete",
        `${GITHUB_CHECKS_SERVICE_BASE}/complete`,
        base
      );
      return;
    }

    this.attemptSeq += 1;
    const attempt = input.terminalAttempt;
    const withMarker = {
      ...base,
      terminalAttempt: {
        ...(attempt.candidateId ? { candidateId: attempt.candidateId } : {}),
        phase: attempt.phase,
        ok: attempt.ok,
        ...(attempt.failureKind ? { failureKind: attempt.failureKind } : {}),
        durationMs: Math.max(0, Math.round(attempt.durationMs)),
        ...(attempt.detailsClamped
          ? { detailsClamped: attempt.detailsClamped }
          : {}),
        ...(attempt.runId ? { runId: attempt.runId } : {}),
        ...(attempt.conformanceRunId
          ? { conformanceRunId: attempt.conformanceRunId }
          : {}),
        idempotencyKey: `${this.planId}:${attempt.candidateId ?? "ladder"}:${
          attempt.phase
        }:degraded:${this.attemptSeq}`,
      },
    };
    try {
      await this.call(
        "complete",
        `${GITHUB_CHECKS_SERVICE_BASE}/complete`,
        withMarker
      );
    } catch (error) {
      if (!(error instanceof PlanProtocolError)) throw error;
      // THE MARKER IS BEST EFFORT; THE COMPLETION IS NOT.
      //
      // The marker rides inline, so the backend appends it as a real attempt —
      // and it can legitimately be refused: if the call this run lost was in
      // fact COMMITTED before the response went missing, a second row at the
      // same phase is `phase_out_of_order`. Refusing the whole completion over
      // that would leave a claimed check with no verdict at all until the
      // heartbeat sweep timed it out, which is a worse outcome than losing one
      // telemetry row. So the completion is retried once WITHOUT the marker;
      // the attempt log already ends where the run stopped, and the derivation
      // reads `infra_error` from it either way.
      logger.warn(
        "[github-checks] degraded marker refused; completing without it",
        { planId: this.planId, reason: error.reason }
      );
      await this.call(
        "complete",
        `${GITHUB_CHECKS_SERVICE_BASE}/complete`,
        base
      );
    }
  }

  /**
   * One service call, with the three failure classes separated at the boundary
   * so no caller has to re-derive them from a status code.
   */
  private async call(
    step: string,
    path: string,
    body: Record<string, unknown>,
    at?: { phase: AttemptPhase; candidateId?: string }
  ): Promise<any> {
    return callPlanRoute(this.post, step, path, body, at);
  }
}

/**
 * The retry-and-classify loop, in ONE place.
 *
 * `beginCheckPlan` needs it before a session exists and `HttpCheckPlanSession`
 * needs it after, and the two must agree — a future timeout or status-policy
 * edit has to land somewhere it cannot half-apply. One transport replay (safe
 * because every body carries an idempotency key, or is idempotent by
 * construction), then the three failure classes separated at the boundary so no
 * caller re-derives them from a status code.
 */
async function callPlanRoute(
  post: PostServiceRoute,
  step: string,
  path: string,
  body: Record<string, unknown>,
  at?: { phase: AttemptPhase; candidateId?: string }
): Promise<any> {
  let lastTransportError: unknown;
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt += 1) {
    let response;
    try {
      response = await post(path, body);
    } catch (error) {
      // A transport failure is the one thing worth replaying: the request may
      // never have arrived, and the idempotency key makes it safe if it did.
      lastTransportError = error;
      continue;
    }
    if (response.status === 200 && response.body?.ok) return response.body;
    if (response.status >= 400 && response.status < 500) {
      if (response.status === 404) {
        // The surface is switched off backend-side, or not deployed yet.
        // That is unreachability, not a state-machine violation.
        throw new PlanUnreachableError(step, "route not found (404)", at);
      }
      // 409 (state machine) and 400 (invalid request) are both OURS to fix
      // and neither is retryable — retrying cannot make a rejected assertion
      // true, and a local fallback would be exactly the invisible behaviour
      // change degraded mode forbids.
      throw new PlanProtocolError(
        step,
        String(response.body?.error ?? "unknown"),
        response.status
      );
    }
    throw new PlanUnreachableError(
      step,
      `status ${response.status}: ${JSON.stringify(response.body ?? null).slice(
        0,
        200
      )}`,
      at
    );
  }
  throw new PlanUnreachableError(
    step,
    lastTransportError instanceof Error
      ? lastTransportError.message.slice(0, 200)
      : String(lastTransportError),
    at
  );
}

/**
 * Mint the plan SHELL. Called before any sandbox work, so every failure from
 * that point on has a plan to be attributed against.
 */
export async function beginCheckPlan(
  args: { triggerId: string; repoFullName: string; headSha: string },
  post: PostServiceRoute = postServiceRoute
): Promise<CheckPlanSession> {
  // The replay this shares with every other call is idempotent by construction
  // here: the same trigger always gets the same planId back, so it can never
  // mint a second plan whose candidate ids mean something different from the
  // ones in-flight attempts cite.
  const body = await callPlanRoute(
    post,
    "plan/begin",
    `${GITHUB_CHECKS_SERVICE_BASE}/plan/begin`,
    {
      triggerId: args.triggerId,
      repoFullName: args.repoFullName,
      headSha: args.headSha,
    }
  );
  const planId = String(body?.planId ?? "");
  if (!planId) {
    throw new PlanUnreachableError("plan/begin", "no planId in the response");
  }
  return new HttpCheckPlanSession(args.triggerId, planId, post);
}
