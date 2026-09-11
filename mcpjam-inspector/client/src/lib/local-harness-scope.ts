/**
 * WHERE local Claude Code execution is even a question.
 *
 * ── Why one predicate, in one file ───────────────────────────────────────
 * Three places have to agree about this and cannot be allowed to drift: the
 * chip decides whether to render, the pre-send gate decides whether to open the
 * dialog, and the transport decides whether a turn may carry a local target. If
 * any two of them disagree, the result is one of the two failures this whole
 * design exists to prevent — a user authorizing something that then runs
 * somewhere else, or a composer that blocks Send on a requirement its own
 * surface does not actually have.
 *
 * The specific drift to guard against is inheritance. Local execution is a
 * property of ONE host running ONE harness on a DIRECT chat. Nothing about it
 * belongs to normal emulated chat, to Codex, to a scenario replay, to an
 * environment run, or to somebody else's shared link — and a predicate that
 * asked only "is the local-harness flag on?" would have made all of them
 * inherit a local authorization requirement they can never satisfy.
 *
 * ── The three facts ──────────────────────────────────────────────────────
 * 1. The HOST for this send or lane runs `claude-code`. Not "a harness", and
 *    not the harness the picker is previewing somewhere else on the page — a
 *    compare view has several lanes and each answers this independently.
 * 2. The Inspector is local. A hosted replica running a vendor agent on ITS
 *    machine is the structural thing the design forbids, and `HOSTED_MODE`
 *    forces the server's kill switch off anyway.
 * 3. The surface is direct chat: not a scenario, not an environment run, not a
 *    shared/replayed session. Those are not one attended member running their
 *    own turn on their own machine, which is what consent is bound to.
 *
 * The feature FLAG is deliberately not one of the three. It gates whether setup
 * is offered; it is not part of the answer to "is this the kind of send local
 * execution could apply to". Keeping them separate is what lets an explicit
 * local request survive a flag or readiness change instead of silently becoming
 * a cloud request.
 */

export const LOCAL_HARNESS_SCOPED_HARNESS_ID = "claude-code";

export interface LocalHarnessScopeInput {
  /**
   * The harness the host for THIS send or lane runs, as the client knows it.
   *
   * Null / undefined ⇒ out of scope. An unknown harness is not `claude-code`,
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
 * Is this send/lane one that local Claude Code execution could apply to?
 *
 * Answers the SHAPE question only. Whether the machine can actually do it —
 * flag, sign-in, runtime, consent — is every other gate's business, and each of
 * those failing must leave an explicit local request explicitly unsatisfied
 * rather than quietly turning it into a hosted one.
 */
export function isLocalHarnessScope(args: LocalHarnessScopeInput): boolean {
  if (args.hostedMode) return false;
  if (args.harnessId !== LOCAL_HARNESS_SCOPED_HARNESS_ID) return false;
  if (args.requiresWebChatApi === true) return false;
  if (args.sharedRun === true) return false;
  if (args.scenarioId) return false;
  if (args.environmentId) return false;
  return true;
}
