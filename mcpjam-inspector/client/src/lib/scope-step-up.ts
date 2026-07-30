/**
 * SEP-2350 scope step-up lifecycle — the one place that decides what happens to
 * a `403 insufficient_scope` and to the bounded step-up budget.
 *
 * Every surface that calls an MCP primitive has the same two obligations:
 *
 * - **on failure**, drive a bounded union-scope re-authorization when the
 *   challenge is actionable; and
 * - **on success**, reset the budget, so a later legitimate step-up starts
 *   fresh instead of inheriting a spent count.
 *
 * Those obligations used to be re-implemented per surface, which is how the
 * agent-driven entry points on Prompts and Resources ended up calling the same
 * API as their on-screen buttons while silently skipping both halves. A missed
 * failure-drive dead-ends re-authorization; a missed success-reset is worse,
 * because it surfaces much later as "step-up stopped working" on a different
 * screen. {@link runWithScopeStepUp} exists so a caller cannot express the
 * operation without the lifecycle.
 *
 * The in-flight registry is deliberately **module-level**, not per-surface:
 * "one step-up at a time" is a property of the browser and of the server's
 * budget, not of a component. Two surfaces racing the same 403 (an on-screen
 * read and an agent-driven one, say) must produce one redirect, not two.
 */

import {
  insufficientScopeFromError,
  isActionableStepUpChallenge,
  parseInsufficientScopeChallenge,
  type InsufficientScopeChallenge,
} from "@/lib/apis/insufficient-scope";
import {
  applyToolCallStepUp,
  resetToolCallStepUp,
} from "@/state/oauth-orchestrator";
import {
  findProjectByAnyId,
  type AppState,
  type ServerWithName,
} from "@/state/app-types";

/**
 * Servers with a step-up in flight. Module-level so the dedup holds ACROSS
 * surfaces; keyed by server name, cleared when the attempt settles.
 */
const inFlight = new Set<string>();

/**
 * Resolve a stream/app event's server identifier against the same local and
 * project-scoped maps on every scope-step-up delivery path.
 *
 * The project goes through `findProjectByAnyId` because a hosted event's
 * `projectId` can be the Convex/shared id rather than the local key
 * `AppState.projects` is keyed by; a bare key lookup would miss the project
 * and dead-end the step-up for a server held only in the project map.
 */
export function resolveScopeStepUpServer(
  appState: AppState | null | undefined,
  input: {
    serverId: string;
    serverName?: string;
    projectId?: string | null;
  },
): ServerWithName | undefined {
  if (!appState) return undefined;
  const activeProject = findProjectByAnyId(
    appState.projects,
    input.projectId ?? appState.activeProjectId,
  );
  return (
    (input.serverName
      ? (appState.servers[input.serverName] ??
        activeProject?.servers[input.serverName])
      : undefined) ??
    appState.servers[input.serverId] ??
    activeProject?.servers[input.serverId]
  );
}

/**
 * How long a queued chat step-up will wait for its turn before authorizing
 * anyway. The wait exists to save the turn, not to gate authorization on it —
 * a model that never stops streaming must not be able to lock the user out of
 * re-authorizing.
 */
const CHAT_TURN_HOLD_TIMEOUT_MS = 15_000;

/**
 * Chat step-ups deferred until the current turn finishes and persists.
 *
 * A step-up redirect is a full-page navigation. Fired mid-stream it kills the
 * request the server persists the turn from, so the user comes back from the
 * authorization server to a transcript missing the very tool call that sent
 * them there. Holding the redirect until the stream ends is what makes the
 * failed call survive the round trip.
 *
 * Module-level for the same reason {@link inFlight} is: a turn's step-up can
 * arrive on more than one channel (the chat stream part, and — once the harness
 * work lands — an Inspector event handled at the app root). One shared hold
 * covers every channel; a component-local one would leave the others free to
 * redirect out from under the stream.
 */
type PendingChatStepUp = {
  server: ServerWithName;
  challenge: InsufficientScopeChallenge;
};
const pendingChatStepUps = new Map<string, PendingChatStepUp>();
let chatTurnHoldDepth = 0;
let holdTimeoutId: ReturnType<typeof setTimeout> | null = null;
/** Aborts the in-flight turn when the hold times out. Registered by the chat. */
let abortHeldChatTurn: (() => void) | null = null;

/** Test seam: no production caller should need this. */
export function __resetScopeStepUpInFlightForTests(): void {
  inFlight.clear();
  pendingChatStepUps.clear();
  chatTurnHoldDepth = 0;
  abortHeldChatTurn = null;
  if (holdTimeoutId !== null) {
    clearTimeout(holdTimeoutId);
    holdTimeoutId = null;
  }
}

function clearHoldTimeout(): void {
  if (holdTimeoutId === null) return;
  clearTimeout(holdTimeoutId);
  holdTimeoutId = null;
}

function flushPendingChatStepUps(): void {
  clearHoldTimeout();
  if (pendingChatStepUps.size === 0) return;
  const queued = [...pendingChatStepUps.values()];
  pendingChatStepUps.clear();
  for (const { server, challenge } of queued) {
    driveScopeStepUp(server, challenge);
  }
}

/**
 * Marks the start of a chat turn: step-ups raised from here on are queued
 * rather than redirected.
 *
 * @param onTimeout Stops the turn if the hold times out, so the redirect isn't
 *   waiting on a stream that will never end.
 */
export function beginChatTurnScopeStepUpHold(onTimeout?: () => void): void {
  chatTurnHoldDepth += 1;
  if (onTimeout) {
    abortHeldChatTurn = onTimeout;
  }
}

/**
 * Marks the end of a chat turn and releases anything queued during it.
 *
 * @param waitForPersist Resolves once the turn has been written server-side.
 *   Raced against a cap: persistence is best-effort here, and a slow write must
 *   delay the redirect, not cancel it.
 */
export function endChatTurnScopeStepUpHold(
  waitForPersist?: () => Promise<unknown>,
): void {
  if (chatTurnHoldDepth === 0) return;
  chatTurnHoldDepth -= 1;
  if (chatTurnHoldDepth > 0) return;

  abortHeldChatTurn = null;
  if (pendingChatStepUps.size === 0) {
    clearHoldTimeout();
    return;
  }
  if (!waitForPersist) {
    flushPendingChatStepUps();
    return;
  }
  void Promise.resolve()
    .then(waitForPersist)
    .catch(() => {
      // A failed persistence check is not a reason to withhold authorization.
    })
    .finally(() => {
      flushPendingChatStepUps();
    });
}

/**
 * {@link driveScopeStepUp} for a step-up raised by a chat turn.
 *
 * Outside a turn this is exactly {@link driveScopeStepUp}. Inside one the
 * challenge is queued — deduped by server, since the same 403 can reach the
 * browser by more than one route — and released when the turn ends.
 */
export function driveChatScopeStepUp(
  server: ServerWithName | undefined,
  challenge: InsufficientScopeChallenge | undefined,
): void {
  // Apply the same gates the immediate path does, up front: a chatbox /
  // share-link turn (no resolvable server) and a challenge with nothing to
  // widen must not hold a slot in the queue.
  if (!server) return;
  if (!isActionableStepUpChallenge(challenge)) return;
  if (chatTurnHoldDepth === 0) {
    driveScopeStepUp(server, challenge);
    return;
  }
  if (inFlight.has(server.name)) return;
  if (pendingChatStepUps.has(server.name)) return;
  pendingChatStepUps.set(server.name, { server, challenge });
  if (holdTimeoutId !== null) return;
  holdTimeoutId = setTimeout(() => {
    holdTimeoutId = null;
    // Stop the turn first: the redirect is about to discard it anyway, and
    // leaving the request open would keep streaming into a dead page.
    const abort = abortHeldChatTurn;
    abortHeldChatTurn = null;
    chatTurnHoldDepth = 0;
    try {
      abort?.();
    } catch {
      // A failed abort must not strand the queued authorization.
    }
    flushPendingChatStepUps();
  }, CHAT_TURN_HOLD_TIMEOUT_MS);
}

/**
 * Clears the bounded step-up counter after a successful operation.
 *
 * Best-effort by design: a failed reset must never mask the success that
 * triggered it.
 */
export function resetScopeStepUp(server: ServerWithName | undefined): void {
  if (!server) return;
  try {
    resetToolCallStepUp(server);
  } catch {
    // Best-effort: swallowed so a failed reset cannot mask the success that
    // triggered it. Logging is deliberately absent — this module is plain (the
    // app's logger is a hook) and every caller already surfaces its own error.
  }
}

/**
 * Drives the bounded union-scope re-authorization for an actionable challenge.
 *
 * Only a challenge naming a `requiredScope` (or a `resourceMetadataUrl` to
 * discover one) is worth a redirect — an `errorDescription`-only challenge
 * would consume the one-attempt budget with nothing to widen. On `reauthorize`
 * this redirects the browser; `throw` / `manual` leave the caller's surfaced
 * error in place, so callers keep reporting failures exactly as they do now.
 */
export function driveScopeStepUp(
  server: ServerWithName | undefined,
  challenge: InsufficientScopeChallenge | undefined,
): void {
  if (!server) return;
  if (!isActionableStepUpChallenge(challenge)) return;
  const key = server.name;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void applyToolCallStepUp(server, {
    requiredScope: challenge.requiredScope,
    resourceMetadataUrl: challenge.resourceMetadataUrl,
  })
    .catch(() => {
      // The operation's own error is already surfaced by the caller, so a
      // failed step-up has nothing further to report to the user.
    })
    .finally(() => {
      inFlight.delete(key);
    });
}

/** {@link driveScopeStepUp} for a thrown error (prompts, resources, …). */
export function driveScopeStepUpFromError(
  server: ServerWithName | undefined,
  error: unknown,
): void {
  driveScopeStepUp(server, insufficientScopeFromError(error));
}

/**
 * {@link driveScopeStepUp} for surfaces whose failure arrives as a field on a
 * RESULT object rather than as a throw (tool execution, the playground).
 */
export function driveScopeStepUpFromChallenge(
  server: ServerWithName | undefined,
  rawChallenge: unknown,
): void {
  driveScopeStepUp(server, parseInsufficientScopeChallenge(rawChallenge));
}

/**
 * Runs a promise-shaped MCP operation with the full lifecycle attached:
 * success resets the budget, a `403 insufficient_scope` drives the step-up, and
 * the error is re-thrown untouched so the caller's own handling is unchanged.
 *
 * This is the form every promise-shaped call site should use — including the
 * agent-driven ones. Wrapping the call is what makes the lifecycle impossible
 * to forget when a new entry point is added.
 */
export async function runWithScopeStepUp<T>(
  server: ServerWithName | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    resetScopeStepUp(server);
    return result;
  } catch (error) {
    driveScopeStepUpFromError(server, error);
    throw error;
  }
}
