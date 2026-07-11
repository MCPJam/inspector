import { logger } from "../../utils/logger.js";
import { buildSyntheticModelDefinition } from "../../utils/org-model-config.js";
import {
  runSyntheticHostSession,
  type SimulationManagerFactory,
} from "./runner.js";
import {
  finalizePendingAttempts,
  heartbeatJourneyRun,
  reportAttempt,
  swarmPersonaNextTurn,
  type PersonaSnapshot,
  type PinnedHostExecutionSpec,
  type SwarmAttemptStatus,
} from "../swarm-agent.js";

/**
 * Swarm (journey-execution) multi-host fan-out runner — PR 3d.
 *
 * Generalizes the PR-3c single-host runner to a bounded host-worker pool over
 * `snapshot.hosts[]`. Each host runs its `sessionsPerHost` synthetic
 * persona-driven sessions SEQUENTIALLY (one active session per host); at most
 * {@link MAX_CONCURRENT_HOSTS} hosts are active concurrently. The per-session
 * host-turn machinery is the shared {@link runSyntheticHostSession} core
 * (identical to chatbox session-simulation); this file owns the swarm surface:
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
const MAX_ATTEMPT_ERROR_CHARS = 500;
/** Bounded host-worker pool: at most this many hosts run concurrently. */
export const MAX_CONCURRENT_HOSTS = 3;

/**
 * Builds a fresh, fully-connected manager scoped to one pinned host's
 * `serverIds`. Host-aware (unlike the chatbox {@link SimulationManagerFactory})
 * so a single fan-out run can connect different servers per host.
 */
export type JourneyManagerFactory = (
  host: PinnedHostExecutionSpec
) => Promise<{
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
  sessionsPerHost: number;
  maxTurns: number;
  convexHttpUrl: string;
  /** Launching member's bearer TOKEN for `/journey-execution/*` calls. */
  bearer: string;
  /** Full `Authorization` header (`Bearer …`) for the drain + transcript persist. */
  authHeader: string;
  /** Builds a fresh connected manager scoped to one host's `serverIds`. */
  managerFactory: JourneyManagerFactory;
  /** Aborts the run mid-fan-out on inspector shutdown / user cancel. */
  abortSignal?: AbortSignal;
}

interface RunningJourneyHandle {
  abort: () => void;
  /** Resolves when the run loop's `finally` has cleared the registry. */
  done: Promise<void>;
}

const runningJourneyRuns = new Map<string, RunningJourneyHandle>();

export function getRunningJourneyRunCount(): number {
  return runningJourneyRuns.size;
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
  runningJourneyRuns.set(opts.runId, {
    abort: () => controller.abort(),
    done,
  });
  try {
    await runJourneyFanOut({ ...opts, abortSignal: composed });
  } finally {
    runningJourneyRuns.delete(opts.runId);
    resolveDone();
  }
}

/** Map a shared-core session outcome to the attempt terminal state + error. */
function terminalForOutcome(
  outcome: "succeeded" | "failed" | "rate_limited",
  errorMessage: string | undefined
): { status: SwarmAttemptStatus; errorCode?: string; errorMessage?: string } {
  if (outcome === "succeeded") {
    return { status: "succeeded" };
  }
  const safeMessage = errorMessage?.slice(0, MAX_ATTEMPT_ERROR_CHARS);
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
    errorCode: "session_failed",
    ...(safeMessage ? { errorMessage: safeMessage } : {}),
  };
}

/**
 * Distinguish an ORG spend-cap breach from a PROVIDER rate-limit within the
 * shared core's `rate_limited` bucket (both fold there via `classifyTurnFailure`).
 * A spend/cap/quota/budget message is the org cap (WHOLE-RUN stop); anything
 * else (a provider 429 / rate limit) is a per-HOST stop. A missing message
 * defaults to the narrower per-host stop — never escalate to a whole-run halt
 * on ambiguous signal.
 *
 * `cap`/`quota`/`budget` are word-anchored so only genuine spend-cap wording
 * matches: "spend cap exceeded" / "quota exceeded" / "budget exhausted" →
 * org cap, but "capacity" / "rate capacity exceeded" / "recap" / "escape" →
 * NOT a spend cap (they stay a per-host provider rate-limit).
 */
function classifyRateLimit(
  message: string | undefined
): "org_spend_cap" | "provider_rate_limit" {
  if (message && /spend|\bcap\b|\bquota\b|\bbudget\b/i.test(message)) {
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

async function runJourneyFanOut(
  opts: StartJourneyRunOptions
): Promise<void> {
  const {
    runId,
    projectId,
    hosts,
    personaSnapshot,
    sessionsPerHost,
    maxTurns,
    convexHttpUrl,
    bearer,
    authHeader,
    managerFactory,
    abortSignal,
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
    heartbeatJourneyRun(convexHttpUrl, bearer, { projectId, runId })
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
    hostCount: hosts.length,
    sessionsPerHost,
    maxTurns,
    maxConcurrentHosts: Math.min(MAX_CONCURRENT_HOSTS, hosts.length),
  });

  // --- Run one host's sessions SEQUENTIALLY --------------------------------
  const runHost = async (host: PinnedHostExecutionSpec): Promise<void> => {
    const hostId = host.hostId;
    const modelId = host.modelId;
    // Hoisted so the worker-level catch below knows how far this host got and
    // can finalize the attempts it left behind.
    let sessionIdx = 0;
    try {
    // Resolve the pinned host's modelId to a ModelDefinition once per host
    // (catalog hits pass through; BYOK shapes get a derived provider). NEVER
    // refetch the live host config — everything comes from the immutable
    // snapshot. A model-less / unresolvable pinned spec throws HERE, before any
    // attempt is claimed — the catch finalizes this host's pending attempts.
    const modelDefinition = buildSyntheticModelDefinition(modelId);

    for (sessionIdx = 0; sessionIdx < sessionsPerHost; sessionIdx++) {
      // Run-level stop (spend cap or shutdown/cancel) halts THIS host too.
      if (stopScheduling()) return;

      // Deterministic claim key — the immutable chatSessionId the attempt is
      // claimed with and every persist + terminal reuse.
      const chatSessionId = `synth_${runId}_${hostId}_${sessionIdx}`;

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
          sessionIdx,
          status: "running",
          chatSessionId,
        });
      } catch (err) {
        logger.error("[swarm.runner] attempt claim failed; skipping session", {
          runId,
          hostId,
          sessionIdx,
          error: err instanceof Error ? err.message : String(err),
        });
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
      logEvent("attempt.start", { runId, hostId, sessionIdx, modelId });

      // Execute the session via the shared core. It owns manager lifecycle +
      // dispose, per-turn persona→drain→persist, browser/widget capture, and
      // failure classification, and NEVER throws (returns a SessionResult).
      // Because it persists per-turn and returns only after the last persist,
      // the transcript is durable before we report the terminal below.
      const { outcome, errorMessage } = await runSyntheticHostSession({
        runId,
        projectId,
        chatSessionId,
        maxTurns,
        runtime: {
          modelDefinition,
          systemPrompt: host.systemPrompt,
          temperature: host.temperature,
          requireToolApproval: host.requireToolApproval,
          respectToolVisibility: host.respectToolVisibility,
          progressiveToolDiscovery: host.progressiveToolDiscovery,
          builtInToolIds: host.builtInToolIds,
          modelVisibleMcpToolResults: host.modelVisibleMcpToolResults,
          mcpToolResultImageRendering: host.mcpToolResultImageRendering,
          computer: host.computer,
          harness: host.harness,
          // Swarm authorizes via project membership — no chatbox access
          // version, no chatbox id.
        },
        authHeader,
        // Each attempt gets a fresh manager + browser context, scoped to THIS
        // host's pinned required servers.
        managerFactory: () => managerFactory(host),
        // Thread the run-level stop signal (composed with shutdown/cancel) so a
        // spend-cap short-circuit cancels this host's in-flight turns.
        abortSignal: sessionSignal,
        nextPersonaTurn: (transcriptSoFar) =>
          swarmPersonaNextTurn(convexHttpUrl, bearer, {
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
          personaId: personaSnapshot.personaId,
          personaLabel: personaSnapshot.name,
        },
        // No chatbox-scoped side-persistence on the swarm surface (widget /
        // browser-artifact rows are keyed by chatboxId, which swarm has none).
      });

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
        : terminalForOutcome(outcome, errorMessage);
      try {
        await reportAttempt(convexHttpUrl, bearer, {
          projectId,
          runId,
          hostId,
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
          sessionIdx,
          status: terminal.status,
        });
        logger.error("[swarm.runner] terminal attempt report failed", {
          runId,
          hostId,
          sessionIdx,
          status: terminal.status,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logEvent("attempt.finish", {
        runId,
        hostId,
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
          spendCapMessage = errorMessage;
          runStop.abort();
          logEvent("run.spend_cap_short_circuit", {
            runId,
            hostId,
            sessionIdx,
          });
          return;
        }
        // PROVIDER rate-limit: stop THIS host's remaining sessions and mark
        // them rate_limited. Other hosts keep running.
        logEvent("host.rate_limit_short_circuit", {
          runId,
          hostId,
          fromSessionIdx: sessionIdx + 1,
          remaining: sessionsPerHost - (sessionIdx + 1),
        });
        await markRemainingHostAttemptsRateLimited(
          { convexHttpUrl, bearer, projectId, runId, hostId },
          sessionIdx + 1,
          sessionsPerHost
        );
        return;
      }
    }
    } catch (err) {
      // A worker-level throw (e.g. a model-less pinned spec whose modelId can't
      // resolve) must NOT abort the pool or leave this host's attempts dangling.
      // Finalize this host's not-yet-terminal attempts (`[sessionIdx..N)` — the
      // in-flight claim, if any, plus every never-claimed pending) as `failed`
      // and let the OTHER workers keep running (the pool continues; the run ends
      // consistently). Best-effort; the stale-run cron backstops anything missed.
      logEvent("host.worker_failed", { runId, hostId, sessionIdx });
      logger.error(
        "[swarm.runner] host worker failed; finalizing its attempts",
        {
          runId,
          hostId,
          sessionIdx,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      // Finalize this host's not-yet-terminal attempts `[sessionIdx..N)`: the
      // sweep re-claims the in-flight attempt (if the throw landed after a
      // claim; an idempotent re-claim with the same chatSessionId) and every
      // never-claimed pending, reporting each `failed`.
      await markRemainingHostAttemptsFailed(
        { convexHttpUrl, bearer, projectId, runId, hostId },
        sessionIdx,
        sessionsPerHost
      );
    }
  };

  try {
    // Bounded worker pool: a shared host queue drained by ≤MAX_CONCURRENT_HOSTS
    // workers. Each worker pulls the next host, runs it to completion (or its
    // per-host short-circuit), then pulls the next — so no more than N hosts
    // are ever active at once, and a slow host doesn't block others.
    const hostQueue = [...hosts];
    const workerCount = Math.min(MAX_CONCURRENT_HOSTS, hostQueue.length);
    const worker = async (): Promise<void> => {
      while (!stopScheduling()) {
        const host = hostQueue.shift();
        if (!host) return;
        await runHost(host);
      }
    };
    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );

    // Run-level finalize of any still-pending attempts.
    if (spendCapTripped) {
      await finalizeRun(
        { convexHttpUrl, bearer, projectId, runId },
        {
          terminalStatus: "rate_limited",
          errorCode: "spend_cap_exceeded",
          errorMessage: spendCapMessage,
        }
      );
    } else if (abortSignal?.aborted) {
      await finalizeRun(
        { convexHttpUrl, bearer, projectId, runId },
        { errorCode: "runner_shutdown" }
      );
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
      hostCount: hosts.length,
      durationMs: Date.now() - runStartedAt,
      spendCapTripped,
      aborted: abortSignal?.aborted === true,
    });
  }
}

/**
 * Mark a rate-limited host's remaining `pending` attempts (`[fromIdx, toIdx)`)
 * as `rate_limited`. The backend `finalize-pending` is whole-run scoped (no
 * hostId), so we walk the host's own attempts via the reportAttempt state
 * machine: claim (`running` + the deterministic chatSessionId) then report the
 * terminal. Entirely best-effort — a failure here is logged and the sweep
 * continues; the backend stale-run cron backstops anything missed.
 */
async function markRemainingHostAttemptsRateLimited(
  ctx: {
    convexHttpUrl: string;
    bearer: string;
    projectId: string;
    runId: string;
    hostId: string;
  },
  fromIdx: number,
  toIdx: number
): Promise<void> {
  const { convexHttpUrl, bearer, projectId, runId, hostId } = ctx;
  for (let sessionIdx = fromIdx; sessionIdx < toIdx; sessionIdx++) {
    const chatSessionId = `synth_${runId}_${hostId}_${sessionIdx}`;
    try {
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        sessionIdx,
        status: "running",
        chatSessionId,
      });
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        sessionIdx,
        status: "rate_limited",
        chatSessionId,
        errorCode: "rate_limited",
      });
    } catch (err) {
      logger.warn(
        "[swarm.runner] failed to mark remaining host attempt rate_limited",
        {
          runId,
          hostId,
          sessionIdx,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }
}

/**
 * Mark a failed host-worker's not-yet-terminal attempts (`[fromIdx, toIdx)`)
 * as `failed` (errorCode `host_worker_failed`). Sibling of
 * {@link markRemainingHostAttemptsRateLimited}: walk the host's own attempts
 * via the reportAttempt state machine (claim `running` + the deterministic
 * chatSessionId, then report the terminal). Re-claiming an already-claimed
 * `running` attempt with the SAME chatSessionId is idempotent; an already
 * `succeeded`/`failed` attempt rejects the re-claim (terminal is immutable) and
 * is skipped. Entirely best-effort — a failure is logged and the sweep
 * continues; the backend stale-run cron backstops anything missed.
 */
async function markRemainingHostAttemptsFailed(
  ctx: {
    convexHttpUrl: string;
    bearer: string;
    projectId: string;
    runId: string;
    hostId: string;
  },
  fromIdx: number,
  toIdx: number
): Promise<void> {
  const { convexHttpUrl, bearer, projectId, runId, hostId } = ctx;
  for (let sessionIdx = fromIdx; sessionIdx < toIdx; sessionIdx++) {
    const chatSessionId = `synth_${runId}_${hostId}_${sessionIdx}`;
    try {
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        sessionIdx,
        status: "running",
        chatSessionId,
      });
      await reportAttempt(convexHttpUrl, bearer, {
        projectId,
        runId,
        hostId,
        sessionIdx,
        status: "failed",
        chatSessionId,
        errorCode: "host_worker_failed",
      });
    } catch (err) {
      logger.warn(
        "[swarm.runner] failed to mark remaining host attempt failed",
        {
          runId,
          hostId,
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
