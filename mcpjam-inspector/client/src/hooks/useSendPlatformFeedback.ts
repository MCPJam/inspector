import { useCallback } from "react";
import { useMutation } from "convex/react";
import type {
  PlatformFeedbackKind,
  PlatformFeedbackReceipt,
} from "@mcpjam/sdk/platform";

export type SendPlatformFeedbackInput = {
  kind: PlatformFeedbackKind;
  summary: string;
  details?: string;
  operation?: string;
  requestId?: string;
  errorCode?: string;
  projectId?: string;
  /**
   * One per dialog opening: a double-click, or a retry after a dropped
   * response, lands on the first report instead of filing a second.
   */
  idempotencyKey: string;
};

/**
 * Send a platform-feedback report from the app.
 *
 * The same write the `/v1/feedback` route makes — `platformFeedback:submit`,
 * which carries every cap — with the app's own `source`. The mutation's reply
 * is the receipt: it means the report is STORED.
 */
export function useSendPlatformFeedback(): (
  input: SendPlatformFeedbackInput,
) => Promise<PlatformFeedbackReceipt> {
  const submit = useMutation("platformFeedback:submit" as any);
  return useCallback(
    async (input: SendPlatformFeedbackInput) =>
      (await submit({
        ...input,
        source: "app",
      } as any)) as PlatformFeedbackReceipt,
    [submit],
  );
}
