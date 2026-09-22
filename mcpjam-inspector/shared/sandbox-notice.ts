/**
 * Transient SSE data part carrying a one-time fact about the scenario
 * conversation's ephemeral sandbox.
 *
 * Mirrors `data-harness-reset` (see `harness-session.ts`) and exists for the
 * same reason: a shell whose state silently vanished reads as the model
 * "forgetting", which is worse than an explained reset. A model that wrote
 * `/home/user/report.py` half an hour ago will otherwise reason confidently
 * about a file that no longer exists.
 *
 * Transient, not persisted — the DURABILITY lives in Convex. The backend marks
 * each notice delivered in the same transaction that hands it over, so a
 * reconnect or a second tab neither loses one nor shows it twice; this part is
 * only the delivery vehicle for the turn that consumed it.
 *
 * Carries a categorical reason ONLY — never a vendor sandbox id, template id,
 * or build id.
 */
export type SandboxNoticeReason =
  /** The box was reaped for idleness and a fresh one booted — state is gone. */
  | "sandbox_reset"
  /**
   * The environment's image was rebuilt after this box booted. The box is
   * deliberately KEPT (swapping mid-conversation would destroy the user's shell
   * state), so this conversation is one revision behind.
   */
  | "stale_image"
  /**
   * The conversation's bash needs a disposable cloud sandbox, but the server
   * handling this turn cannot execute one (it is not a computers data plane),
   * so no box was provisioned and bash is not advertised this turn.
   *
   * Unlike the two reasons above, this one is minted by the INSPECTOR, not the
   * control plane — there is no backing Convex notice row and nothing to ack.
   */
  | "sandbox_unavailable"
  /**
   * This turn could not establish which secrets the conversation's box holds,
   * so bash was not advertised.
   *
   * The narrow case: the secrets service failed, the conversation has a
   * PERSISTENT sandbox, and an earlier turn may have run a command carrying a
   * credential. That box can still hold the value — cached in a file, exported
   * into a background process — and this turn has no list to build a scrubber
   * from, so anything it printed would be persisted verbatim.
   *
   * A harness session forks to a fresh box in the same situation. A scenario
   * conversation cannot: its box is keyed to the conversation. Suppressing for
   * one turn is the equivalent remedy — the box is left intact and comes back
   * as soon as the secrets service does.
   */
  | "secrets_unavailable"
  /**
   * The environment selected MATERIALIZED secrets, they were resolved for this
   * turn, and there is no project-provisioned box to put them in — so they were
   * NOT delivered and no command this turn can see them.
   *
   * Not delivering is the correct behaviour, not a bug to route around: a
   * materialized value becomes a real environment variable in whatever box runs
   * the command, and the only boxes allowed to hold a project's credential are
   * the ones the project provisioned. A direct chat's bash runs on the member's
   * own machine or a shared remote runner, so putting it there would leak the
   * credential onto hardware the project does not control.
   *
   * What was wrong was doing it in silence. A tester who selected
   * `STRIPE_API_KEY` and watched `stripe` fail with a 401 has no way to learn
   * that the value was fetched and then dropped by design.
   *
   * INSPECTOR-minted, like `sandbox_unavailable`: no backing Convex row, and
   * nothing to ack. Brokered secrets are unaffected — they are injected outside
   * the box and never travel this path.
   */
  | "secrets_undelivered";

export interface SandboxNoticeInfo {
  reason: SandboxNoticeReason;
}

export interface SandboxNoticeDataPart {
  type: "data-sandbox-notice";
  data: SandboxNoticeInfo;
}

export const SANDBOX_NOTICE_DATA_PART_TYPE = "data-sandbox-notice" as const;

/**
 * Derived from an EXHAUSTIVE record so the compiler, not a reviewer, catches a
 * reason that was added to the union and forgotten here.
 *
 * A plain `new Set([...])` typed as `ReadonlySet<SandboxNoticeReason>` accepts
 * a short list happily, and the omission surfaces only at runtime as
 * `isSandboxNoticeReason` rejecting a reason the server legitimately emitted —
 * which drops the notice silently, on exactly the paths that exist to explain
 * something surprising to the user. `Record<SandboxNoticeReason, true>` makes
 * the same omission a type error.
 */
const SANDBOX_NOTICE_REASON_KEYS: Record<SandboxNoticeReason, true> = {
  sandbox_reset: true,
  stale_image: true,
  sandbox_unavailable: true,
  secrets_unavailable: true,
  secrets_undelivered: true,
};

const SANDBOX_NOTICE_REASONS: ReadonlySet<SandboxNoticeReason> = new Set(
  Object.keys(SANDBOX_NOTICE_REASON_KEYS) as SandboxNoticeReason[],
);

export function isSandboxNoticeReason(
  value: unknown,
): value is SandboxNoticeReason {
  return (
    typeof value === "string" &&
    SANDBOX_NOTICE_REASONS.has(value as SandboxNoticeReason)
  );
}

export function isSandboxNoticeDataPart(
  value: unknown,
): value is SandboxNoticeDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== SANDBOX_NOTICE_DATA_PART_TYPE) return false;
  const data = candidate.data;
  return (
    !!data &&
    typeof data === "object" &&
    isSandboxNoticeReason((data as Record<string, unknown>).reason)
  );
}
