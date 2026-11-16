/**
 * Transient SSE data part telling the browser that a turn ran without the
 * reasoning effort it carried, because its model is on a custom provider
 * connection, which takes no effort setting (see `withoutCustomProviderEffort`
 * in `server/utils/chat-reasoning-effort.ts`). The chat shows it as a toast,
 * so the reply is not read as one made at the saved effort.
 */
export const REASONING_EFFORT_NOTICE_DATA_PART_TYPE =
  "data-reasoning-effort-notice" as const;

export type ReasoningEffortNoticeReason = "custom_provider";

export interface ReasoningEffortNoticeDataPart {
  type: typeof REASONING_EFFORT_NOTICE_DATA_PART_TYPE;
  data: { reason: ReasoningEffortNoticeReason };
}

export const REASONING_EFFORT_NOTICE_MESSAGE =
  "Reasoning effort can't be set for custom providers, so this reply used the provider's default.";

export function isReasoningEffortNoticeDataPart(
  value: unknown,
): value is ReasoningEffortNoticeDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== REASONING_EFFORT_NOTICE_DATA_PART_TYPE) return false;
  const data = candidate.data;
  return (
    !!data &&
    typeof data === "object" &&
    (data as Record<string, unknown>).reason === "custom_provider"
  );
}
