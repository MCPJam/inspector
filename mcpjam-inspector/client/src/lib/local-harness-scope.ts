/**
 * The harnesses that can run on the member's machine, on direct and
 * environment chat. Shared/scenario execution stays hosted. Each one is gated
 * separately everywhere else (its own runtime, rollout and authorization);
 * this only says the SHAPE of a send could apply to it.
 */
export const LOCAL_HARNESS_SCOPED_HARNESS_IDS: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
]);

/** @deprecated The first local harness; use {@link LOCAL_HARNESS_SCOPED_HARNESS_IDS}. */
export const LOCAL_HARNESS_SCOPED_HARNESS_ID = "claude-code";

export interface LocalHarnessScopeInput {
  /**
   * The harness the host for THIS send or lane runs, as the client knows it.
   *
   * Null / undefined ⇒ out of scope. An unknown harness is not a local one,
   * and guessing in the permissive direction here would offer local execution
   * on a host that will not run it.
   */
  harnessId: string | null | undefined;
  /** `HOSTED_MODE`. */
  hostedMode: boolean;
  /** Set on a scenario (share-link or owner-preview) session. */
  scenarioId?: string | null;
  /** Set on an environment-target run. */
  environmentId?: string | null;
  /**
   * The surface has forced itself onto the org-aware web route.
   *
   * A superset signal covering environment mode and the hosted rail. Local
   * execution only exists on the local `/api/mcp` route, so a surface that has
   * already decided otherwise is out of scope by construction.
   */
  requiresWebChatApi?: boolean;
  /**
   * A shared or replayed run rather than the member's own turn.
   *
   * REQUIRED, unlike the other surface facts. Consent is bound to one attended
   * member running their own turn on their own machine, so "is this that?" is
   * the question this predicate exists to ask — and an optional boolean answers
   * it `false` for any caller that forgets, which is the permissive direction.
   * Making it required means a new surface has to state the answer rather than
   * inherit a default that happens to suit the surface it was copied from.
   */
  sharedRun: boolean;
}

/**
 * Is this send/lane one that local harness execution could apply to?
 *
 * Answers the SHAPE question only. Whether the machine can actually do it —
 * flag, sign-in, runtime, consent — is every other gate's business, and each of
 * those failing must leave an explicit local request explicitly unsatisfied
 * rather than quietly turning it into a hosted one.
 */
export function isLocalHarnessScope(args: LocalHarnessScopeInput): boolean {
  if (args.hostedMode) return false;
  if (!args.harnessId || !LOCAL_HARNESS_SCOPED_HARNESS_IDS.has(args.harnessId)) return false;
  if (args.sharedRun === true) return false;
  if (args.scenarioId) return false;
  return true;
}

/**
 * Whether a reopened chat is somebody else's turn, for `sharedRun`.
 *
 * The Playground marks EVERY restored thread as a history view (picked from
 * the rail, or reopened from the URL on reload), the user's own included, and
 * continuing your own chat is the attended session a local grant is bound to.
 * Treating every history view as replay dropped "This machine" from a
 * restored chat and moved its next turn off this computer. An unknown owner
 * or user stays replay.
 */
export function isAnotherUsersReopenedThread(args: {
  viewingHistory: boolean;
  ownerUserId: string | null | undefined;
  currentUserId: string | null | undefined;
}): boolean {
  if (!args.viewingHistory) return false;
  if (!args.ownerUserId || !args.currentUserId) return true;
  return args.ownerUserId !== args.currentUserId;
}
