import { useEffect } from "react";
import { toast } from "@/lib/toast";
import { usePostHog } from "posthog-js/react";

import { clearPendingTopup, peekPendingTopup } from "@/hooks/useCreditTopup";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

interface UseCreditTopupReturnFlowOptions {
  /** Active chat session id used to validate the pending stash on success. */
  chatSessionId: string;
  /** Hook into the chat session's send to replay the user's last message. */
  sendMessage: (args: { text: string }) => void;
}

/**
 * Handles the chat-side fallout from a hosted-checkout return:
 *
 * - On `?topup=cancelled`: strip the URL params and leave the pending
 *   stash alone (a retry within the TTL window should still resend the
 *   queued message).
 * - On `?topup=success`: strip the URL params, peek the stash
 *   (non-destructive), and try to resend the user's queued message. The
 *   stash is only cleared after the resend reports back successfully —
 *   if `sendMessage` throws synchronously the stash is preserved so the
 *   user can retry.
 *
 * Runs once on mount. `chatSessionId` and `sendMessage` are captured
 * from the initial render — `chatSessionId` is stable for the lifetime
 * of the chat session, and a new `sendMessage` reference would imply a
 * fresh mount anyway.
 */
export function useCreditTopupReturnFlow({
  chatSessionId,
  sendMessage,
}: UseCreditTopupReturnFlowOptions): void {
  const posthog = usePostHog();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const topupParam = params.get("topup");
    if (topupParam !== "success" && topupParam !== "cancelled") return;

    params.delete("topup");
    params.delete("session_id");
    const search = params.toString();
    const cleanedUrl = window.location.pathname + (search ? `?${search}` : "");
    window.history.replaceState(null, "", cleanedUrl);

    if (topupParam === "cancelled") {
      const pending = peekPendingTopup();
      posthog?.capture("credit_topup_return_cancelled", {
        had_pending_stash: pending !== null,
      });
      return;
    }

    useMCPJamLimitDialogStore.getState().clearOutOfCreditsHit();

    const pending = peekPendingTopup();
    const hadPendingStash = pending !== null;
    let chatSessionMatched = false;
    let resendExecuted = false;

    if (pending) {
      chatSessionMatched = pending.chatSessionId === chatSessionId;
      if (!chatSessionMatched) {
        clearPendingTopup();
      } else {
        try {
          sendMessage({ text: pending.message });
          resendExecuted = true;
          toast.success("Credits added — resuming your message.");
          clearPendingTopup();
        } catch {
          toast.error(
            "Credits added, but we couldn't resend your last message. Please send it again."
          );
        }
      }
    }

    posthog?.capture("credit_topup_return_success", {
      had_pending_stash: hadPendingStash,
      chat_session_matched: chatSessionMatched,
      resend_executed: resendExecuted,
    });
    // Run once on mount; see fn-level comment for the rationale on the
    // captured arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Surface-agnostic variant for non-chat pages (e.g. the org billing tab):
 * strip the topup query params, emit a PostHog return event, and surface a
 * confirmation toast. Does NOT touch the pending message stash — that
 * belongs to the chat surface and a billing-initiated round trip has no
 * queued message to resend.
 */
interface UseCreditTopupReturnFlowBillingOptions {
  enabled?: boolean;
}

export function useCreditTopupReturnFlowBilling({
  enabled = true,
}: UseCreditTopupReturnFlowBillingOptions = {}): void {
  const posthog = usePostHog();

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const topupParam = params.get("topup");
    if (topupParam !== "success" && topupParam !== "cancelled") return;

    params.delete("topup");
    params.delete("session_id");
    const search = params.toString();
    const cleanedUrl = window.location.pathname + (search ? `?${search}` : "");
    window.history.replaceState(null, "", cleanedUrl);

    if (topupParam === "cancelled") {
      posthog?.capture("credit_topup_return_cancelled");
      return;
    }

    useMCPJamLimitDialogStore.getState().clearOutOfCreditsHit();

    toast.success("Credits added.");
    posthog?.capture("credit_topup_return_success");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
