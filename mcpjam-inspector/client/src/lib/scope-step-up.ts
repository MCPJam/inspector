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
  type ToolCallStepUpOperation,
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

function operationIdentity(
  server: ServerWithName,
  operation?: ToolCallStepUpOperation,
): string {
  return `${server.name}\u0000${operation?.method ?? "tools/call"}\u0000${
    operation?.operation ?? `server:${server.name}`
  }`;
}

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
  operation?: ToolCallStepUpOperation;
};
const pendingChatStepUps = new Map<string, PendingChatStepUp>();

/**
 * One record per live turn.
 *
 * A SET, not a counter: compare mode runs a `useChatSession` per lane and they
 * stream concurrently. A counter can say "some turn is running" but not *which*
 * ones, so it cannot stop them all on timeout, and it cannot tell whose
 * persistence still has to land. Both of those lose exactly the transcripts
 * this hold exists to protect.
 */
export type ChatTurnScopeStepUpHold = { abort?: () => void };
const activeHolds = new Set<ChatTurnScopeStepUpHold>();
/** Persistence checks owed by turns that have already ended. */
const pendingPersistWaits = new Set<() => Promise<unknown>>();
/** Guards against two release rounds racing each other to the redirect. */
let releaseInProgress = false;
let holdTimeoutId: ReturnType<typeof setTimeout> | null = null;

/** Test seam: no production caller should need this. */
export function __resetScopeStepUpInFlightForTests(): void {
  inFlight.clear();
  pendingChatStepUps.clear();
  activeHolds.clear();
  pendingPersistWaits.clear();
  releaseInProgress = false;
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
  for (const { server, challenge, operation } of queued) {
    driveScopeStepUp(server, challenge, operation);
  }
}

/**
 * Release the queue once every turn has ended and had a chance to persist.
 *
 * Deliberately a LOOP under a single-runner guard rather than one
 * `Promise.allSettled` per caller. A turn that ends while an earlier turn's
 * persistence check is still running would otherwise open a second, concurrent
 * release round — and whichever settled first would redirect, discarding the
 * other turn before it was written. Instead the running loop picks up the newly
 * owed checks on its next pass, so the redirect waits for all of them.
 */
async function releaseQueuedChatStepUps(): Promise<void> {
  if (releaseInProgress) return;
  releaseInProgress = true;
  try {
    while (activeHolds.size === 0 && pendingChatStepUps.size > 0) {
      const waits = [...pendingPersistWaits];
      pendingPersistWaits.clear();
      if (waits.length === 0) {
        flushPendingChatStepUps();
        return;
      }
      // Every turn that has ended so far, not just the one that triggered this
      // pass: the queued challenge may well have come from a different turn
      // than the one whose persistence we happen to be holding.
      await Promise.allSettled(waits.map((wait) => wait()));
    }
    // Either nothing is queued, or the user started another turn while we
    // waited. Redirecting into a live turn is the exact failure this hold
    // exists to prevent, so leave the queue for that turn's own release.
    if (pendingChatStepUps.size === 0) {
      pendingPersistWaits.clear();
      clearHoldTimeout();
    }
  } finally {
    releaseInProgress = false;
  }
}

/**
 * Marks the start of a chat turn: step-ups raised from here on are queued
 * rather than redirected.
 *
 * @param abort Stops THIS turn if the hold times out, so the redirect isn't
 *   waiting on a stream that will never end.
 * @returns The handle to pass back to {@link endChatTurnScopeStepUpHold}.
 */
export function beginChatTurnScopeStepUpHold(
  abort?: () => void,
): ChatTurnScopeStepUpHold {
  const hold: ChatTurnScopeStepUpHold = { abort };
  activeHolds.add(hold);
  return hold;
}

/**
 * Marks the end of one chat turn, releasing the queue once every turn is done.
 *
 * @param waitForPersist Resolves once this turn has been written server-side.
 *   Awaited (never awaited *on*): persistence is worth a moment's delay, never
 *   worth withholding authorization over.
 */
export function endChatTurnScopeStepUpHold(
  hold: ChatTurnScopeStepUpHold,
  waitForPersist?: () => Promise<unknown>,
): void {
  // Already released — by a timeout, or by a duplicate end. Registering a
  // persistence wait now would attach it to somebody else's round.
  if (!activeHolds.delete(hold)) return;
  if (waitForPersist) {
    pendingPersistWaits.add(waitForPersist);
  }
  if (activeHolds.size > 0) return;
  void releaseQueuedChatStepUps();
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
  operation?: ToolCallStepUpOperation,
): void {
  // Apply the same gates the immediate path does, up front: a chatbox /
  // share-link turn (no resolvable server) and a challenge with nothing to
  // widen must not hold a slot in the queue.
  if (!server) return;
  if (!isActionableStepUpChallenge(challenge)) return;
  if (activeHolds.size === 0) {
    driveScopeStepUp(server, challenge, operation);
    return;
  }
  const key = operationIdentity(server, operation);
  if (inFlight.has(key)) return;
  if (pendingChatStepUps.has(key)) return;
  pendingChatStepUps.set(key, { server, challenge, operation });
  if (holdTimeoutId !== null) return;
  holdTimeoutId = setTimeout(() => {
    holdTimeoutId = null;
    // Stop EVERY live turn first: the redirect discards the page, so any lane
    // left streaming would be writing into a document that is about to go
    // away — and its transcript would never be persisted.
    const stranded = [...activeHolds];
    activeHolds.clear();
    pendingPersistWaits.clear();
    for (const hold of stranded) {
      try {
        hold.abort?.();
      } catch {
        // A failed abort must not strand the queued authorization.
      }
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
export function resetScopeStepUp(
  server: ServerWithName | undefined,
  operation?: ToolCallStepUpOperation,
): void {
  if (!server) return;
  try {
    if (operation) {
      resetToolCallStepUp(server, operation);
    } else {
      resetToolCallStepUp(server);
    }
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
  operation?: ToolCallStepUpOperation,
): void {
  if (!server) return;
  if (!isActionableStepUpChallenge(challenge)) return;
  const key = operationIdentity(server, operation);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const stepUp = {
    requiredScope: challenge.requiredScope,
    resourceMetadataUrl: challenge.resourceMetadataUrl,
  };
  void (operation
    ? applyToolCallStepUp(server, stepUp, { operation })
    : applyToolCallStepUp(server, stepUp))
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
  operation?: ToolCallStepUpOperation,
): void {
  driveScopeStepUp(server, insufficientScopeFromError(error), operation);
}

/**
 * {@link driveScopeStepUp} for surfaces whose failure arrives as a field on a
 * RESULT object rather than as a throw (tool execution, the playground).
 */
export function driveScopeStepUpFromChallenge(
  server: ServerWithName | undefined,
  rawChallenge: unknown,
  operation?: ToolCallStepUpOperation,
): void {
  driveScopeStepUp(
    server,
    parseInsufficientScopeChallenge(rawChallenge),
    operation,
  );
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
  operationKeyOrOperation:
    | ToolCallStepUpOperation
    | (() => Promise<T>),
  maybeOperation?: () => Promise<T>,
  options?: {
    beforeStepUp?: (
      challenge: InsufficientScopeChallenge,
    ) => void;
  },
): Promise<T> {
  const operationKey =
    typeof operationKeyOrOperation === "function"
      ? undefined
      : operationKeyOrOperation;
  const operation =
    typeof operationKeyOrOperation === "function"
      ? operationKeyOrOperation
      : maybeOperation;
  if (!operation) {
    throw new TypeError("scope step-up operation is required");
  }
  try {
    const result = await operation();
    resetScopeStepUp(server, operationKey);
    return result;
  } catch (error) {
    const challenge = insufficientScopeFromError(error);
    if (isActionableStepUpChallenge(challenge)) {
      options?.beforeStepUp?.(challenge);
    }
    driveScopeStepUp(server, challenge, operationKey);
    throw error;
  }
}
