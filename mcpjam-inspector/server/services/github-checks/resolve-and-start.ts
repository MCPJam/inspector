/**
 * `resolveAndStart` — the ladder, the sandboxes, and the runtime identity check.
 *
 * This is the piece the worker used to do with a hardcoded table lookup: turn a
 * PR checkout into a RUNNING, VERIFIED MCP server, or fail in a way somebody can
 * act on. Everything here is about the second half of that sentence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ATTRIBUTION MODEL (this is the point of the whole module)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AUTHORITATIVE rungs — an operator override, or the author's `mcpjam.yaml`.
 * Somebody wrote this configuration down deliberately, so:
 *
 *   - a present-but-BROKEN config is the author's bug, not a reason to guess:
 *     `recipe_invalid`, a check FAILURE. Falling through to a heuristic would
 *     run something they never declared and then report the result under their
 *     name;
 *   - a VALID authoritative recipe whose build breaks is `build_failed`, and one
 *     whose server never speaks MCP is `server_unhealthy` — exactly as before
 *     the ladder existed. No fall-through, no second chance: there is nothing to
 *     fall through TO that would not be a lie about what was tested.
 *
 * HEURISTIC candidates (rung `detected`) — our guesses, tried best-first:
 *
 *   - a candidate whose build or probe fails is a RESOLVER MISS. It is discarded
 *     and the next candidate is tried. Reporting `build_failed` for a command we
 *     invented would put a red X on a PR for failing to run a build it never
 *     asked for;
 *   - PROVISION / LOCKDOWN / E2B failures are `infra_error` and ABORT the whole
 *     check immediately. Consuming an outage as a miss would spend three
 *     sandboxes discovering that E2B is down and then conclude a neutral
 *     `recipe_unresolvable` — a wrong answer at triple cost;
 *   - candidates exhausted (or the budget spent) ⇒ neutral `recipe_unresolvable`
 *     with copy pointing at `mcpjam.yaml`, which is the one-file fix.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A FRESH SANDBOX PER CANDIDATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Candidate B never runs in candidate A's box. Two reasons, both of which would
 * silently corrupt the verdict rather than merely waste resources:
 *
 *   1. EGRESS IS ALREADY REVOKED. `buildAndStart` locks the box down between
 *      build and start, on purpose. B's build would then run with no network at
 *      all and fail for a reason that has nothing to do with B.
 *   2. A's PROCESSES ARE STILL ALIVE. A's server may hold the port, and it is
 *      A's code. B's probe would then be answered by A — the exact
 *      wrong-process-answering-the-probe class this module's runtime checks
 *      exist to close, reintroduced by our own reuse.
 *
 * So each attempt gets a clean box, and the previous box is KILLED BEFORE the
 * next one is provisioned (not merely before the next build): a leaked box costs
 * money for the full 45-minute TTL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RUNTIME CHECK: LISTENER IDENTITY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It runs AFTER the probe answers and BEFORE the server is accepted, and it asks
 * a question static analysis provably cannot answer (see the review history in
 * `resolver/detect.ts`): is the process bound to the probed port the start
 * command WE spawned, or a descendant of it? That closes the install-hook class
 * — `"prepare": "nohup acme-server &"` and its endless spellings — where a
 * detached published server squats the port and answers our probe while the
 * validated start command never binds. Static analysis has taken nine rounds on
 * that class and still leaks; one `/proc` read settles it.
 *
 * IDENTITY COMES FROM THE SPAWN, NOT FROM THE BOX. `buildAndStart` returns a
 * `SpawnIdentity` — the pid E2B reports for the command it started for us, plus
 * the process group read from `/proc/<pid>/stat` at that instant. Everything in
 * the box after the build is PR code, so an identity fact the box WRITES is one
 * the PR chooses: an earlier revision had the start wrapper write its pid to
 * `/tmp/mcp-server.pid` and read it back, and a squatter could overwrite that
 * file with its own pid and be recognised as ours, which defeats the entire
 * check. The box is now only ever asked for kernel facts (who holds the socket,
 * their ancestry, their process group) and the comparison happens here.
 *
 * Failing it is a MISS for a heuristic candidate: try the next, never a green.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO RUNTIME "OWNERSHIP" CHECK ANY MORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An earlier revision added a second runtime check: resolve the listening
 * process's MAIN MODULE from `/proc/<pid>/cmdline` (first argument that stats as
 * a regular file, else `/proc/<pid>/exe`), `realpath` it, and require the result
 * to be inside the checkout and outside `node_modules`. It is removed, because
 * that inference is wrong in both directions and covers nothing the other two
 * layers do not:
 *
 *   - FALSE REJECTS, systematically. `tsx src/index.ts` runs as `node
 *     .../node_modules/tsx/dist/cli.mjs src/index.ts`, whose first file-valued
 *     argument is under `node_modules`; `uv run python -m server` has no
 *     file-valued argument at all and falls back to `/proc/<pid>/exe`, which is
 *     `/usr/bin/python3`. Both are ordinary, correct MCP servers, and both are
 *     `rung: 'detected'`, which is exactly the population this check gated. It
 *     would have rejected them all.
 *   - FALSE ACCEPTS. A config-file argument (`node server.js --config
 *     ./mcp.json` reordered, or any launcher that takes a path) can be the first
 *     thing that stats as a file, so the check would happily "verify" a path
 *     that is not executable code at all.
 *   - AND IT NEVER COVERED THE CASE IT WAS INVENTED FOR. The motivating shape is
 *     a build that copies a dependency into the tree (`cp
 *     node_modules/acme/server.js dist/index.js`, then `node dist/index.js`).
 *     The listening process's main module is then `/home/user/repo/dist/index.js`
 *     — inside the checkout, outside `node_modules` — and the check PASSES.
 *
 * WHAT COVERS WHAT NOW:
 *
 *   - that the entry point is checkout code — STATIC, in `detect.ts` rule C and
 *     `verifyExtensionlessStart`: a candidate's entry path must be
 *     checkout-relative and present in the `git ls-files` listing as a REGULAR
 *     file (a symlink or submodule is rejected outright), and a bare-word start
 *     resolved from `node_modules/.bin` is suppressed;
 *   - that the thing answering the probe is that entry point and not a squatter
 *     — RUNTIME, listener identity above.
 *
 * RESIDUAL, KNOWN AND ACCEPTED: (a) the copied-dependency case above, which the
 * removed check did not catch either, and which `ownershipProof: 'unverified'`
 * records honestly rather than pretending to have settled; (b) the degenerate
 * case where `git ls-files` yields nothing, so there is no listing to verify
 * against and a bare-word start cannot be suppressed. Both end in a green check
 * on a server whose code came from a dependency — a wrong PASS on a repo that
 * went out of its way to look like this, which is a smaller harm than the
 * blanket false-rejects the removed check produced on normal repos.
 *
 * WHY A SQUATTER UNDER AN AUTHORITATIVE RECIPE IS `server_unhealthy`, NOT A MISS.
 * There is nothing to fall through to — authoritative rungs do not fall through
 * — so the only choice is which verdict the author sees. `recipe_unresolvable`
 * (neutral) would be wrong twice over: we DID resolve the recipe, and the thing
 * that happened is that the declared start command did not end up serving the
 * probed port. `recipe_invalid` would be wrong too — the config parsed fine.
 * What is left is exactly what `server_unhealthy` already means: the declared
 * server did not serve. The detail text names the cause so it is actionable,
 * and the failure stays attributed to the declaration, which is the promise the
 * authoritative rung makes.
 */

import { logger } from "../../utils/logger.js";
import {
  buildAndStart,
  CheckStepError,
  cloneAndCheckout,
  killCheckSandbox,
  provisionCheckSandbox,
  type CheckSandbox,
  type CheckStepOutcome,
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
  type RecipeRung,
  type ResolvedRecipe,
} from "./resolver/index.js";

/**
 * How many heuristic candidates are worth a sandbox each.
 *
 * Three, because the detector emits candidates best-first and a fourth guess is
 * one nobody has evidence for — while every attempt costs a provision, a clone
 * and a build. An author whose repo needs a fourth guess is better served by
 * `mcpjam.yaml`, which the `recipe_unresolvable` output points at.
 */
export const MAX_CANDIDATES = 3;

/**
 * Total wall clock for resolution, across ALL candidates.
 *
 * The box lives 45 minutes and the eval suite legitimately wants twenty of them,
 * so resolution cannot be allowed to eat the budget it is resolving FOR: three
 * candidates each taking a full build (10m) and health window (2m) would spend
 * 36 minutes and leave nothing. Checked at candidate BOUNDARIES — an attempt
 * already in flight is bounded by its own build and health deadlines, so
 * interrupting one would buy nothing that is not already bounded.
 */
export const RESOLUTION_BUDGET_MS = 20 * 60_000;

/** Provenance the check output and the trigger row carry. */
export type RecipeProvenance = {
  recipeRung: RecipeRung;
  /** Constant strings + operator-controlled names; never PR file content. */
  recipeEvidence: string[];
};

/**
 * Outcomes resolution can produce: the sandbox module's three, plus the two the
 * ladder introduces.
 *
 * `recipe_invalid` is a FAILURE (the author's declared config is broken);
 * `recipe_unresolvable` is NEUTRAL (we could not work the repo out, which is
 * ours to improve, not the PR's to answer for).
 */
export type ResolveOutcome =
  | CheckStepOutcome
  | "recipe_invalid"
  | "recipe_unresolvable";

/**
 * A resolution failure that already knows how the check should conclude.
 *
 * A sibling of `CheckStepError` rather than a subclass, because that class's
 * outcome type is deliberately the narrow set the SANDBOX can produce, and
 * widening it would let a sandbox-level failure claim a ladder-level verdict.
 * The worker's classifier handles both.
 */
export class RecipeStartError extends Error {
  constructor(
    readonly outcome: ResolveOutcome,
    message: string,
    readonly detailsMarkdown?: string,
    /** Present when the failure happened AFTER a recipe was resolved. */
    readonly provenance?: RecipeProvenance
  ) {
    super(message);
    this.name = "RecipeStartError";
  }
}

export type ResolveAndStartResult = {
  /** The live box. Every other box this call created is already dead. */
  sandbox: CheckSandbox;
  /** The recipe that actually built and served, with its rung and evidence. */
  recipe: ResolvedRecipe;
  /** Running and verified — NOT restarted after verification. */
  started: StartedServer;
  provenance: RecipeProvenance;
};

/**
 * Injectable collaborators. Every external effect is one of these, so the tests
 * drive real control flow — including the fresh-box policy and the `finally`
 * teardown — without E2B.
 */
export type ResolveAndStartDeps = {
  provisionSandbox: typeof provisionCheckSandbox;
  cloneAndCheckout: typeof cloneAndCheckout;
  buildAndStart: typeof buildAndStart;
  killSandbox: typeof killCheckSandbox;
  resolveLadder: typeof resolveRecipeLadder;
  readResolverInputs: typeof readResolverInputs;
  inspectListener: typeof inspectListener;
  /**
   * Called with the box this call currently owns, and with `null` once it is
   * dead. The worker mirrors it into the variable its own `finally` kills, so a
   * box can never be orphaned by an unexpected throw between the two modules.
   */
  onSandbox: (sandbox: CheckSandbox | null) => void;
  /** Throws `LeaseLostError` when the claim stopped being ours. */
  assertLeaseHeld: () => void;
  now: () => number;
  maxCandidates: number;
  budgetMs: number;
};

function defaultDeps(): ResolveAndStartDeps {
  return {
    provisionSandbox: provisionCheckSandbox,
    cloneAndCheckout,
    buildAndStart,
    killSandbox: killCheckSandbox,
    resolveLadder: resolveRecipeLadder,
    readResolverInputs,
    inspectListener,
    onSandbox: () => {},
    assertLeaseHeld: () => {},
    now: () => Date.now(),
    maxCandidates: MAX_CANDIDATES,
    budgetMs: RESOLUTION_BUDGET_MS,
  };
}

export type ResolveAndStartArgs = {
  triggerId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
};

/** What one attempt in one box produced. */
type Attempt =
  /** Built, served, and passed both runtime checks. */
  | { kind: "started"; started: StartedServer }
  /** A heuristic guess that did not pan out. Discard, try the next. */
  | { kind: "miss"; reason: string };

function provenanceOf(recipe: ResolvedRecipe): RecipeProvenance {
  return { recipeRung: recipe.rung, recipeEvidence: [...recipe.evidence] };
}

/**
 * Resolve a recipe for this PR and leave its server running and verified.
 *
 * On EVERY failure path, every sandbox this function created is killed before it
 * throws — including the one an attempt was using. On success exactly one box is
 * alive, and it is the one in the result.
 */
export async function resolveAndStart(
  args: ResolveAndStartArgs,
  overrides?: Partial<ResolveAndStartDeps>
): Promise<ResolveAndStartResult> {
  const deps: ResolveAndStartDeps = { ...defaultDeps(), ...overrides };
  const startedAt = deps.now();
  const logContext = {
    triggerId: args.triggerId,
    repo: args.repoFullName,
    pr: args.prNumber,
  };

  let sandbox: CheckSandbox | null = null;

  /** Kill the box we hold, and tell the caller it is gone. */
  const releaseSandbox = async (): Promise<void> => {
    if (!sandbox) return;
    const dying = sandbox;
    // Cleared FIRST: if `killSandbox` throws (it does not — it is best effort —
    // but the dep is injectable), the caller must not be handed a box we already
    // gave up on.
    sandbox = null;
    deps.onSandbox(null);
    await deps.killSandbox(dying);
  };

  /** A clean box with the PR checked out in it. */
  const freshSandbox = async (): Promise<CheckSandbox> => {
    await releaseSandbox();
    const box = await deps.provisionSandbox({
      triggerId: args.triggerId,
      repoFullName: args.repoFullName,
      prNumber: args.prNumber,
    });
    sandbox = box;
    deps.onSandbox(box);
    deps.assertLeaseHeld();
    await deps.cloneAndCheckout(box, {
      repoFullName: args.repoFullName,
      prNumber: args.prNumber,
      headSha: args.headSha,
    });
    deps.assertLeaseHeld();
    return box;
  };

  try {
    // Box #1 is provisioned before anything is known about the repo, because
    // reading the repo REQUIRES a checkout. It is pristine at this point — only
    // byte-capped reads have touched it — so the first attempt reuses it rather
    // than paying for a second provision to prove a point.
    const box = await freshSandbox();
    const inputs = await deps.readResolverInputs(box);
    deps.assertLeaseHeld();

    let resolution;
    try {
      resolution = deps.resolveLadder({
        repoFullName: args.repoFullName,
        // The reader's three-way answer, handed over WHOLE. Collapsing
        // `over_cap` into `null` here is the bug this shape exists to prevent:
        // an oversized declared config is invalid, and `null` means absent,
        // which is the one thing an authoritative rung must never fall through
        // on. `resolveRecipeLadder` owns the ordering (an operator override
        // still outranks it), so the decision belongs there, not here.
        mcpjamYaml:
          inputs.mcpjamYaml.kind === "present" ? inputs.mcpjamYaml.text : null,
        mcpjamYamlOverCap: inputs.mcpjamYaml.kind === "over_cap",
        detection: inputs.detection,
      });
    } catch (error) {
      throw ladderFailure(error, args.repoFullName);
    }

    if (resolution.kind === "authoritative") {
      const recipe = resolution.recipe;
      logger.info("[github-checks] authoritative recipe resolved", {
        ...logContext,
        rung: recipe.rung,
      });
      // No fall-through and no miss arm: under an authoritative rung every
      // failure is attributable, so `attempt` throws rather than returning one.
      const attempt = await runAttempt(box, recipe, deps, true);
      if (attempt.kind !== "started") {
        // Unreachable — `authoritative: true` never yields a miss — and asserted
        // rather than assumed, because the alternative is silently returning a
        // server nothing verified.
        throw new RecipeStartError(
          "infra_error",
          `authoritative attempt produced a miss: ${attempt.reason}`,
          undefined,
          provenanceOf(recipe)
        );
      }
      return {
        sandbox: box,
        recipe,
        started: attempt.started,
        provenance: provenanceOf(recipe),
      };
    }

    const candidates = resolution.candidates.slice(0, deps.maxCandidates);
    const misses: string[] = [];
    let currentBox = box;
    for (let index = 0; index < candidates.length; index += 1) {
      if (index > 0) {
        const elapsed = deps.now() - startedAt;
        if (elapsed >= deps.budgetMs) {
          misses.push(
            `stopped after ${index} candidate(s): the resolution time budget (${Math.round(
              deps.budgetMs / 60_000
            )} minutes) was spent`
          );
          break;
        }
        // The previous candidate's box dies HERE, before the next is
        // provisioned — see the module docblock on why B must never meet A.
        currentBox = await freshSandbox();
      }
      const candidate = candidates[index];
      logger.info("[github-checks] trying a detected candidate", {
        ...logContext,
        candidate: index + 1,
        of: candidates.length,
        ownershipProof: candidate.ownershipProof,
      });
      const attempt = await runAttempt(currentBox, candidate, deps, false);
      if (attempt.kind === "started") {
        return {
          sandbox: currentBox,
          recipe: candidate,
          started: attempt.started,
          provenance: provenanceOf(candidate),
        };
      }
      misses.push(`candidate ${index + 1}: ${attempt.reason}`);
      deps.assertLeaseHeld();
    }

    throw unresolvable(args.repoFullName, misses);
  } catch (error) {
    // Every box this call created is dead before the error leaves — including
    // the one an attempt was mid-way through.
    await releaseSandbox().catch(() => {});
    throw error;
  }
}

/**
 * Build, start, probe, and VERIFY one recipe in one box.
 *
 * `authoritative` decides only what a failure MEANS, never what is checked: the
 * same build runs, the same probe runs, and the same runtime checks run. That is
 * deliberate — a squatting listener is not the declared server either, so
 * skipping the identity check for authoritative rungs would leave the one class
 * it exists to close open on exactly the repos we trust most.
 */
async function runAttempt(
  sandbox: CheckSandbox,
  recipe: ResolvedRecipe,
  deps: ResolveAndStartDeps,
  authoritative: boolean
): Promise<Attempt> {
  let started: StartedServer;
  try {
    started = await deps.buildAndStart(sandbox, recipe);
  } catch (error) {
    if (!(error instanceof CheckStepError)) throw error;
    // INFRASTRUCTURE ABORTS, ALWAYS. A provision, lockdown or E2B failure is
    // ours, and consuming it as a miss would spend the remaining candidates
    // rediscovering the same outage before concluding a neutral verdict that
    // says nothing true about the repo.
    if (error.outcome === "infra_error") throw error;
    if (authoritative) {
      throw new RecipeStartError(
        error.outcome,
        error.message,
        error.detailsMarkdown,
        provenanceOf(recipe)
      );
    }
    return {
      kind: "miss",
      reason:
        error.outcome === "build_failed"
          ? "the detected build command failed"
          : "the detected start command never served MCP on the expected port and path",
    };
  }

  deps.assertLeaseHeld();
  const verdict = await verifyRunningServer(
    sandbox,
    recipe,
    started.spawn,
    deps
  );
  if (verdict.status === "ok") return { kind: "started", started };
  if (verdict.status === "unknown") {
    // We could not LOOK. That is the command channel or `/proc`, i.e. ours —
    // and it must not stand in for either verdict: not a pass (the whole point
    // of the check) and not a miss (which would burn the remaining candidates
    // on an outage).
    throw new RecipeStartError(
      "infra_error",
      `could not verify what is listening on port ${recipe.port}: ${verdict.reason}`,
      undefined,
      provenanceOf(recipe)
    );
  }
  if (authoritative) {
    // See the module docblock: the declared recipe genuinely failed to serve.
    throw new RecipeStartError(
      "server_unhealthy",
      "the declared start command did not end up serving the probed port",
      [
        `Something answered the MCP probe on port ${recipe.port}${recipe.mcpPath}, but it is not the server your \`start\` command produced: ${verdict.reason}.`,
        "",
        "A detached process left behind by an install or build lifecycle hook is the usual cause; the check refuses to report on it, because a verdict about it would say nothing about this pull request.",
      ].join("\n"),
      provenanceOf(recipe)
    );
  }
  return { kind: "miss", reason: verdict.reason };
}

type VerificationVerdict =
  | { status: "ok" }
  /** Definite: something is listening, and it is not ours / not the checkout. */
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
 * scripts/verify-listener-identity.ts. With `setsid` the group begins at our
 * spawn, so nothing that predates it can be in it, and a new session means an
 * outside process cannot `setpgid` its way in either.
 *
 * BOTH expected values come from the spawn. The group in particular CANNOT be
 * recovered later: the shape it exists to cover is a supervisor that exits, and
 * once it has exited `/proc/<pid>` is gone and its pgrp reads as null — so a
 * fallback that read the group at verification time was guaranteed to be
 * unavailable in exactly the case it was written for.
 */
function isOurs(process: ListenerProcess, spawn: SpawnIdentity): boolean {
  if (process.pid === spawn.pid) return true;
  if (process.ppids.includes(spawn.pid)) return true;
  return (
    spawn.pgrp !== null && process.pgrp !== null && process.pgrp === spawn.pgrp
  );
}

/**
 * A ladder throw, mapped to its outcome.
 *
 * `no_recipe` is the HEURISTIC exhaustion case — nobody declared anything and
 * nothing was detectable — so it is neutral. Every other `RecipeResolutionError`
 * comes from an AUTHORITATIVE rung refusing a config that is present and broken,
 * which is the PR author's to fix and therefore a failure.
 */
function ladderFailure(error: unknown, repoFullName: string): RecipeStartError {
  if (!(error instanceof RecipeResolutionError)) {
    return new RecipeStartError(
      "infra_error",
      error instanceof Error ? error.message.slice(0, 200) : String(error)
    );
  }
  if (error.reason === "no_recipe") {
    // `detailsMarkdown` here is detect.ts's discard reasons: constant strings,
    // multi-line, and already formatted as a list — so it is appended as its own
    // block rather than folded into a bullet.
    return unresolvable(repoFullName, [], error.detailsMarkdown);
  }
  return new RecipeStartError(
    "recipe_invalid",
    error.message,
    [
      "The configuration this repository declares for MCPJam checks is present but not usable, so the check ran nothing rather than guessing at what you meant.",
      ...(error.detailsMarkdown ? ["", error.detailsMarkdown] : []),
    ].join("\n")
  );
}

/** The neutral end of the ladder, with the one-file fix spelled out. */
function unresolvable(
  repoFullName: string,
  notes: string[],
  detailsBlock?: string
): RecipeStartError {
  return new RecipeStartError(
    "recipe_unresolvable",
    `no usable recipe for ${repoFullName}`,
    [
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
      ...(notes.length > 0
        ? ["", "What was tried:", ...notes.map((note) => `- ${note}`)]
        : []),
      ...(detailsBlock ? ["", detailsBlock] : []),
    ].join("\n")
  );
}
