import { logger } from "../../utils/logger.js";
import { buildSyntheticModelDefinition } from "../../utils/org-model-config.js";
import {
  runSyntheticHostSession,
  type SimulationManagerFactory,
} from "./runner.js";
import {
  heartbeatJourneyRun,
  reportAttempt,
  swarmPersonaNextTurn,
  type PersonaSnapshot,
  type PinnedHostExecutionSpec,
  type SwarmAttemptStatus,
} from "../swarm-agent.js";

/**
 * Swarm (journey-execution) single-host runner — PR 3c.
 *
 * Executes `sessionsPerHost` synthetic persona-driven sessions against ONE
 * pinned host and reports each attempt through the backend runner-control API.
 * The per-session host-turn machinery is the shared {@link runSyntheticHostSession}
 * core (identical to chatbox session-simulation); this file owns the swarm
 * surface: the claim→run→persist→terminal attempt ordering, the swarm persona
 * driver, swarm transcript attribution, an independent heartbeat, and graceful
 * shutdown registration.
 *
 * Fan-out across multiple hosts is deliberately OUT OF SCOPE (PR 3d) — the
 * launch route caps the run to a single host via `maxHosts: 1`.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_ATTEMPT_ERROR_CHARS = 500;

export interface StartJourneyRunOptions {
  runId: string;
  projectId: string;
  /** The single pinned host this run executes against (`snapshot.hosts[0]`). */
  host: PinnedHostExecutionSpec;
  personaSnapshot: PersonaSnapshot;
  sessionsPerHost: number;
  maxTurns: number;
  convexHttpUrl: string;
  /** Launching member's bearer TOKEN for `/journey-execution/*` calls. */
  bearer: string;
  /** Full `Authorization` header (`Bearer …`) for the drain + transcript persist. */
  authHeader: string;
  /** Builds a fresh connected manager scoped to the pinned `serverIds`. */
  managerFactory: SimulationManagerFactory;
  /** Aborts the run mid-batch on inspector shutdown. */
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
 * `finally` (which stops the heartbeat and lets any in-flight session report a
 * terminal attempt) up to `timeoutMs`.
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
 * Register the run for graceful shutdown, execute the single-host loop, and
 * clear the registry on completion. Fire-and-forget from the route (via
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
    await runJourneySingleHost({ ...opts, abortSignal: composed });
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

async function runJourneySingleHost(
  opts: StartJourneyRunOptions
): Promise<void> {
  const {
    runId,
    projectId,
    host,
    personaSnapshot,
    sessionsPerHost,
    maxTurns,
    convexHttpUrl,
    bearer,
    authHeader,
    managerFactory,
    abortSignal,
  } = opts;
  const hostId = host.hostId;

  // Resolve the pinned host's modelId to a ModelDefinition (catalog hits pass
  // through; BYOK shapes get a derived provider). NEVER refetch the live host
  // config — everything comes from the immutable snapshot.
  const modelDefinition = buildSyntheticModelDefinition(host.modelId);

  // Independent heartbeat: an interval timer (NOT gated on turn/attempt
  // completion) started before the first attempt and stopped in `finally`.
  // Single-flight so a slow heartbeat can't stack.
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

  // On shutdown/abort the run's `abortSignal` is forwarded into BOTH the shared
  // core's turn drain AND the persona driver (`swarmPersonaNextTurn`, below), so
  // the one place a session could previously park uncancellably for up to 120s
  // is now cancellable. A shutdown/cancel therefore unwinds every in-flight
  // session promptly, and each reports its OWN accurate terminal via the normal
  // path below (`failed` for an interrupted session, or its real outcome if it
  // finished first) — with the transcript already persisted. There is no eager
  // per-attempt abort report to race that normal terminal, so no session is
  // misclassified on shutdown. The backend stale-run cron remains the hard
  // backstop for anything that still can't unwind.

  try {
    for (let sessionIdx = 0; sessionIdx < sessionsPerHost; sessionIdx++) {
      if (abortSignal?.aborted) break;

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

      // Execute the session via the shared core. It owns manager lifecycle +
      // dispose, per-turn persona→drain→persist, browser/widget capture, and
      // failure classification, and NEVER throws (returns a SessionResult).
      // Because it persists per-turn and returns only after the last persist
      // (or the empty-session persist), the transcript is durable before we
      // report the terminal below — the persist-before-terminal invariant.
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
        managerFactory,
        abortSignal,
        nextPersonaTurn: (transcriptSoFar) =>
          swarmPersonaNextTurn(convexHttpUrl, bearer, {
            projectId,
            runId,
            hostId,
            transcriptSoFar,
            // Forward the run abort so a shutdown/cancel aborts a parked persona
            // fetch immediately and the session unwinds (instead of lingering up
            // to 120s in the persona call).
            ...(abortSignal ? { signal: abortSignal } : {}),
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
      // logged and the batch continues with the remaining sessions.
      const terminal = terminalForOutcome(outcome, errorMessage);
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
        logger.error("[swarm.runner] terminal attempt report failed", {
          runId,
          hostId,
          sessionIdx,
          status: terminal.status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (error) {
    // Defensive: the loop's per-session work is already guarded, so this only
    // catches unexpected setup/heartbeat-adjacent failures.
    logger.error("[swarm.runner] journey run failed", {
      runId,
      hostId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearInterval(heartbeat);
  }
}
