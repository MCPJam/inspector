import { logger } from "../../utils/logger.js";
import { buildSyntheticModelDefinition } from "../../utils/org-model-config.js";
import {
  captureAndPersistWidgetSnapshotsForSession,
  runSyntheticHostSession,
  type SimulationManagerFactory,
} from "./runner.js";
import {
  fetchPinnedSkill,
  finalizePendingAttempts,
  heartbeatJourneyRun,
  reportAttempt,
  swarmPersonaNextTurn,
  type PersonaSnapshot,
  type PinnedHostExecutionSpec,
  type PinnedSkillMeta,
  type SwarmAttemptStatus,
} from "../swarm-agent.js";
import { runSwarmChecks } from "../checks/run-swarm-checks.js";
import { createBrowserArtifactOutbox } from "../browser-artifact-outbox.js";
import {
  canProvisionSwarmSandboxes,
  provisionAttemptSandbox,
  releaseAttemptSandbox,
  sandboxIntentFor,
  targetWantsBash,
  targetWantsHarnessBox,
  type ProvisionedAttemptSandbox,
  type SandboxIntent,
} from "./swarm-sandbox.js";
import { checkHarnessRuntimeAvailable } from "../../utils/harness/harness-availability.js";
import { hasSelectedMcpServersForAdmission } from "../evals/harness-admission.js";
import { readXaaEnterprisePolicy } from "@mcpjam/sdk";
import { resolvePinnedSkillCached } from "./pinned-skill-cache.js";
import { swarmAttemptChatSessionId } from "../../../shared/swarm-session-id.js";
import {
  humanizeSwarmAttemptErrorMessage,
  isAccountLimit,
  MAX_ATTEMPT_ERROR_CHARS,
} from "../../../shared/swarm-attempt-error.js";
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import { JourneyRunStreamHub } from "./swarm-stream-hub.js";
import type {
  SwarmStreamEnvelope,
  SwarmStreamEvent,
  SwarmStreamPayload,
} from "../../../shared/swarm-stream-events.js";

/**
 * Swarm (journey-execution) multi-host fan-out runner — PR 3d.
 *
 * Generalizes the PR-3c single-host runner to a bounded host-worker pool over
 * `snapshot.hosts[]`. Each host runs its `sessionsPerTarget` synthetic
 * persona-driven sessions SEQUENTIALLY (one active session per host); at most
 * {@link MAX_CONCURRENT_HOSTS} hosts are active concurrently. The per-session
 * host-turn machinery is the shared {@link runSyntheticHostSession} core
 * (identical to scenario session-simulation); this file owns the swarm surface:
 * the claim→run→persist→terminal attempt ordering, the swarm persona driver,
 * swarm transcript attribution, an independent heartbeat, graceful shutdown
 * registration, and the two run-level short-circuits below.
 *
 * Failure isolation + short-circuits:
 *   - A normal session failure affects only that attempt; the host's other
 *     sessions and every other host continue.
 *   - A PROVIDER rate-limit (a 429 folded to `rate_limited`, message does NOT
 *     look like an org/spend cap) stops scheduling further sessions FOR THAT
 *     HOST and marks its remaining `pending` attempts `rate_limited`. Other
 *     hosts continue.
 *   - An ORG SPEND-CAP breach (message looks like an org/spend cap) stops
 *     scheduling ALL hosts, cancels in-flight turns, and finalizes the run's
 *     remaining pending attempts (`errorCode: "spend_cap_exceeded"`).
 *   - Abort (shutdown / user cancel) stops new scheduling and cancels in-flight
 *     turns AND the (now-cancellable) persona driver, so every in-flight session
 *     unwinds promptly and self-reports its own accurate terminal via the normal
 *     path. The run-level `finalizeRun` best-effort finalizes only the remaining
 *     never-claimed `pending` attempts (`errorCode: "runner_shutdown"`); the
 *     backend stale-run cron is the hard backstop.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
/** Bounded target-worker pool: at most this many execution targets run
 * concurrently. A target is one `snapshot.hosts[]` entry — a legacy host OR a
 * project environment (two environments may share a host and still count as
 * two targets). */
export const MAX_CONCURRENT_TARGETS = 3;
/** @deprecated Renamed {@link MAX_CONCURRENT_TARGETS} (targets ≠ hosts once
 * environments land). Kept for existing tests/imports. */
export const MAX_CONCURRENT_HOSTS = MAX_CONCURRENT_TARGETS;

/** Session-id identity for a pinned execution target (shared mint — D1).
 * `environmentId` comes from the FIRST-CLASS `environmentRef`; the opaque
 * `targetId` is never parsed. */
function targetSessionIdentity(target: PinnedHostExecutionSpec): {
  hostId: string;
  environmentId?: string;
} {
  return {
    hostId: target.hostId,
    ...(target.environmentRef?.environmentId
      ? { environmentId: target.environmentRef.environmentId }
      : {}),
  };
}

/**
 * Builds a fresh, fully-connected manager scoped to one pinned host's
 * `serverIds`. Host-aware (unlike the scenario {@link SimulationManagerFactory})
 * so a single fan-out run can connect different servers per host.
 */
export type JourneyManagerFactory = (host: PinnedHostExecutionSpec) => Promise<{
  manager: Awaited<ReturnType<SimulationManagerFactory>>["manager"];
  connectedServerIds: string[];
  connectedServerNames?: string[];
  dispose: () => Promise<void>;
}>;

export interface StartJourneyRunOptions {
  runId: string;
  projectId: string;
  /** Every pinned host this run fans out across (`snapshot.hosts`). */
  hosts: PinnedHostExecutionSpec[];
  personaSnapshot: PersonaSnapshot;
  sessionsPerTarget: number;
  maxTurns: number;
  /**
   * True when the run's pinned snapshot carries a non-empty rubric. Only a
   * gate — the criteria themselves come back from the claim, so the graded
   * definition is always the backend's pinned copy.
   */
  hasRubric?: boolean;
  convexHttpUrl: string;
  /**
   * Resolves the launching member's bearer for `/journey-execution/*` calls.
   *
   * A THUNK, not a string, because a swarm run outlives its token. Delegated
   * JWTs (`sk_`, Slack, Discord callers) live ~2h; a wide fan-out can run
   * longer, and the captured-string version failed every remaining call the
   * moment it expired — claims, terminal reports, transcript persists — with
   * the run left looking half-finished. `getConvexBearerForDelegation`
   * caches and re-mints near expiry, so calling this repeatedly is cheap.
   *
   * Session-JWT callers pass a constant thunk: their token's lifetime is the
   * browser session's and nothing here can extend it. The stale-run sweep
   * covers a run whose launching tab closed. Precedent for the shape:
   * `github-checks-worker.ts`.
   *
   * RESOLVED PER UNIT OF WORK — once per target, once per session attempt,
   * once per finalizer — not per outbound call. That bounds a run's staleness
   * to one session rather than the whole run, which is the property that
   * matters; threading an await through all ~35 call sites would buy noise.
   */
  getBearer: () => Promise<string>;
  /** Builds a fresh connected manager scoped to one host's `serverIds`. */
  managerFactory: JourneyManagerFactory;
  /** Aborts the run mid-fan-out on inspector shutdown / user cancel. */
  abortSignal?: AbortSignal;
}

interface RunningJourneyHandle {
  abort: () => void;
  /** Resolves when the run loop's `finally` has cleared the registry. */
  done: Promise<void>;
  /** Live SSE multiplex for this run (late-join buffer + subscribers). */
  hub: JourneyRunStreamHub;
}

const runningJourneyRuns = new Map<string, RunningJourneyHandle>();

export function getRunningJourneyRunCount(): number {
  return runningJourneyRuns.size;
}

/** Active run stream hub, if the runner is still in-process. */
export function getRunningJourneyStreamHub(
  runId: string
): JourneyRunStreamHub | undefined {
  return runningJourneyRuns.get(runId)?.hub;
}

/**
 * Graceful shutdown: abort every active journey run and await each loop's
 * `finally` (which stops the heartbeat, cancels in-flight turns, and
 * best-effort finalizes remaining pending attempts) up to `timeoutMs`.
 */
export async function shutdownRunningJourneyRuns(
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS
): Promise<void> {
  const handles = Array.from(runningJourneyRuns.values());
  for (const handle of handles) {
    handle.abort();
  }
  const timeoutPromise = new Promise<void>((resolve) =>
    setTimeout(resolve, timeoutMs)
  );
  await Promise.race([
    Promise.allSettled(handles.map((h) => h.done)),
    timeoutPromise,
  ]);
}

function composeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/**
 * Register the run for graceful shutdown, execute the fan-out loop, and clear
 * the registry on completion. Fire-and-forget from the route (via
 * `setImmediate`) — the HTTP 202 already returned.
 */
export async function startJourneyRun(
  opts: StartJourneyRunOptions
): Promise<void> {
  const controller = new AbortController();
  const composed = composeAbortSignals(opts.abortSignal, controller.signal);
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const hub = new JourneyRunStreamHub();
  runningJourneyRuns.set(opts.runId, {
    abort: () => controller.abort(),
    done,
    hub,
  });
  try {
    await runJourneyFanOut({ ...opts, abortSignal: composed, hub });
  } finally {
    // Terminal multiplex event before unregistering so late SSE clients see it.
    hub.emit({
      type: "run_complete",
      runId: opts.runId,
      hostId: "",
      chatSessionId: "",
      sessionIndex: -1,
    });
    runningJourneyRuns.delete(opts.runId);
    resolveDone();
  }
}

/** Map a shared-core session outcome to the attempt terminal state + error.
 *
 * `errorReason` is the structured tag the thrown route error carried
 * (`details.reason` — e.g. an XAA failure classified by
 * `toXaaConnectFailure`). It becomes the attempt's `errorCode` in place of the
 * generic `session_failed`, which is what lets the run banner choose a tone:
 * a stale sign-in that needs re-running is not the same event as a session
 * that crashed, and only the producer still knows which one this was. */
function terminalForOutcome(
  outcome: "succeeded" | "failed" | "rate_limited",
  errorMessage: string | undefined,
  errorReason?: string
): { status: SwarmAttemptStatus; errorCode?: string; errorMessage?: string } {
  if (outcome === "succeeded") {
    return { status: "succeeded" };
  }
  // The thrown message is a `SwarmAgentError` envelope wrapping the provider's
  // JSON body — unreadable, and it embeds the deployment URL. The stored field
  // is specified as a human string that is never a raw provider payload, so
  // the humanizer runs HERE, at the producer, not at every render site.
  const safeMessage = errorMessage
    ? humanizeSwarmAttemptErrorMessage(errorMessage)
    : undefined;
  if (outcome === "rate_limited") {
    return {
      status: "rate_limited",
      errorCode: "rate_limited",
      ...(safeMessage ? { errorMessage: safeMessage } : {}),
    };
  }
  // A `failed` attempt legitimately has NO chatSessions row: the shared core
  // returns `outcome: "failed"` when it aborts before the first turn persisted
  // (persona endSession on turn 0, or an abort caught at the turn-loop guard),
  // in which case nothing was written. That's a consistent terminal — the
  // backend does not require a session row for a failed attempt (unlike a
  // `succeeded` terminal, which must carry the claim's chatSessionId).
  return {
    status: "failed",
    errorCode: errorReason ?? "session_failed",
    ...(safeMessage ? { errorMessage: safeMessage } : {}),
  };
}

/**
 * Distinguish an ORG spend-cap breach from a PROVIDER rate-limit within the
 * shared core's `rate_limited` bucket (both fold there via `classifyTurnFailure`).
 * An account-wide limit is the org cap (WHOLE-RUN stop); a provider 429 on one
 * host's own key is a per-HOST stop. A missing message defaults to the narrower
 * per-host stop — never escalate to a whole-run halt on ambiguous signal.
 *
 * The backend's denial code decides it, via the shared {@link isAccountLimit}
 * the run screen also renders from. `runner.ts` concatenates that code into the
 * message ("<sentence> (<code>, HTTP <status>)"), and it is the only reliable
 * signal: no MCPJam limit sentence — "Daily credit limit reached.", "Daily
 * MCPJam model limit reached." — contains spend/cap/quota/budget wording.
 *
 * The prose check is kept as a second signal for a backend that words a cap
 * without a code. `cap`/`quota`/`budget` stay word-anchored so "capacity" /
 * "recap" / "escape" remain a per-host provider rate-limit.
 */
function classifyRateLimit(
  message: string | undefined
): "org_spend_cap" | "provider_rate_limit" {
  if (!message) return "provider_rate_limit";
  if (isAccountLimit(message)) return "org_spend_cap";
  if (/spend|\bcap\b|\bquota\b|\bbudget\b/i.test(message)) {
    return "org_spend_cap";
  }
  return "provider_rate_limit";
}

/** Concise structured log — ids + status only; NEVER prompts/transcripts/keys. */
function logEvent(
  event: string,
  fields: Record<string, string | number | boolean | undefined>
): void {
  logger.info(`[swarm.runner] ${event}`, fields);
}

function bindSessionEmit(
  hub: JourneyRunStreamHub,
  envelope: SwarmStreamEnvelope
): (payload: SwarmStreamPayload) => void {
  return (payload) => {
    hub.emit({ ...envelope, ...payload } as SwarmStreamEvent);
  };
}

async function runJourneyFanOut(
  opts: StartJourneyRunOptions & { hub: JourneyRunStreamHub }
): Promise<void> {
  const {
    runId,
    projectId,
    hosts,
    personaSnapshot,
    sessionsPerTarget,
    maxTurns,
    hasRubric,
    convexHttpUrl,
    getBearer,
    managerFactory,
    abortSignal,
    hub,
  } = opts;

  const runStartedAt = Date.now();

  // Run-level stop controller. Aborting it cancels every in-flight session's
  // turns; composed with the incoming abort so a shutdown/cancel does the same.
  const runStop = new AbortController();
  const sessionSignal = composeAbortSignals(abortSignal, runStop.signal);
  // Set on an org spend-cap breach — halts scheduling across ALL hosts.
  let spendCapTripped = false;
  let spendCapMessage: string | undefined;

  const stopScheduling = () => spendCapTripped || abortSignal?.aborted === true;

  // Independent heartbeat: an interval timer (NOT gated on turn/attempt
  // completion) started before the first attempt and stopped in `finally`.
  // Single-flight so a slow heartbeat can't stack. One per run.
  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (abortSignal?.aborted) return;
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    // Re-resolved on every beat. Cheap (the mint is cached) and it makes the
    // heartbeat the one thing that CANNOT go stale — which matters, because a
    // silent heartbeat is what the backend's stale sweep reads as a dead
    // runner.
    getBearer()
      .then((bearer) =>
        heartbeatJourneyRun(convexHttpUrl, bearer, { projectId, runId })
      )
      .catch((err) => {
        logger.warn("[swarm.runner] heartbeat failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, HEARTBEAT_INTERVAL_MS);

  // On shutdown/abort (or a spend-cap short-circuit) the run's `sessionSignal`
  // is forwarded into BOTH the shared core's turn drain AND the persona driver
  // (`swarmPersonaNextTurn`, below), so the one place a session could previously
  // park uncancellably for up to 120s is now cancellable. Every in-flight
  // session therefore unwinds promptly and reports its OWN accurate terminal via
  // the normal path below (`failed` for an interrupted session, or its real
  // outcome if it finished first) — with the transcript already persisted. There
  // is no eager per-attempt abort report to race that normal terminal, so no
  // session is misclassified on shutdown. The run-level `finalizeRun` on abort
  // still sweeps never-claimed `pending` attempts, and the backend stale-run
  // cron remains the hard backstop for anything that still can't unwind.

  logEvent("run.start", {
    runId,
    targetCount: hosts.length,
    sessionsPerTarget,
    maxTurns,
    maxConcurrentTargets: Math.min(MAX_CONCURRENT_TARGETS, hosts.length),
  });

  // Whether THIS process can run the ephemeral-sandbox path end to end. Checked
  // once per run: provision and release share one credential set, so a server
  // that could boot a box but not tear one down would burn paid sandboxes until
  // the GC cron noticed.
  // The FLAG decides whether the ephemeral regime is in force; the DATA PLANE
  // decides whether we can actually honour it. Keeping them apart matters: with
  // the flag on and the data plane unconfigured, a target that wants bash must
  // FAIL, not quietly run without it. Collapsing the two into one boolean is
  // what let an unavailable service turn into a silently degraded green run —
  // the same shape as the harness gate below.
  const ephemeralSandboxes = canProvisionSwarmSandboxes();

  // --- Run one target's sessions SEQUENTIALLY ------------------------------
  const runTarget = async (target: PinnedHostExecutionSpec): Promise<void> => {
    /**
     * Per-TARGET resolution: a target's setup (harness admission, pinned-skill
     * fetch) runs before its first session, so it gets its own read rather than
     * inheriting one minted at launch.
     *
     * DECLARED here, RESOLVED inside the guarded block below. Minting can fail
     * — a delegated JWT is an outbound call — and resolving it out here would
     * reject `runTarget` itself, which rejects the worker, which rejects the
     * `Promise.all` over workers, which skips both the other targets and the
     * run-level finalize. One expired credential would leave a whole run's
     * attempts `pending` with nothing having recorded why. Inside the try, the
     * same failure lands in the target-level catch, which finalizes this
     * target's attempts and lets the other workers carry on.
     */
    let bearer: string | undefined;
    const hostId = target.hostId;
    const targetId = target.targetId;
    const modelId = target.modelId;
    // Hoisted so the worker-level catch below knows how far this target got and
    // can finalize the attempts it left behind.
    let sessionIdx = 0;
    // A pure property read, so it lives OUT here where both the per-target
    // admission block and the per-attempt binding check can see it — and
    // outside the fail-closed guard below, which is only for things that can
    // throw.
    const harnessNeedsBox = target.harness !== undefined;
    // Assigned inside the try, once the model is RESOLVED — see the harness
    // admission block below.
    let harnessTargetBlockedReason: string | undefined;
    let harnessTargetIntent: SandboxIntent | undefined;
    try {
      bearer = await getBearer();

      // Resolve the pinned target's modelId to a ModelDefinition once per target
      // (catalog hits pass through; BYOK shapes get a derived provider). NEVER
      // refetch the live host config — everything comes from the immutable
      // snapshot. A model-less / unresolvable pinned spec throws HERE, before any
      // attempt is claimed — the catch finalizes this target's pending attempts.
      const modelDefinition = buildSyntheticModelDefinition(modelId);

      // B-isolation F4/phase 6 — a harness target runs on ITS OWN disposable box
      // or it does not run at all.
      //
      // `runHarnessTurn` never goes through `resolveHostTools`. Given an explicit
      // ephemeral binding it uses that box; given none it reserves the launcher's
      // PERSONAL computer, which every other session in the run would also be
      // using — the contamination this work exists to remove, wearing a fix. So
      // the rule is: a harness with no binding is refused. There is no fall back
      // to the personal computer for a journey.
      //
      // Per-TARGET here (does this target's configuration make a box possible at
      // all); the per-ATTEMPT check below decides whether one actually arrived.
      // Neither is gated on `ephemeralSandboxes`, deliberately — that also
      // requires the data plane to be configured, and tying a refusal to provision
      // CAPABILITY would mean an unconfigured or briefly broken sandbox service
      // silently re-enables the very path this rule closes. Availability must
      // never widen what is allowed. (The `MCPJAM_SWARM_EPHEMERAL_BASH` flag that
      // used to gate this is gone — ephemeral is simply how swarms run now.)
      // ADMISSION, computed once per target and FAIL-CLOSED on any throw.
      //
      // Everything in here reads the immutable snapshot and asks "may this
      // target run at all". Several steps can throw on a snapshot this build
      // does not understand — `getHarnessAdapter` on a harness id written by a
      // newer backend, a policy reader on a malformed profile — and a throw
      // escaping into `runTarget`'s catch would finalize the target's attempts
      // with a raw internal message instead of the refusal a run reader can
      // act on.
      //
      // It is guarded HERE rather than left to that catch for a reason worth
      // stating: this block is where new admission rules get added, and the
      // per-target catch's promise is only as strong as its newest line. A
      // rule that throws should refuse ITS target with a stated reason, never
      // reach for a generic handler, and never be more permissive than the
      // rule it failed to evaluate.
      try {
        // The target asked for a harness but its configuration can never yield a
        // box — no computer attached, or the environment pins no usable image. That
        // is knowable before the first attempt, so say it once, precisely.
        harnessTargetIntent = harnessNeedsBox
          ? sandboxIntentFor(target)
          : undefined;
        //
        // AND the same preflight interactive chat runs. Until phase 6 the swarm
        // path refused every harness outright, so it never needed one; admitting
        // harness targets means inheriting every rule chat already enforces, not
        // inventing a swarm-specific subset. `checkHarnessRuntimeAvailable` is the
        // shared gate (`web/chat-v2.ts`, `mcp/chat-v2.ts`) and covers, among
        // others, the three that bite hardest here:
        //
        //   - MODEL ELIGIBILITY. `resolveTurnRuntime` sends a non-MCPJam model on a
        //     local-runtime org-BYOK provider to the DIRECT engine, whose branch
        //     never forwards `harness` or `harnessSandboxBinding` at all. Without
        //     this the target would be admitted, boot a paid box, and silently run
        //     emulated with the box untouched.
        //   - ENTERPRISE-MANAGED (XAA) AUTHORIZATION. The harness reaches MCP
        //     servers through a signed proxy whose token cannot carry the host's
        //     policy, so a harness turn could bypass enforcement. The snapshot
        //     carries `mcpProfile` verbatim and `swarm-runs.ts` already reads the
        //     policy out of it for the MCP manager — this feeds the same value to
        //     the harness gate.
        //   - APPROVAL vs MCP TOOLS. Whether a harness can pause on the surface
        //     its MCP tools actually run on. Claude Code now can, on all three
        //     (`supportsMcpToolApproval: true`, via the bridge's `canUseTool`
        //     under "allow-reads"); Codex cannot pause at all, so
        //     `requireToolApproval` still refuses a Codex target outright.
        //
        // Deliberately NOT re-derived as a local subset: a rule added to the chat
        // preflight later must apply here too, and the only way to guarantee that
        // is to call the same function.
        const harnessAvailability =
          target.harness === undefined
            ? undefined
            : checkHarnessRuntimeAvailable({
                harnessId: target.harness,
                requireToolApproval: target.requireToolApproval,
                // PLUGIN servers count. A target whose MCP servers come solely
                // from a plugin has an empty `serverIds` and would otherwise slip
                // the approval gate this exists to close. The snapshot's pinned
                // list is the right input here even though `swarm-runs.ts`
                // re-gates it against the live plugin lifecycle at connect time:
                // this is an admission decision, and over-counting refuses a host
                // that advertises an approval gate it cannot enforce — the
                // fail-closed direction.
                hasSelectedMcpServers: hasSelectedMcpServersForAdmission({
                  ...(target.serverIds ? { serverIds: target.serverIds } : {}),
                  ...(target.pluginServerIds
                    ? { pluginServerIds: target.pluginServerIds }
                    : {}),
                }),
                // The RESOLVED definition — the SAME one the turn runs on. The
                // gate derives eligibility and the canonical id from it, so this
                // cannot disagree with what `resolveTurnRuntime` decides. Passing
                // the raw pinned string instead is how a bare hosted id
                // (`gpt-5-nano`) reads as non-hosted and a legitimate target gets
                // refused — and, in the other direction, how a BYOK model slips
                // through and silently runs emulated.
                model: {
                  id: String(modelDefinition.id),
                  provider: modelDefinition.provider,
                },
                // The same pinned id under the name the external-account rule
                // reads. Identical to `model.id` here — a swarm target has no
                // request body to override it — and passed explicitly so it
                // STAYS identical if that ever stops being true.
                hostModelId: modelId,
                // TRI-STATE, read without throwing, and INVALID counts as ON —
                // the same call `mcp/chat-v2.ts` makes. `xaaPolicyFromMcpProfile`
                // (the web route's variant) THROWS a 409 on a malformed profile,
                // which is right for an HTTP handler and wrong here: it would
                // surface as an exception carrying a message aimed at an API
                // client instead of a refusal a run reader can act on.
                //
                // A malformed enterprise policy must never be MORE permissive
                // than a valid one, so `invalid` gets exactly the treatment `on`
                // gets. Absent `mcpProfile` (a target snapshotted before the
                // field existed) reads as "off", matching chat's
                // absent-host-config path.
                xaaEnterprisePolicyOn:
                  readXaaEnterprisePolicy(target.mcpProfile).kind !== "off",
              });
        harnessTargetBlockedReason = !harnessNeedsBox
          ? undefined
          : !targetWantsHarnessBox(target)
          ? "This target runs the " +
            target.harness +
            " harness but has no computer attached, so there is nothing to run " +
            "it on. Attach a computer to this host."
          : harnessAvailability && !harnessAvailability.ok
          ? "This target runs the " +
            target.harness +
            " harness, which isn't available: " +
            harnessAvailability.reason +
            "."
          : harnessTargetIntent?.kind === "skip"
          ? "This target runs the " +
            target.harness +
            " harness, which needs a disposable sandbox per session. " +
            // An intent with no reason is a pre-B-isolation run snapshot: the
            // backend never resolved an image because it did not know how to.
            // Silent is right for bash (it simply goes missing); a harness
            // cannot run at all, so the session must say something true.
            (harnessTargetIntent.reason ??
              "This run pinned no computer image, so one cannot be created.")
          : undefined;
      } catch (err) {
        // Fail CLOSED and name what happened. We do not know WHICH rule threw,
        // so the message stays honest about that rather than guessing.
        harnessTargetIntent = undefined;
        harnessTargetBlockedReason =
          "This target's harness configuration could not be validated, so it " +
          "cannot run: " +
          (err instanceof Error ? err.message : String(err));
        logger.error(
          "[swarm.runner] harness admission threw; refusing target",
          {
            runId,
            hostId,
            targetId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }

      // Resolve the target's pinned skill BODIES up front (D3, fail-closed).
      // Undefined ⇒ legacy live-pool semantics; an array (possibly empty) ⇒ the
      // authoritative pinned set — env targets NEVER touch the live skills query.
      // A persistent fetch failure / 404 / hash mismatch throws HERE, before any
      // attempt is claimed, and the worker-catch finalizes the target's attempts
      // `failed` — never a silent skill-less run.
      const pinnedSkills = await resolveTargetPinnedSkills({
        target,
        projectId,
        runId,
        convexHttpUrl,
        bearer,
        signal: sessionSignal,
      });

      for (sessionIdx = 0; sessionIdx < sessionsPerTarget; sessionIdx++) {
        // Run-level stop (spend cap or shutdown/cancel) halts THIS target too.
        if (stopScheduling()) return;

        // Per-SESSION re-resolution — the granularity that actually bounds
        // staleness. Everything constructed below bakes this value in for the
        // session's lifetime: the browser-artifact outbox, the widget-snapshot
        // persist, the `authHeader` the shared turn core carries, and the
        // persona-next-turn calls. Re-reading here means the worst case is one
        // long session outliving its token, not the whole run.
        bearer = await getBearer();
        // The same value, as a `const`, for the callbacks below. `bearer` is a
        // reassigned `let` (and now starts undefined until the first mint), so
        // TypeScript drops its narrowing the moment it is read inside a
        // closure. Binding it here keeps those reads typed AND documents that a
        // callback fired later in the session uses the token this session began
        // with — which is the intended semantics, not an accident.
        const sessionBearer = bearer;

        // Deterministic claim key — the immutable chatSessionId the attempt is
        // claimed with and every persist + terminal reuse (shared mint, D1: env
        // targets key on environmentRef.environmentId so two env targets on the
        // SAME host can never collide).
        const chatSessionId = swarmAttemptChatSessionId(
          runId,
          targetSessionIdentity(target),
          sessionIdx
        );
        // Attempt-scoped: per-turn widget capture walks the FULL accumulated
        // transcript, so without this an early widget is re-fetched and
        // re-uploaded on every later turn.
        const capturedWidgetToolCallIds = new Set<string>();
        // Attempt-scoped durable capture of what the headless Chromium produced
        // (render observations, Computer Use steps, the replay `.webm`). Swarms
        // are the ONE surface that opts into Computer Use, so they generate the
        // richest interaction record — and until this existed they kept none of
        // it. No scenarioId/accessVersion: the write authorizes through the
        // mutation's direct-session branch, where this runner IS the launcher
        // who owns every session row the run mints.
        const browserArtifacts = createBrowserArtifactOutbox({
          chatSessionId,
          convexAuthToken: bearer,
          logScope: "swarm.runner",
        });

        // CLAIM before executing: the `running` transition requires the
        // chatSessionId and is immutable thereafter. Persistence is LAUNCHER-gated
        // and requires the chatSessionId to match this claim, so it MUST come
        // after. A claim failure skips the session (we can't run without it).
        let claim: { ok: true; applied: boolean };
        try {
          claim = await reportAttempt(convexHttpUrl, bearer, {
            projectId,
            runId,
            hostId,
            ...(targetId ? { targetId } : {}),
            sessionIdx,
            status: "running",
            chatSessionId,
          });
        } catch (err) {
          logger.error(
            "[swarm.runner] attempt claim failed; skipping session",
            {
              runId,
              hostId,
              targetId,
              sessionIdx,
              error: err instanceof Error ? err.message : String(err),
            }
          );
          continue;
        }

        // Duplicate-launch guard: a duplicate-delivered launchKey dedupes to the
        // SAME runId, so two runners can iterate the SAME (run, host, sessionIdx)
        // and both claim `running` with the identical deterministic chatSessionId.
        // The backend applies the pending → running transition exactly once and
        // returns `applied: false` to the LOSER (its claim was a no-op replay of a
        // claim a sibling runner already made). The loser MUST NOT execute the
        // session — running it would double-persist and DOUBLE-BILL the same
        // attempt. Skip it: the winning runner (applied: true) owns execution and
        // the terminal report.
        if (!claim.applied) {
          logger.warn(
            "[swarm.runner] attempt already claimed by another runner; skipping session",
            { runId, hostId, sessionIdx }
          );
          continue;
        }

        const attemptStartedAt = Date.now();
        logEvent("attempt.start", {
          runId,
          hostId,
          targetId,
          sessionIdx,
          modelId,
        });

        const envelope: SwarmStreamEnvelope = {
          runId,
          hostId,
          ...(targetId ? { targetId } : {}),
          chatSessionId,
          sessionIndex: sessionIdx,
        };
        const emit = bindSessionEmit(hub, envelope);
        emit({ type: "attempt_status", status: "running" });

        // ── Per-attempt disposable sandbox (B-isolation) ──────────────────
        //
        // Provisioned AFTER the claim, because the backend binds the
        // reservation to a claimed, running attempt: a box may only exist for
        // work that is actually happening. Released in the `finally` below,
        // which is why it is declared out here.
        let attemptSandbox: ProvisionedAttemptSandbox | undefined;
        let bashUnavailableReason: string | undefined;
        // WHAT this target needs the box FOR. Until phase 6 that was always
        // `bash`, so the branches below could hardcode "shell" in their
        // operator-facing copy; a harness-only target (no `bash` in
        // `builtInToolIds`) now reaches the same branches, and telling its
        // operator to look at a tool they never configured sends them the wrong
        // way. `toolId` matters too — the UI keys the notice on it, and
        // "bash was suppressed" is not what happened.
        const sandboxConsumer = targetWantsBash(target)
          ? target.harness
            ? {
                label: `the shell and the ${target.harness} harness`,
                toolId: "bash",
              }
            : { label: "the shell", toolId: "bash" }
          : { label: `the ${target.harness} harness`, toolId: "harness" };
        // A target already known to be unrunnable (harness, no box possible)
        // gets refused by the shared core before any tool runs, so provisioning
        // would boot a paid box purely to release it unused — once per
        // configured session.
        if (!harnessTargetBlockedReason) {
          const intent = sandboxIntentFor(target);
          if (intent.kind === "skip" && intent.reason) {
            // The target ASKED for a shell and the environment can't give it
            // one. Hand the launch-time reason to the shared core, which emits
            // it through the SAME `onToolSuppressed` notice the resolver
            // already fires — one notice, naming the real problem, instead of
            // two saying different things.
            bashUnavailableReason = intent.reason;
          }
          if (intent.kind === "provision" && !ephemeralSandboxes) {
            // The target asked for a reproducible shell and this server cannot
            // supply one at all (no Convex URL / service token / vendor key).
            // Running it bash-less would be the degraded-but-green outcome the
            // whole design refuses — fail the attempt with a reason an operator
            // can act on.
            const message =
              "This server is not configured to provision disposable " +
              "sandboxes (the computers data plane is unavailable), so this " +
              `session cannot run ${sandboxConsumer.label} its target requires.`;
            logger.error(
              "[swarm.runner] a target needs a disposable sandbox but the data plane is unconfigured",
              {
                runId,
                targetId,
                sessionIdx,
              }
            );
            emit({
              type: "session_notice",
              kind: "tool_suppressed",
              toolId: sandboxConsumer.toolId,
              message,
            });
            emit({
              type: "attempt_status",
              status: "failed",
              errorMessage: message.slice(0, MAX_ATTEMPT_ERROR_CHARS),
            });
            await reportAttempt(convexHttpUrl, bearer, {
              projectId,
              runId,
              hostId,
              ...(targetId ? { targetId } : {}),
              sessionIdx,
              status: "failed",
              chatSessionId,
              errorCode: "sandbox_unavailable",
              errorMessage: message.slice(0, MAX_ATTEMPT_ERROR_CHARS),
            }).catch((err) => {
              logger.error(
                "[swarm.runner] failed to report sandbox-unavailable terminal",
                {
                  runId,
                  targetId,
                  sessionIdx,
                  error: err instanceof Error ? err.message : String(err),
                }
              );
            });
            logEvent("attempt.finish", {
              runId,
              hostId,
              targetId,
              sessionIdx,
              status: "failed",
              durationMs: Date.now() - attemptStartedAt,
              modelSource: modelId,
            });
            continue;
          }
          if (intent.kind === "provision") {
            const provisioned = await provisionAttemptSandbox({
              bearer,
              runId,
              targetId: targetId ?? hostId,
              sessionIdx,
              signal: sessionSignal,
            });
            if (provisioned.ok) {
              attemptSandbox = provisioned.sandbox;
            } else {
              // A provision cancelled by the RUN-LEVEL stop (shutdown, user
              // cancel, or another target's spend-cap short-circuit) is an
              // ABORT ARTIFACT, not this attempt's own failure. Leave the
              // attempt untouched and return — exactly what the
              // `stopScheduling()` early return and the worker catch do.
              // `finalizeRunPendingAttempts` sweeps `running` attempts as well
              // as `pending` ones, so the run-level finalizer classifies this
              // correctly (`rate_limited`/`spend_cap_exceeded` on a cap breach,
              // `runner_shutdown` on a cancel). Any terminal written here would
              // out-race that and record a misleading cause.
              if (provisioned.code === "aborted" || sessionSignal.aborted) {
                logEvent("attempt.provision_aborted", {
                  runId,
                  hostId,
                  targetId,
                  sessionIdx,
                });
                return;
              }
              // Otherwise the target asked for a REPRODUCIBLE shell and we
              // could not supply one. Running the session bash-less would be a
              // silent validity change — the degraded-but-green outcome is
              // harder to notice than a red one — so fail this attempt
              // honestly. The run continues; only this session is lost.
              logger.warn("[swarm.runner] sandbox provision failed", {
                runId,
                targetId,
                sessionIdx,
                code: provisioned.code,
                error: provisioned.message,
              });
              const failure = {
                status: "failed" as SwarmAttemptStatus,
                errorCode: provisioned.code,
                errorMessage: provisioned.message.slice(
                  0,
                  MAX_ATTEMPT_ERROR_CHARS
                ),
              };
              emit({
                type: "session_notice",
                kind: "tool_suppressed",
                toolId: sandboxConsumer.toolId,
                message: provisioned.message,
              });
              emit({
                type: "attempt_status",
                status: failure.status,
                errorMessage: failure.errorMessage,
              });
              await reportAttempt(convexHttpUrl, bearer, {
                projectId,
                runId,
                hostId,
                ...(targetId ? { targetId } : {}),
                sessionIdx,
                status: failure.status,
                chatSessionId,
                errorCode: failure.errorCode,
                errorMessage: failure.errorMessage,
              }).catch((err) => {
                logger.error(
                  "[swarm.runner] failed to report sandbox-failure terminal",
                  {
                    runId,
                    targetId,
                    sessionIdx,
                    error: err instanceof Error ? err.message : String(err),
                  }
                );
              });
              // Same terminal accounting as every other exit, so attempts that
              // died at provisioning aren't invisible to duration metrics.
              logEvent("attempt.finish", {
                runId,
                hostId,
                targetId,
                sessionIdx,
                status: failure.status,
                durationMs: Date.now() - attemptStartedAt,
                modelSource: modelId,
              });
              continue;
            }
          }
        }

        // PER-ATTEMPT harness gate. The target-level check above ruled out the
        // configurations that could never yield a box; this one is about the
        // box that was (or wasn't) actually produced for THIS attempt — the
        // data plane being unconfigured, or provisioning having been skipped.
        // A harness with no binding must never be handed to the shared core:
        // `runHarnessTurn` would fall back to reserving the launcher's shared
        // personal computer.
        const harnessBlockedReason = !harnessNeedsBox
          ? undefined
          : harnessTargetBlockedReason ??
            (attemptSandbox
              ? undefined
              : "This session could not get a disposable sandbox for its " +
                `${target.harness} harness. A swarm harness never falls back ` +
                "to the launcher's shared project computer, so this session " +
                "cannot run.");

        try {
          // Execute the session via the shared core. It owns manager lifecycle +
          // dispose, per-turn persona→drain→persist, browser/widget capture, and
          // failure classification, and NEVER throws (returns a SessionResult).
          // Because it persists per-turn and returns only after the last persist,
          // the transcript is durable before we report the terminal below.
          const sessionResult = await runSyntheticHostSession({
            runId,
            projectId,
            chatSessionId,
            maxTurns,
            runtime: {
              modelDefinition,
              systemPrompt: target.systemPrompt,
              temperature: target.temperature,
              requireToolApproval: target.requireToolApproval,
              respectToolVisibility: target.respectToolVisibility,
              progressiveToolDiscovery: target.progressiveToolDiscovery,
              builtInToolIds: target.builtInToolIds,
              modelVisibleMcpToolResults: target.modelVisibleMcpToolResults,
              mcpToolResultImageRendering: target.mcpToolResultImageRendering,
              computer: target.computer,
              harness: target.harness,
              // The trusted binding to THIS attempt's disposable box. It reaches
              // `resolveHostTools` on `ctx`, never on the host config, so nothing
              // in the (member-readable) run snapshot can forge one.
              ...(attemptSandbox
                ? { sandboxBinding: attemptSandbox.binding }
                : {}),
              // The SAME box, handed to the harness — which takes it on the
              // handler options rather than through `resolveHostTools`, because
              // `runHarnessTurn` does not use the tool resolver at all. Only
              // for a harness target: the emulated engine has no use for it.
              ...(target.harness && attemptSandbox
                ? {
                    harnessSandboxBinding: {
                      sandboxRowId: attemptSandbox.sandboxRowId,
                      ...attemptSandbox.binding,
                    },
                  }
                : {}),
              // F4: refuse the harness turn rather than let it reserve the
              // launcher's shared personal computer.
              ...(harnessBlockedReason ? { harnessBlockedReason } : {}),
              // Replaces the resolver's generic "swarms don't get bash" notice
              // with the actual configuration problem, frozen at launch.
              ...(bashUnavailableReason ? { bashUnavailableReason } : {}),
              // Authoritative pinned skills for env-based targets (undefined ⇒
              // legacy live-pool). The shared core routes them to prepareChatV2
              // (`skillsSource`) or the harness pinned path — never a live query.
              ...(pinnedSkills !== undefined ? { pinnedSkills } : {}),
              // The target's Project Environment — the GRANT BOUNDARY for its
              // project secrets, and the same id `resolveGrantForSandbox`
              // derives for this attempt's box from the run snapshot. Threaded
              // so a harness turn's BROKERED external-account credential is
              // checked against what THIS environment selects rather than
              // against the whole project. Absent for a legacy host target,
              // which has no environment and so no grant.
              ...(target.environmentRef?.environmentId
                ? { environmentId: target.environmentRef.environmentId }
                : {}),
              // Swarm authorizes via project membership — no scenario access
              // version, no scenario id.
            },
            authHeader: `Bearer ${bearer}`,
            // Each attempt gets a fresh manager + browser context, scoped to THIS
            // target's pinned required servers.
            managerFactory: () => managerFactory(target),
            // Thread the run-level stop signal (composed with shutdown/cancel) so a
            // spend-cap short-circuit cancels this host's in-flight turns.
            abortSignal: sessionSignal,
            nextPersonaTurn: (transcriptSoFar) =>
              swarmPersonaNextTurn(convexHttpUrl, sessionBearer, {
                projectId,
                runId,
                hostId,
                transcriptSoFar,
                // Forward the run-level stop (composed shutdown/cancel + spend-cap
                // runStop) so a short-circuit aborts a parked persona fetch
                // immediately and the session unwinds (instead of lingering up to
                // 120s in the persona call).
                signal: sessionSignal,
              }),
            persist: {
              sourceType: "swarm",
              origin: "swarm",
              journeyRunId: runId,
              hostId,
              ...(targetId ? { targetId } : {}),
              personaId: personaSnapshot.personaId,
              personaLabel: personaSnapshot.name,
            },
            emit,
            // Durable browser-artifact capture. The shared core drives the
            // outbox: per-turn takes + flushes, then the terminal
            // capture-before-teardown so the replay video is collected while
            // Chromium is still alive and uploaded once it isn't.
            browserArtifacts,
            // Per-turn MCP App widget-snapshot capture, same as the scenario
            // surface but through `createWidgetSnapshot`'s direct-session auth
            // branch (no scenarioId/accessVersion): the runner authenticates as
            // the run launcher, who owns every swarm session row, and each
            // snapshot carries its originating `serverId`. Without this the
            // Swarms session viewers have no `sharedChatWidgetSnapshots` rows
            // and MCP App tool calls collapse to plain pills. Best-effort — the
            // helper logs and swallows every failure.
            onTurnPersisted: async ({ messages, manager }) => {
              await captureAndPersistWidgetSnapshotsForSession({
                messages,
                mcpClientManager: manager,
                convexAuthToken: sessionBearer,
                chatSessionId,
                capturedToolCallIds: capturedWidgetToolCallIds,
              });
            },
          });
          const { outcome, errorMessage, errorReason } = sessionResult;

          // Report the terminal with the SAME chatSessionId ONLY after the
          // transcript is persisted. Best-effort: a terminal write failure is
          // logged and the host loop continues.
          //
          // Spend-cap abort reclassification: when the org spend cap tripped on
          // ANOTHER host, `runStop.abort()` cancels THIS host's in-flight turns and
          // the shared core returns `outcome: "failed"` — an abort artifact, not a
          // genuine session failure. Report those as the run-level terminal
          // (`rate_limited` / `spend_cap_exceeded`) so a cap breach isn't miscounted
          // as a generic `session_failed`. A session that genuinely SUCCEEDED, or
          // failed for its OWN reason before the cap (i.e. it returned while the
          // run-stop signal was NOT yet aborted), keeps its real outcome — we only
          // reclassify a `failed` outcome whose turns were actually cancelled by the
          // run-stop (`sessionSignal.aborted`).
          const abortedBySpendCap =
            spendCapTripped && outcome === "failed" && sessionSignal.aborted;
          const terminal = abortedBySpendCap
            ? {
                status: "rate_limited" as SwarmAttemptStatus,
                errorCode: "spend_cap_exceeded",
                ...(spendCapMessage
                  ? {
                      errorMessage: spendCapMessage.slice(
                        0,
                        MAX_ATTEMPT_ERROR_CHARS
                      ),
                    }
                  : {}),
              }
            : terminalForOutcome(outcome, errorMessage, errorReason);
          emit({
            type: "attempt_status",
            status: terminal.status,
            ...(terminal.errorMessage
              ? { errorMessage: terminal.errorMessage }
              : {}),
          });
          try {
            await reportAttempt(convexHttpUrl, bearer, {
              projectId,
              runId,
              hostId,
              ...(targetId ? { targetId } : {}),
              sessionIdx,
              status: terminal.status,
              chatSessionId,
              ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
              ...(terminal.errorMessage
                ? { errorMessage: terminal.errorMessage }
                : {}),
            });
          } catch (err) {
            logEvent("attempt.report_failed", {
              runId,
              hostId,
              targetId,
              sessionIdx,
              status: terminal.status,
            });
            logger.error("[swarm.runner] terminal attempt report failed", {
              runId,
              hostId,
              targetId,
              sessionIdx,
              status: terminal.status,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Deterministic rubric grading, AWAITED and non-fatal.
          //
          // Awaited, not fire-and-forget: the claim has to be durable before
          // this attempt's slot is reused, so a crash leaves a visible
          // `pending` rather than nothing. Non-fatal: a grading failure is
          // recorded on the session and never touches the attempt or the host
          // loop — the run's job is producing sessions, not grading them.
          //
          // Runs for BOTH `succeeded` and `failed` terminals. A failed session
          // is exactly where "no tool errors" and "fewer than N turns" earn
          // their keep; grading only the happy path would blind the scorecard
          // to the sessions worth looking at. Skipped only when the run has no
          // rubric or when there is no session to read a transcript from —
          // a `rate_limited` attempt never produced one.
          if (hasRubric && terminal.status !== "rate_limited") {
            try {
              const graded = await runSwarmChecks({
                convexHttpUrl,
                bearer,
                projectId,
                runId,
                chatSessionId,
                // DELIBERATELY not `sessionSignal`. That signal aborts on
                // shutdown and on an org spend-cap trip anywhere in the run —
                // both of which can already be set by the time this line is
                // reached, since the session has finished and its terminal is
                // reported. Passing it would abort the CLAIM, leaving no
                // `pending` stamp at all, and a session with no stamp reads
                // downstream as "this run had no rubric". Grading is bounded by
                // its own per-request timeout, so an unsignalled call cannot
                // hold shutdown open.
              });
              if (graded.status === "failed") {
                logger.warn("[swarm.runner] rubric grading failed", {
                  runId,
                  hostId,
                  targetId,
                  sessionIdx,
                  error: graded.error,
                });
              }
            } catch (err) {
              logEvent("attempt.checks_failed", {
                runId,
                hostId,
                targetId,
                sessionIdx,
              });
              logger.error("[swarm.runner] rubric grading threw", {
                runId,
                hostId,
                targetId,
                sessionIdx,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          logEvent("attempt.finish", {
            runId,
            hostId,
            targetId,
            sessionIdx,
            status: terminal.status,
            durationMs: Date.now() - attemptStartedAt,
            modelSource: modelId,
          });

          if (outcome === "rate_limited") {
            const cause = classifyRateLimit(errorMessage);
            if (cause === "org_spend_cap") {
              // WHOLE-RUN stop: halt all hosts + cancel in-flight turns. The
              // finalize sweep runs once the pool drains.
              spendCapTripped = true;
              // Humanized at assignment: this string reaches BOTH the
              // per-attempt terminal and the whole-run finalize sweep, and
              // `classifyRateLimit` above has already read the raw form.
              spendCapMessage = errorMessage
                ? humanizeSwarmAttemptErrorMessage(errorMessage)
                : undefined;
              runStop.abort();
              logEvent("run.spend_cap_short_circuit", {
                runId,
                hostId,
                targetId,
                sessionIdx,
              });
              return;
            }
            // PROVIDER rate-limit: stop THIS target's remaining sessions and mark
            // them rate_limited. Other targets keep running.
            logEvent("target.rate_limit_short_circuit", {
              runId,
              hostId,
              targetId,
              fromSessionIdx: sessionIdx + 1,
              remaining: sessionsPerTarget - (sessionIdx + 1),
            });
            await markRemainingTargetAttemptsRateLimited(
              { convexHttpUrl, bearer, projectId, runId, target },
              sessionIdx + 1,
              sessionsPerTarget
            );
            return;
          }
        } finally {
          // Release the attempt's box on EVERY exit — success, session error,
          // an early `return` from a rate-limit short-circuit, and a run-level
          // abort. A leaked box costs money until the GC cron reaps it, so
          // this must not be conditional on how the session ended.
          if (attemptSandbox) {
            await releaseAttemptSandbox(attemptSandbox.sandboxRowId);
          }
        }
      }
    } catch (err) {
      // A worker-level throw (a model-less pinned spec whose modelId can't
      // resolve, or a pinned-skill body that could not be fetched/verified)
      // must NOT abort the pool or leave this target's attempts dangling.
      // Finalize this target's not-yet-terminal attempts (`[sessionIdx..N)` —
      // the in-flight claim, if any, plus every never-claimed pending) as
      // `failed` and let the OTHER workers keep running (the pool continues;
      // the run ends consistently). Best-effort; the stale-run cron backstops
      // anything missed.
      //
      // EXCEPT on abort: a shutdown/cancel or spend-cap short-circuit can
      // cancel an in-flight pinned-skill prefetch, which throws here for a
      // reason that is NOT this target's fault. Claiming those attempts
      // `host_worker_failed` would out-race the run-level finalizer and stamp
      // a misleading terminal on a cancelled run. Leave them `pending` and let
      // `finalizeRun` (or the spend-cap path) classify them — the same
      // reasoning as the `stopScheduling()` early return in the session loop.
      if (sessionSignal.aborted) {
        logEvent("target.worker_aborted", {
          runId,
          hostId,
          targetId,
          sessionIdx,
        });
        logger.info(
          "[swarm.runner] target worker aborted; leaving attempts for run-level finalize",
          {
            runId,
            hostId,
            targetId,
            sessionIdx,
            error: err instanceof Error ? err.message : String(err),
          }
        );
        return;
      }
      logEvent("target.worker_failed", { runId, hostId, targetId, sessionIdx });
      logger.error(
        "[swarm.runner] target worker failed; finalizing its attempts",
        {
          runId,
          hostId,
          targetId,
          sessionIdx,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      // Finalize this target's not-yet-terminal attempts `[sessionIdx..N)`: the
      // sweep re-claims the in-flight attempt (if the throw landed after a
      // claim; an idempotent re-claim with the same chatSessionId) and every
      // never-claimed pending, reporting each `failed`.
      //
      // `bearer` is undefined only when the failure WAS the initial mint, so
      // try once more — a transient mint failure should not also cost us the
      // cleanup. If that fails too there is no credential to write with; say so
      // rather than throwing out of the catch, which would take the worker (and
      // with it the other targets and the run-level finalize) down. The
      // stale-run cron is the backstop for what stays pending.
      const cleanupBearer = bearer ?? (await getBearer().catch(() => undefined));
      if (!cleanupBearer) {
        logger.error(
          "[swarm.runner] no credential to finalize this target's attempts; leaving them for the stale-run sweep",
          { runId, hostId, targetId, sessionIdx }
        );
        return;
      }
      await markRemainingTargetAttemptsFailed(
        { convexHttpUrl, bearer: cleanupBearer, projectId, runId, target },
        sessionIdx,
        sessionsPerTarget
      );
    }
  };

  try {
    // Bounded worker pool: a shared target queue drained by
    // ≤MAX_CONCURRENT_TARGETS workers. Each worker pulls the next target, runs
    // it to completion (or its per-target short-circuit), then pulls the next —
    // so no more than N targets are ever active at once, and a slow target
    // doesn't block others.
    const targetQueue = [...hosts];
    const workerCount = Math.min(MAX_CONCURRENT_TARGETS, targetQueue.length);
    const worker = async (): Promise<void> => {
      while (!stopScheduling()) {
        const target = targetQueue.shift();
        if (!target) return;
        await runTarget(target);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Run-level finalize of any still-pending attempts.
    //
    // Run-LEVEL: every target has already finished, so the last per-session
    // mint could be arbitrarily old. Re-resolve, or a long run's cleanup fails
    // exactly when it is needed.
    //
    // A mint failure here must not be silent. Resolving inline in the argument
    // list would throw into the outer catch, which logs "journey run failed" —
    // true but useless, since the actual event is that a spend-cap or shutdown
    // finalize never ran and the attempts are still `pending`. Naming it makes
    // the operational signal match what happened.
    const finalizeTerminal = spendCapTripped
      ? {
          terminalStatus: "rate_limited" as const,
          errorCode: "spend_cap_exceeded",
          errorMessage: spendCapMessage,
        }
      : abortSignal?.aborted
        ? { errorCode: "runner_shutdown" }
        : undefined;
    if (finalizeTerminal) {
      const finalizeBearer = await getBearer().catch((error: unknown) => {
        logger.error(
          "[swarm.runner] could not mint a credential for the run-level finalize; attempts stay pending for the stale-run sweep",
          {
            runId,
            reason: finalizeTerminal.errorCode,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return undefined;
      });
      if (finalizeBearer) {
        await finalizeRun(
          { convexHttpUrl, bearer: finalizeBearer, projectId, runId },
          finalizeTerminal
        );
      }
    }
  } catch (error) {
    // Defensive: per-host/per-session work is already guarded, so this only
    // catches unexpected pool/heartbeat-adjacent failures.
    logger.error("[swarm.runner] journey run failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearInterval(heartbeat);
    logEvent("run.finish", {
      runId,
      targetCount: hosts.length,
      durationMs: Date.now() - runStartedAt,
      spendCapTripped,
      aborted: abortSignal?.aborted === true,
    });
  }
}

/**
 * Resolve a target's pinned skill BODIES (Project Environments, D3).
 *
 * Returns `undefined` for a legacy host target (live whole-pool semantics
 * downstream) and the authoritative artifact array — possibly EMPTY, meaning
 * deliberately skill-less — for an env-based target. Env-ness keys on the
 * first-class `environmentRef` (the opaque `targetId` is never parsed);
 * a `pinnedSkills` array on ANY target is also treated as authoritative.
 *
 * FAIL-CLOSED cases (throw → the worker-catch finalizes the target `failed`):
 *   - a pinned entry's body can't be fetched (persistent network/5xx), 404s,
 *     or fails hash verification — never a silent skill-less run;
 *   - the snapshot carries a non-empty host `skillSelection` but the pinned
 *     union carries NO channel provenance (pre-P0.2 backend), carries no
 *     `host`-tagged entry at all, or (when every entry is id-identified) omits
 *     one of the selected skill ids — each would silently drop part or all of
 *     the host skill channel;
 *   - a target with pinned metadata but no `targetId` (backend invariant
 *     violation — the fetch route requires it).
 *
 * Bodies are content-addressed and cached process-wide (`pinned-skill-cache`),
 * with in-flight coalescing across targets and bounded retries.
 */
async function resolveTargetPinnedSkills(args: {
  target: PinnedHostExecutionSpec;
  projectId: string;
  runId: string;
  convexHttpUrl: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<PinnedSkillArtifact[] | undefined> {
  const { target, projectId, runId, convexHttpUrl, bearer, signal } = args;
  const isEnvTarget = Boolean(target.environmentRef);
  if (!isEnvTarget && target.pinnedSkills === undefined) {
    return undefined; // legacy live-pool semantics
  }
  const meta: PinnedSkillMeta[] = target.pinnedSkills ?? [];

  // P0.2 guard: a host-carried skillSelection MUST be represented in the
  // pinned union (per-entry `channels` provenance proves the union is the
  // authoritative two-channel composition). Never silently ignore it.
  const hostSelection = target.skillSelection;
  const hostWantsSkills =
    !!hostSelection &&
    Array.isArray(hostSelection.skillIds) &&
    hostSelection.skillIds.length > 0;
  const unionIsAuthoritative = meta.some(
    (m) => Array.isArray(m.channels) && m.channels.length > 0
  );
  if (hostWantsSkills && !unionIsAuthoritative) {
    throw new Error(
      "Snapshot target carries a host skillSelection but its pinnedSkills " +
        "union has no channel provenance (pre-P0.2 backend) — refusing to run " +
        "with a silently dropped host skill channel"
    );
  }
  // Provenance EXISTING is not the same as the host channel being present: a
  // union tagged entirely `['environment']` also passes the check above while
  // dropping every host skill. Require an actual host-channel entry.
  if (hostWantsSkills && !meta.some((m) => m.channels?.includes("host"))) {
    throw new Error(
      "Snapshot target carries a host skillSelection but no pinned entry is " +
        "tagged with the `host` channel — refusing to run with a silently " +
        "dropped host skill channel"
    );
  }
  // Stronger check when the union is fully identified: every host-selected id
  // must appear. `skillId` is OPTIONAL (a snapshot survives the underlying
  // skill being hard-deleted, and the join key is `contentHash`), so only
  // assert this when EVERY entry carries one — otherwise an absent id is
  // indistinguishable from a dropped one and we'd fail closed on a legitimate
  // historical snapshot.
  if (hostWantsSkills && meta.length > 0 && meta.every((m) => !!m.skillId)) {
    const pinnedSkillIds = new Set(meta.map((m) => m.skillId));
    const missing = hostSelection!.skillIds.filter(
      (id) => !pinnedSkillIds.has(id)
    );
    if (missing.length > 0) {
      throw new Error(
        `Snapshot target's host skillSelection is not represented in its ` +
          `pinnedSkills union (missing ${missing.length} of ${
            hostSelection!.skillIds.length
          }) — refusing to run with a partially dropped host skill channel`
      );
    }
  }

  // Env targets MUST carry a targetId for per-target claim/report attribution,
  // even when they pin NO skills — otherwise the target reaches attempt claim
  // with host-only identity and is misattributed (or rejected by the
  // target-aware backend). Enforce before the skill-less early return; legacy
  // host-only targets legitimately omit it.
  if (isEnvTarget && !target.targetId) {
    throw new Error(
      "Environment snapshot target has no targetId — refusing to run with " +
        "host-only identity (per-target attribution would be lost)"
    );
  }

  if (meta.length === 0) return [];
  const targetId = target.targetId;
  if (!targetId) {
    throw new Error(
      "Snapshot target has pinned skills but no targetId — cannot fetch pinned bodies"
    );
  }

  const artifacts: PinnedSkillArtifact[] = [];
  for (const entry of meta) {
    const artifact = await resolvePinnedSkillCached({
      projectId,
      contentHash: entry.contentHash,
      // Caller-agnostic: the shared fetch keeps only its own request timeout, so
      // this run's cancellation can't fail another run coalesced on the same
      // body. THIS caller's `signal` detaches its own await below instead.
      fetcher: () =>
        fetchPinnedSkill(convexHttpUrl, bearer, {
          projectId,
          runId,
          targetId,
          contentHash: entry.contentHash,
        }),
      ...(signal ? { signal } : {}),
    });
    // Preserve the snapshot's channel provenance when the served artifact
    // doesn't carry it (the cache is keyed by content, not by target).
    artifacts.push({
      ...artifact,
      ...(artifact.channels === undefined && entry.channels !== undefined
        ? { channels: entry.channels }
        : {}),
    });
  }
  return artifacts;
}

/**
 * Mark a rate-limited target's remaining `pending` attempts (`[fromIdx, toIdx)`)
 * as `rate_limited`. The backend `finalize-pending` is whole-run scoped (no
 * target dimension), so we walk the target's own attempts via the reportAttempt
 * state machine: claim (`running` + the deterministic chatSessionId) then
 * report the terminal. Entirely best-effort — a failure here is logged and the
 * sweep continues; the backend stale-run cron backstops anything missed.
 */
async function markRemainingTargetAttemptsRateLimited(
  ctx: {
    convexHttpUrl: string;
    bearer: string;
    projectId: string;
    runId: string;
    target: PinnedHostExecutionSpec;
  },
  fromIdx: number,
  toIdx: number
): Promise<void> {
  const { convexHttpUrl, bearer, projectId, runId, target } = ctx;
  const { hostId, targetId } = target;
  for (let sessionIdx = fromIdx; sessionIdx < toIdx; sessionIdx++) {
    const chatSessionId = swarmAttemptChatSessionId(
      runId,
      targetSessionIdentity(target),
      sessionIdx
    );
    try {
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        ...(targetId ? { targetId } : {}),
        sessionIdx,
        status: "running",
        chatSessionId,
      });
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        ...(targetId ? { targetId } : {}),
        sessionIdx,
        status: "rate_limited",
        chatSessionId,
        errorCode: "rate_limited",
      });
    } catch (err) {
      logger.warn(
        "[swarm.runner] failed to mark remaining target attempt rate_limited",
        {
          runId,
          hostId,
          targetId,
          sessionIdx,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }
}

/**
 * Mark a failed target-worker's not-yet-terminal attempts (`[fromIdx, toIdx)`)
 * as `failed` (errorCode `host_worker_failed` — kept for backend/dashboard
 * compat). Sibling of {@link markRemainingTargetAttemptsRateLimited}: walk the
 * target's own attempts via the reportAttempt state machine (claim `running` +
 * the deterministic chatSessionId, then report the terminal). Re-claiming an
 * already-claimed `running` attempt with the SAME chatSessionId is idempotent;
 * an already `succeeded`/`failed` attempt rejects the re-claim (terminal is
 * immutable) and is skipped. Entirely best-effort — a failure is logged and the
 * sweep continues; the backend stale-run cron backstops anything missed.
 */
async function markRemainingTargetAttemptsFailed(
  ctx: {
    convexHttpUrl: string;
    bearer: string;
    projectId: string;
    runId: string;
    target: PinnedHostExecutionSpec;
  },
  fromIdx: number,
  toIdx: number
): Promise<void> {
  const { convexHttpUrl, bearer, projectId, runId, target } = ctx;
  const { hostId, targetId } = target;
  for (let sessionIdx = fromIdx; sessionIdx < toIdx; sessionIdx++) {
    const chatSessionId = swarmAttemptChatSessionId(
      runId,
      targetSessionIdentity(target),
      sessionIdx
    );
    try {
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        ...(targetId ? { targetId } : {}),
        sessionIdx,
        status: "running",
        chatSessionId,
      });
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        ...(targetId ? { targetId } : {}),
        sessionIdx,
        status: "failed",
        chatSessionId,
        errorCode: "host_worker_failed",
      });
    } catch (err) {
      logger.warn(
        "[swarm.runner] failed to mark remaining target attempt failed",
        {
          runId,
          hostId,
          targetId,
          sessionIdx,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }
}

/** Best-effort whole-run finalize; logs and swallows any failure. */
async function finalizeRun(
  ctx: {
    convexHttpUrl: string;
    bearer: string;
    projectId: string;
    runId: string;
  },
  args: {
    terminalStatus?: Exclude<SwarmAttemptStatus, "pending" | "running">;
    errorCode?: string;
    errorMessage?: string;
  }
): Promise<void> {
  try {
    await finalizePendingAttempts(ctx.convexHttpUrl, ctx.bearer, {
      projectId: ctx.projectId,
      runId: ctx.runId,
      ...args,
    });
    logEvent("run.finalize_pending", {
      runId: ctx.runId,
      errorCode: args.errorCode,
    });
  } catch (err) {
    logger.warn("[swarm.runner] finalize-pending failed", {
      runId: ctx.runId,
      errorCode: args.errorCode,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
