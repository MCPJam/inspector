/**
 * The FormattedError for an MCPJam credit refusal — the one surface an agent or
 * user reads after a chat turn is refused for credits.
 *
 * It lives apart from chat-helpers because that file is at its size budget, and
 * because the rule it encodes is a product rule, not a formatting detail: the
 * sentence gives ONE action — the one MCPJam wants (upgrade on Free, buy
 * credits on paid) — with the refusal's exact link, and never steers toward
 * waiting or BYOK. The backend carries that action as a structured `recovery`;
 * `formatCreditRecovery` renders it. Only a refusal WITHOUT one (an older
 * backend) falls back to the retry/BYOK wording.
 */
import {
  creditRecoveryOfRefusal,
  formatCreditRecovery,
} from "@mcpjam/sdk/contract";
import type { FormattedError } from "./chat-helpers";

export const USER_RATE_LIMIT_CODE = "user_rate_limit";
export const MCPJAM_RATE_LIMIT_CODE = "mcpjam_rate_limit";
export const RATE_LIMIT_CODES = new Set<string>([
  USER_RATE_LIMIT_CODE,
  MCPJAM_RATE_LIMIT_CODE,
]);

interface McpjamModelLimitExtras {
  code?: string;
  canTopUp?: boolean;
  limitKind?: "total" | "concurrency";
  retryAfterMs?: number;
  /**
   * The refusal body (parsed envelope or raw string). Its structured
   * `recovery`, when present and not a transient hold, is the sentence shown —
   * link included.
   */
  refusal?: unknown;
}

export const formatMCPJamModelLimit = (
  retryPhrase: string | null,
  extras?: McpjamModelLimitExtras,
): FormattedError => ({
  code: extras?.code ?? MCPJAM_RATE_LIMIT_CODE,
  message:
    recoveryMessage(extras) ??
    (retryPhrase
      ? `Add your own API key in Settings > LLM Providers to keep chatting now, or ${retryPhrase}.`
      : "Add your own API key in Settings > LLM Providers to keep chatting now, or add credits from Billing."),
  isRetryable: false,
  isMCPJamPlatformError: true,
  ...(extras?.canTopUp !== undefined ? { canTopUp: extras.canTopUp } : {}),
  ...(extras?.limitKind !== undefined ? { limitKind: extras.limitKind } : {}),
  ...(extras?.retryAfterMs !== undefined
    ? { retryAfterMs: extras.retryAfterMs }
    : {}),
});

/**
 * The recovery sentence for a refusal that carries one, or null.
 *
 * A transient hold (`limitKind: "concurrency"`: other in-flight requests hold
 * the last credits) keeps the existing wait copy — the wallet is not empty, so
 * its own banner, not a recovery step, is the right treatment. Any countdown in
 * the sentence comes from `recovery.resetAt`, which `formatCreditRecovery`
 * reads only for a `wait` action; a `retryAfter` of 0 never becomes one.
 */
function recoveryMessage(
  extras: McpjamModelLimitExtras | undefined,
): string | null {
  if (
    !extras ||
    extras.limitKind === "concurrency" ||
    extras.refusal === undefined
  ) {
    return null;
  }
  const recovery = creditRecoveryOfRefusal(extras.refusal);
  return recovery ? formatCreditRecovery(recovery) : null;
}
