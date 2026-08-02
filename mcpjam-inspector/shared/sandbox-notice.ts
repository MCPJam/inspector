/**
 * Transient SSE data part carrying a one-time fact about the chatbox
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
  | "stale_image";

export interface SandboxNoticeInfo {
  reason: SandboxNoticeReason;
}

export interface SandboxNoticeDataPart {
  type: "data-sandbox-notice";
  data: SandboxNoticeInfo;
}

export const SANDBOX_NOTICE_DATA_PART_TYPE = "data-sandbox-notice" as const;

const SANDBOX_NOTICE_REASONS: ReadonlySet<SandboxNoticeReason> = new Set([
  "sandbox_reset",
  "stale_image",
]);

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
