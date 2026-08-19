/**
 * `resolveAndStart` — the boxes, the deterministic ladder, and the runtime
 * identity check, driven by the BACKEND'S plan.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE STOPPED DOING (A3b-2), AND WHY THAT IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It used to own the attribution model: which candidate to try, in what order,
 * whether a failure was a resolver MISS or the author's `build_failed`, and
 * what the whole thing added up to. All of that now lives in
 * `convex/github/checkPlans.ts`, because the DATA FLYWHEEL is the moat and the
 * sandbox execution is not — and because "a candidate's build failure is a miss,
 * not a red X" should be a backend edit rather than an Inspector deploy.
 *
 * So this module reports FACTS and obeys ACTIONS:
 *
 *   - every phase boundary is a `/attempt` with a `failureKind` when it failed;
 *   - the returned action (`continue_phase` | `try_next_candidate` | `run_eval`
 *     | `complete`) is honoured verbatim, and an action we do not recognize is
 *     treated as `complete` (fail closed — see `check-plan.ts`);
 *   - nothing here computes an outcome, and there is no local fall-back
 *     ordering. A backend we cannot reach means we STOP, never that we quietly
 *     revert to our own policy.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DELIBERATELY KEPT — all of it in the open
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A FRESH SANDBOX PER CANDIDATE. Candidate B never runs in candidate A's box,
 * and A's box is KILLED BEFORE B's is provisioned (not merely before B's build):
 *
 *   1. EGRESS KEEPS THE PLATFORM BASELINE. The box is provisioned with public
 *      internet and the backend's non-guest RFC1918 denylist. `buildAndStart`
 *      never changes that policy, so B's build and server see the same network
 *      behavior as A's.
 *   2. A's PROCESSES ARE STILL ALIVE. A's server may hold the port, and it is
 *      A's code — so B's probe would be answered by A, which is the exact
 *      wrong-process-answering-the-probe class the runtime check below exists
 *      to close, reintroduced by our own reuse.
 *
 * THE RUNTIME LISTENER-IDENTITY CHECK. It runs AFTER the probe answers and
 * BEFORE the server is accepted, and it asks what static analysis provably
 * cannot: is the process bound to the probed port the start command WE spawned,
 * or a descendant of it? That closes the install-hook class — `"prepare":
 * "nohup acme-server &"` and its endless spellings — where a detached published
 * server squats the port and answers our probe while the validated start
 * command never binds.
 *
 * IDENTITY COMES FROM THE SPAWN, NOT FROM THE BOX. `buildAndStart` returns a
 * `SpawnIdentity` — the pid E2B reports for the command it started for us, plus
 * the process group read from `/proc/<pid>/stat` at that instant. Everything in
 * the box after the build is PR code, so an identity fact the box WRITES is one
 * the PR chooses: an earlier revision had the start wrapper write its pid to
 * `/tmp/mcp-server.pid` and read it back, and a squatter could overwrite that
 * file and be recognised as ours. The box is only ever asked for kernel facts.
 *
 * WHY THERE IS NO RUNTIME "OWNERSHIP" CHECK. An earlier revision resolved the
 * listening process's MAIN MODULE from `/proc/<pid>/cmdline`, `realpath`d it and
 * required it inside the checkout and outside `node_modules`. Removed: `tsx
 * src/index.ts` runs as `node .../node_modules/tsx/dist/cli.mjs src/index.ts`
 * and `uv run python -m server` has no file-valued argument at all, so it
 * rejected ordinary servers; a path-valued option accepted things that are not
 * code; and it never caught the motivating case anyway (a build that COPIES a
 * dependency into the tree produces a main module inside the checkout). What
 * covers what now: STATIC entry validation in `detect.ts` rule C, and the
 * RUNTIME listener identity here. `ownershipProof: 'unverified'` records the
 * residual honestly instead of pretending it is settled.
 */

import { logger } from "../../utils/logger.js";
import {
  buildAndStart,
  CheckStepError,
  cloneAndCheckout,
  killCheckSandbox,
  provisionCheckSandbox,
  redactCloneCredential,
  type CheckSandbox,
  type SpawnIdentity,
  type StartedServer,
} from "./sandbox.js";
import {
  inspectListener,
  readResolverInputs,
  type ListenerProcess,
  type ListenerReport,
} from "./sandbox-inspect.js";
import {
  RecipeResolutionError,
  resolveRecipeLadder,
  RESOLVER_VERSION,
  type ResolvedRecipe,
} from "./resolver/index.js";
import { computeResolverEvidenceDigest } from "./evidence-digest.js";
import {
  CheckStoppedByPlan,
  type AttemptDecision,
  type AttemptFailureKind,
  type AttemptPhase,
  type CheckPlanSession,
  type PlannedCandidate,
} from "./check-plan.js";

/** Provenance for logs and telemetry. The VERDICT's provenance is the plan's. */
export type RecipeProvenance = {
  recipeRung: ResolvedRecipe["rung"];
  /** Constant strings + operator-controlled names; never PR file content. */
  recipeEvidence: string[];
};

export type ResolveAndStartResult = {
  /** The live box. Every other box this call created is already dead. */
  sandbox: CheckSandbox;
  /** The candidate that built and served, as the PLAN issued it. */
  recipe: ResolvedRecipe;
  /** The plan's id for it — the eval attempt must cite this one. */
  candidateId: string;
  /** Running and verified — NOT restarted after verification. */
  started: StartedServer;
  provenance: RecipeProvenance;
};

/**
 * Injectable collaborators. Every external effect is one of these, so the tests
 * drive real control flow — including the fresh-box policy, the plan's ordering
 * and the `finally` teardown — without E2B or a Convex deployment.
 */
export type ResolveAndStartDeps = {
  provisionSandbox: typeof provisionCheckSandbox;
  cloneAndCheckout: typeof cloneAndCheckout;
  buildAndStart: typeof buildAndStart;
  killSandbox: typeof killCheckSandbox;
  resolveLadder: typeof resolveRecipeLadder;
  readResolverInputs: typeof readResolverInputs;
  inspectListener: typeof inspectListener;
  computeEvidenceDigest: typeof computeResolverEvidenceDigest;
  /** The backend-owned plan loop. REQUIRED — there is no planless mode. */
  plan: CheckPlanSession;
  /**
   * Called with the box this call currently owns, and with `null` once it is
   * dead. The worker mirrors it into the variable its own `finally` kills, so a
   * box can never be orphaned by an unexpected throw between the two modules.
   */
  onSandbox: (sandbox: CheckSandbox | null) => void;
  /** Throws `LeaseLostError` when the claim stopped being ours. */
  assertLeaseHeld: () => void;
  now: () => number;
  resolverVersion: string;
};

function defaultDeps(): Omit<ResolveAndStartDeps, "plan"> {
  return {
    provisionSandbox: provisionCheckSandbox,
    cloneAndCheckout,
    buildAndStart,
    killSandbox: killCheckSandbox,
    resolveLadder: resolveRecipeLadder,
    readResolverInputs,
    inspectListener,
    computeEvidenceDigest: computeResolverEvidenceDigest,
    onSandbox: () => {},
    assertLeaseHeld: () => {},
    now: () => Date.now(),
    resolverVersion: RESOLVER_VERSION,
  };
}

export type ResolveAndStartArgs = {
  triggerId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  /**
   * The clone credential for a PRIVATE repository, minted by the worker between
   * `/plan/begin` and the first provision. Absent for a public one, which is
   * cloned anonymously exactly as before.
   *
   * It lives on the ARGS and not on the recipe or the plan types on purpose:
   * every candidate re-clones into a fresh box, so this is a property of the
   * CHECKOUT, and widening a recipe or a plan candidate to carry a secret would
   * put it on types that are logged, digested and sent to the backend.
   */
  cloneToken?: string;
};

function provenanceOf(recipe: ResolvedRecipe): RecipeProvenance {
  return { recipeRung: recipe.rung, recipeEvidence: [...recipe.evidence] };
}

/**
 * A `CheckStepError` from the sandbox, as the phase and failure kind it should
 * be REPORTED at.
 *
 * `buildAndStart` is one call covering build → start → probe, so the
 * phase is inferred from the outcome the sandbox module already decided:
 * `build_failed` happened at the build, `server_unhealthy` means it built and
 * started and then never answered `initialize`, and anything else is our
 * infrastructure. Note that the OUTCOME the sandbox names is used only to pick
 * the phase and kind here — what it MEANS (the author's build vs a resolver
 * miss) is the backend's call now, and depends on the candidate's rung, which
 * this module deliberately no longer reasons about.
 */
function reportableStepFailure(error: CheckStepError): {
  phase: AttemptPhase;
  failureKind: AttemptFailureKind;
} {
  if (error.outcome === "build_failed") {
    return { phase: "build", failureKind: "build_failed" };
  }
  if (error.outcome === "server_unhealthy") {
    return { phase: "probe", failureKind: "probe_failed" };
  }
  // `sandbox_error` is the honest coarse kind for everything else
  // `buildAndStart` can fail with: guessing which of its infrastructure
  // failures we hit from an error string would file a wrong row in the corpus,
  // and they all attribute to `infra_error` anyway.
  return { phase: "build", failureKind: "sandbox_error" };
}

/**
 * Resolve a recipe for this PR and leave its server running and verified.
 *
 * On EVERY failure path, every sandbox this function created is killed before it
 * throws — including the one an attempt was using. On success exactly one box is
 * alive, and it is the one in the result.
 *
 * Throws `CheckStoppedByPlan` when the backend said stop (or a reported failure
 * ended the plan), and `PlanProtocolError` / `PlanUnreachableError` straight
 * through — the worker owns what each of those means for the completion.
 */
export async function resolveAndStart(
  args: ResolveAndStartArgs,
  overrides: Partial<ResolveAndStartDeps> & { plan: CheckPlanSession }
): Promise<ResolveAndStartResult> {
  const deps: ResolveAndStartDeps = { ...defaultDeps(), ...overrides };
  const plan = deps.plan;
  const logContext = {
    triggerId: args.triggerId,
    repo: args.repoFullName,
    pr: args.prNumber,
    planId: plan.planId,
  };

  let sandbox: CheckSandbox | null = null;

  /** Kill the box we hold, and tell the caller it is gone. */
  const releaseSandbox = async (): Promise<void> => {
    if (!sandbox) return;
    const dying = sandbox;
    // Cleared FIRST: if `killSandbox` throws (it does not — it is best effort —
    // but the dep is injectable), the caller must not be handed a box we
    // already gave up on.
    sandbox = null;
    deps.onSandbox(null);
    await deps.killSandbox(dying);
  };

  /**
   * A decision that is only ever allowed to be "carry on".
   *
   * Applied to the phases where nothing else can be legitimate (a successful
   * provision, clone or resolve). Anything else is honoured as a STOP rather
   * than second-guessed — obeying an unexpected instruction conservatively is
   * the fail-closed direction.
   */
  const mustContinue = (decision: AttemptDecision): void => {
    if (decision.action === "continue_phase") return;
    throw new CheckStoppedByPlan(decision.reason ?? decision.action);
  };

  /** A clean box with the PR checked out in it, both phases reported. */
  const freshSandbox = async (candidateId?: string): Promise<CheckSandbox> => {
    await releaseSandbox();
    const provisionStartedAt = deps.now();
    let box: CheckSandbox;
    try {
      box = await deps.provisionSandbox({
        triggerId: args.triggerId,
        repoFullName: args.repoFullName,
        prNumber: args.prNumber,
      });
    } catch (error) {
      await plan.attempt({
        ...(candidateId ? { candidateId } : {}),
        phase: "provision",
        ok: false,
        failureKind: "provision_failed",
        durationMs: deps.now() - provisionStartedAt,
        detailsClamped: errorDetail(error),
      });
      throw new CheckStoppedByPlan("provision_failed");
    }
    sandbox = box;
    deps.onSandbox(box);
    deps.assertLeaseHeld();
    mustContinue(
      await plan.attempt({
        ...(candidateId ? { candidateId } : {}),
        phase: "provision",
        ok: true,
        durationMs: deps.now() - provisionStartedAt,
      })
    );

    const cloneStartedAt = deps.now();
    try {
      await deps.cloneAndCheckout(box, {
        repoFullName: args.repoFullName,
        prNumber: args.prNumber,
        headSha: args.headSha,
        ...(args.cloneToken ? { cloneToken: args.cloneToken } : {}),
      });
    } catch (error) {
      await plan.attempt({
        ...(candidateId ? { candidateId } : {}),
        phase: "clone",
        ok: false,
        failureKind: "clone_failed",
        durationMs: deps.now() - cloneStartedAt,
        // The one attempt detail that can carry a credential. `sandbox.ts`
        // already redacts at the boundary it owns; this is the second, at the
        // boundary where the text leaves the process for the corpus, because a
        // detail that reaches the backend is a detail nobody can un-store.
        detailsClamped: redactedErrorDetail(error, args.cloneToken),
      });
      throw new CheckStoppedByPlan("clone_failed");
    }
    deps.assertLeaseHeld();
    mustContinue(
      await plan.attempt({
        ...(candidateId ? { candidateId } : {}),
        phase: "clone",
        ok: true,
        durationMs: deps.now() - cloneStartedAt,
      })
    );
    return box;
  };

  try {
    // Box #1 is provisioned before anything is known about the repo, because
    // reading the repo REQUIRES a checkout. Its provision and clone are LADDER
    // attempts (no candidateId) — the plan has no candidates yet, and that is
    // precisely the window `/plan/begin` exists to make attributable.
    let box = await freshSandbox();

    const resolveStartedAt = deps.now();
    const inputs = await deps.readResolverInputs(box);
    deps.assertLeaseHeld();

    let localCandidates: ResolvedRecipe[];
    try {
      const resolution = deps.resolveLadder({
        repoFullName: args.repoFullName,
        // The reader's three-way answer, handed over WHOLE. Collapsing
        // `over_cap` into `null` here is the bug this shape exists to prevent:
        // an oversized declared config is INVALID, and `null` means absent,
        // which is the one thing an authoritative rung must never fall through
        // on.
        mcpjamYaml:
          inputs.mcpjamYaml.kind === "present" ? inputs.mcpjamYaml.text : null,
        mcpjamYamlOverCap: inputs.mcpjamYaml.kind === "over_cap",
        detection: inputs.detection,
      });
      localCandidates =
        resolution.kind === "authoritative"
          ? [resolution.recipe]
          : resolution.candidates;
    } catch (error) {
      throw await reportLadderFailure(
        plan,
        error,
        args.repoFullName,
        deps.now() - resolveStartedAt
      );
    }

    mustContinue(
      await plan.attempt({
        phase: "resolve",
        ok: true,
        durationMs: deps.now() - resolveStartedAt,
      })
    );

    // THE INSPECTOR IS THE SOLE ENCODER of this digest — the backend stores and
    // compares it and never recomputes it. See `evidence-digest.ts`.
    const evidenceDigest = deps.computeEvidenceDigest(
      inputs,
      deps.resolverVersion
    );

    const issued = await plan.candidates({
      evidenceDigest,
      resolverVersion: deps.resolverVersion,
      // Reported as facts, in OUR order. Which of them run, in what order, and
      // whether the backend adds one of its own, is the backend's call.
      localCandidates: localCandidates.map((candidate) => ({
        recipe: {
          build: candidate.build,
          start: candidate.start,
          port: candidate.port,
          mcpPath: candidate.mcpPath,
          // Only a DECLARED (or operator-override) recipe carries one, and only
          // when it is non-empty. The key is omitted rather than sent as
          // `undefined` or `{}`: the backend refuses `env` on a cacheable rung,
          // so an empty map riding along on a detected candidate would be a 400
          // on a candidate that was otherwise fine.
          ...envField(candidate.env),
        },
        rung: candidate.rung,
        evidence: candidate.evidence,
        ownershipProof: candidate.ownershipProof,
      })),
    });

    if (issued.candidates.length === 0) {
      // We handed over candidates (or the ladder would have thrown) and got a
      // plan with nothing in it. Nothing to execute and nothing to report as a
      // failure of the repository's — stop, and let the derivation call an
      // empty search what it is.
      throw new CheckStoppedByPlan("plan_has_no_candidates");
    }

    logger.info("[github-checks] executing the plan", {
      ...logContext,
      candidates: issued.candidates.length,
      maxCandidates: issued.stopPolicy.maxCandidates,
    });

    // `maxCandidates` needs no local enforcement — the backend bounds the search
    // by issuing fewer candidates and by returning `complete` once the cap is
    // spent. `wallClockMs` has no such second enforcement point: while the
    // backend keeps answering `try_next_candidate`, each candidate spends a full
    // build-and-probe cycle, and the lease heartbeat keeps succeeding
    // throughout, so it is not a backstop either. Checked here, at a boundary
    // where stopping is clean, against the deadline the backend itself sent.
    // `0` means "no deadline issued", not "already expired".
    const deadlineAt =
      issued.stopPolicy.wallClockMs > 0
        ? deps.now() + issued.stopPolicy.wallClockMs
        : null;
    const assertWithinDeadline = () => {
      if (deadlineAt !== null && deps.now() >= deadlineAt) {
        throw new CheckStoppedByPlan("plan_wall_clock_exhausted");
      }
    };

    for (let index = 0; index < issued.candidates.length; index += 1) {
      const planned = issued.candidates[index];
      const recipe = recipeOf(planned);
      assertWithinDeadline();
      if (index > 0) {
        // The previous candidate's box dies HERE, before the next is
        // provisioned — see the module docblock on why B must never meet A.
        box = await freshSandbox(planned.candidateId);
        // Provisioning and cloning are themselves minutes of budget, so the
        // deadline is re-read AFTER them: a candidate that was inside it when
        // the iteration began can be outside it by the time there is a box to
        // build in, and the build is the expensive half.
        assertWithinDeadline();
      }
      deps.assertLeaseHeld();
      logger.info("[github-checks] trying a planned candidate", {
        ...logContext,
        candidate: planned.candidateId,
        position: index + 1,
        of: issued.candidates.length,
        rung: planned.rung,
        source: planned.source,
        ownershipProof: planned.ownershipProof,
      });

      const buildStartedAt = deps.now();
      let started: StartedServer;
      try {
        started = await deps.buildAndStart(box, recipe);
      } catch (error) {
        if (!(error instanceof CheckStepError)) throw error;
        const { phase, failureKind } = reportableStepFailure(error);
        const decision = await plan.attempt({
          candidateId: planned.candidateId,
          phase,
          ok: false,
          failureKind,
          durationMs: deps.now() - buildStartedAt,
          detailsClamped: error.detailsMarkdown ?? error.message,
        });
        if (decision.action === "try_next_candidate") continue;
        throw new CheckStoppedByPlan(
          decision.reason ?? failureKind,
          error.detailsMarkdown
        );
      }

      // ONE ok row for the whole build→start→probe call, at `probe`.
      //
      // `buildAndStart` does not surface the three boundaries separately, and
      // splitting the elapsed time across invented rows would put numbers in
      // the corpus that were never measured. A failure still lands at its REAL
      // phase (above), which is the direction the corpus is read in — "what
      // failed, for which repo, at which phase".
      mustContinue(
        await plan.attempt({
          candidateId: planned.candidateId,
          phase: "probe",
          ok: true,
          durationMs: deps.now() - buildStartedAt,
        })
      );

      deps.assertLeaseHeld();
      const verifyStartedAt = deps.now();
      const verdict = await verifyRunningServer(
        box,
        recipe,
        started.spawn,
        deps
      );
      if (verdict.status !== "ok") {
        // `listener_mismatch` — something answered and it was not ours — and
        // `listener_unknown` — we could not LOOK — are kept apart on the wire
        // because they mean opposite things: the first is evidence about this
        // candidate, the second is evidence about US, and the backend aborts on
        // it rather than burning the remaining candidates on an outage.
        const failureKind: AttemptFailureKind =
          verdict.status === "mismatch"
            ? "listener_mismatch"
            : "listener_unknown";
        const decision = await plan.attempt({
          candidateId: planned.candidateId,
          phase: "verify",
          ok: false,
          failureKind,
          durationMs: deps.now() - verifyStartedAt,
          detailsClamped: verdict.reason,
        });
        if (decision.action === "try_next_candidate") continue;
        throw new CheckStoppedByPlan(
          decision.reason ?? failureKind,
          squatterDetails(recipe, verdict.reason),
          true
        );
      }

      const decision = await plan.attempt({
        candidateId: planned.candidateId,
        phase: "verify",
        ok: true,
        durationMs: deps.now() - verifyStartedAt,
      });
      // `run_eval` is the ONLY action that may follow an accepted candidate.
      // Anything else — including an action this build does not know — stops.
      if (decision.action !== "run_eval") {
        throw new CheckStoppedByPlan(decision.reason ?? decision.action);
      }
      return {
        sandbox: box,
        recipe,
        candidateId: planned.candidateId,
        started,
        provenance: provenanceOf(recipe),
      };
    }

    // Every planned candidate failed and the backend never said `complete`.
    // Unreachable through the documented state machine (the last miss returns
    // `complete` once the cap is spent), and asserted rather than assumed:
    // silently returning nothing would be a check with no server and no stop.
    throw new CheckStoppedByPlan("plan_exhausted_without_stop");
  } catch (error) {
    // Every box this call created is dead before the error leaves — including
    // the one an attempt was mid-way through.
    await releaseSandbox().catch(() => {});
    throw error;
  }
}

/**
 * `{ env }` when there is an environment, and NOTHING otherwise.
 *
 * ONE rule for both directions this module carries an environment across — the
 * candidates we report to the plan, and the candidate the plan hands back. They
 * had the rule written out twice and it drifted immediately: `{}` is truthy, so
 * "copy it when it is there" quietly admits the empty map that "copy it when
 * there is something in it" rejects.
 *
 * The distinction is not cosmetic on the outbound side. An empty map is still a
 * VALUE, and the backend refuses `env` on a cacheable rung — so an empty one
 * riding along on a detected candidate is a 400 on a candidate that was
 * otherwise fine. Inbound it is a shape the rest of the pipeline should never
 * have to recognise as a second spelling of absence.
 */
function envField(env: Record<string, string> | undefined): {
  env?: Record<string, string>;
} {
  return env && Object.keys(env).length > 0 ? { env } : {};
}

function recipeOf(planned: PlannedCandidate): ResolvedRecipe {
  return {
    build: planned.recipe.build,
    start: planned.recipe.start,
    port: planned.recipe.port,
    mcpPath: planned.recipe.mcpPath,
    // The PLAN's environment, not the one we proposed — the backend owns the
    // plan, and a candidate it issued must execute exactly as issued. Through
    // `envField` so an env-free plan candidate stays env-free rather than
    // acquiring a key later code would have to know to ignore.
    ...envField(planned.recipe.env),
    rung: planned.rung,
    ownershipProof: planned.ownershipProof,
    evidence: planned.evidence ?? [],
  };
}

/**
 * `errorDetail`, with any clone credential removed BEFORE the 500-character
 * bound is applied.
 *
 * The ordering is the same one `sandbox.ts` makes for `errorMessage`, for the
 * same reason: a slice that lands mid-token leaves half a token in the corpus,
 * and a halved token no longer matches the literal the replacement is looking
 * for. So this redacts the UNCLAMPED text and clamps last — which is why it
 * cannot simply wrap `errorDetail`.
 *
 * Separate from `errorDetail` rather than folded into it so the redaction is
 * visible at the call site that needs it: the clone is the only phase whose
 * failure text can have touched a secret.
 */
function redactedErrorDetail(
  error: unknown,
  cloneToken?: string
): string | undefined {
  // Mirrors `errorDetail`'s branches and its BOUNDS exactly — `detailsMarkdown`
  // arrives already clamped and fenced from `sandbox.ts` and is not re-bounded,
  // while a bare message is. What differs is only the ORDER: redact, then clamp.
  if (error instanceof CheckStepError && error.detailsMarkdown !== undefined) {
    return (
      redactCloneCredential(error.detailsMarkdown, cloneToken) || undefined
    );
  }
  if (error instanceof Error) {
    return (
      redactCloneCredential(error.message, cloneToken).slice(0, 500) ||
      undefined
    );
  }
  return undefined;
}

function errorDetail(error: unknown): string | undefined {
  if (error instanceof CheckStepError) {
    return error.detailsMarkdown ?? error.message.slice(0, 500);
  }
  if (error instanceof Error) return error.message.slice(0, 500);
  return undefined;
}

/**
 * Report a ladder refusal at the `resolve` phase and stop.
 *
 * The two kinds are the compatibility matrix's two `resolve`-only, LADDER-scoped
 * members, and the distinction is the whole reason the ladder exists:
 *
 *   `recipe_invalid`  — a DECLARED config is present and broken. The author's to
 *                       fix; the backend concludes a check FAILURE. Falling
 *                       through to a guess would run something they never
 *                       declared and report the result under their name.
 *   `no_candidates`   — nobody declared anything and nothing was detectable.
 *                       Neutral (`recipe_unresolvable`), pointing at the
 *                       one-file fix.
 *
 * The author-facing copy travels on the thrown stop, not on the attempt: it is
 * display data, and the backend's `detailsClamped` is bounded telemetry.
 */
async function reportLadderFailure(
  plan: CheckPlanSession,
  error: unknown,
  repoFullName: string,
  durationMs: number
): Promise<CheckStoppedByPlan> {
  if (!(error instanceof RecipeResolutionError)) {
    // The ladder is pure and deterministic; anything else thrown by it is ours.
    await plan.attempt({
      phase: "resolve",
      ok: false,
      failureKind: "sandbox_error",
      durationMs,
      detailsClamped: errorDetail(error),
    });
    return new CheckStoppedByPlan(
      error instanceof Error ? error.message.slice(0, 200) : String(error)
    );
  }
  if (error.reason === "no_recipe") {
    await plan.attempt({
      phase: "resolve",
      ok: false,
      failureKind: "no_candidates",
      durationMs,
      detailsClamped: error.message.slice(0, 500),
    });
    return new CheckStoppedByPlan(
      "no_candidates",
      unresolvableDetails(repoFullName, error.detailsMarkdown),
      true
    );
  }
  await plan.attempt({
    phase: "resolve",
    ok: false,
    failureKind: "recipe_invalid",
    durationMs,
    detailsClamped: error.message.slice(0, 500),
  });
  return new CheckStoppedByPlan(
    "recipe_invalid",
    [
      "The configuration this repository declares for MCPJam checks is present but not usable, so the check ran nothing rather than guessing at what you meant.",
      ...(error.detailsMarkdown ? ["", error.detailsMarkdown] : []),
    ].join("\n"),
    true
  );
}

/** The neutral end of the ladder, with the one-file fix spelled out. */
function unresolvableDetails(
  repoFullName: string,
  detailsBlock?: string
): string {
  return [
    "MCPJam could not work out how to build and start this repository's MCP server, so nothing was tested. This is not a failure of your pull request.",
    "",
    "Declare it once and this becomes exact — add `mcpjam.yaml` at the repository root:",
    "",
    "```yaml",
    "version: 1",
    "checks:",
    "  build: npm ci && npm run build",
    "  start: npm start",
    "  port: 3001",
    "  path: /mcp",
    "```",
    ...(detailsBlock ? ["", detailsBlock] : []),
  ].join("\n");
}

function squatterDetails(recipe: ResolvedRecipe, reason: string): string {
  return [
    `Something answered the MCP probe on port ${recipe.port}${recipe.mcpPath}, but it is not the server the \`start\` command produced: ${reason}.`,
    "",
    "A detached process left behind by an install or build lifecycle hook is the usual cause; the check refuses to report on it, because a verdict about it would say nothing about this pull request.",
  ].join("\n");
}

type VerificationVerdict =
  | { status: "ok" }
  /** Definite: something is listening, and it is not ours. */
  | { status: "mismatch"; reason: string }
  /** We could not tell. Infrastructure, never a pass and never a miss. */
  | { status: "unknown"; reason: string };

/**
 * The runtime identity check, against the process that actually holds the port.
 *
 * `spawn` is passed IN rather than looked up: it was captured when we started
 * the command (see `SpawnIdentity`), which is the only moment at which the
 * answer is ours and not the box's.
 */
export async function verifyRunningServer(
  sandbox: CheckSandbox,
  recipe: ResolvedRecipe,
  spawn: SpawnIdentity,
  deps: Pick<ResolveAndStartDeps, "inspectListener">
): Promise<VerificationVerdict> {
  const report = await deps.inspectListener(sandbox, { port: recipe.port });
  if (!report) {
    return {
      status: "unknown",
      reason: "the sandbox did not answer the process inspection",
    };
  }
  return judgeListeners(report, spawn);
}

/**
 * Pure half of the verification, so the interesting cases are testable without a
 * box.
 *
 * EVERY listener on the port has to pass, not merely one of them. With
 * `SO_REUSEPORT` a squatter and our server can both be bound, and the probe is
 * answered by whichever the kernel picks — so "one of them is ours" is not a
 * property the eval run can rely on.
 */
export function judgeListeners(
  report: ListenerReport,
  spawn: SpawnIdentity
): VerificationVerdict {
  if (report.processes.length === 0) {
    // The probe was answered, so SOMETHING is bound. Finding nothing means the
    // inspection could not attribute it (an unreadable `/proc/<pid>/fd`, a
    // process owned by another user), which is not evidence of innocence.
    return {
      status: "unknown",
      reason: "no process could be attributed to the listening socket",
    };
  }
  for (const process of report.processes) {
    if (!isOurs(process, spawn)) {
      return {
        status: "mismatch",
        reason: `the process listening on the port (pid ${process.pid}) is not the start command this check spawned, nor a descendant of it`,
      };
    }
  }
  return { status: "ok" };
}

/**
 * Is this listener the start command we spawned, or something it started?
 *
 * ANCESTRY is the primary test and the strong one. The PROCESS GROUP is accepted
 * as well, for one specific legitimate shape: a server that double-forks (or
 * whose supervisor exits) is reparented to init and loses the ancestry link,
 * while keeping the process group it was born into. A process that called
 * `setsid` itself escapes both, and is rejected: at that point nothing
 * distinguishes it from a squatter, and a miss is recoverable while a false
 * green is not.
 *
 * WHAT MAKES THE GROUP MEAN ANYTHING is that our spawn CREATED it — see
 * `SpawnIdentity`, which is null unless the spawned process leads its own group.
 * "It shares our group" was NOT a safe test until then: E2B's envd runs every
 * command it is given in envd's own process group, so on the live checks image
 * the build, the clone and the start command all sit in one group, and a
 * squatter detached by a build lifecycle hook matched the server we started.
 * That was observed against a real sandbox, not reasoned about — see
 * scripts/verify-listener-identity.ts.
 */
function isOurs(process: ListenerProcess, spawn: SpawnIdentity): boolean {
  if (process.pid === spawn.pid) return true;
  if (process.ppids.includes(spawn.pid)) return true;
  return (
    spawn.pgrp !== null && process.pgrp !== null && process.pgrp === spawn.pgrp
  );
}
