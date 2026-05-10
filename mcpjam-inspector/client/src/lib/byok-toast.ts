import { toast } from "sonner";
import {
  BYOK_ERROR_CODES,
  formatErrorMessage,
  isOrgScopedAuthError,
} from "@/components/chat-v2/shared/chat-helpers";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";

/**
 * Surfaces a BYOK provider failure as a persistent sonner toast with an
 * "Open Organization Models" action button. Falls back to the existing
 * `getBillingErrorMessage` toast for any non-BYOK error so callers can use
 * this as a drop-in replacement at server-failure catch sites.
 *
 * Pair with `useOpenOrgModels()` to get the `openOrgModels` callback —
 * pass `undefined` on guest surfaces or when no active org is known to
 * suppress the action button.
 */
export interface ByokToastExtras {
  /** When provided, replaces the existing toast with this id (parity with
   * sonner's `toast.error(msg, { id })`). Used to swap an in-flight
   * "Replaying…" toast for the BYOK error in eval flows. */
  id?: string | number;
}

export function showByokErrorToast(
  error: unknown,
  fallback: string,
  openOrgModels?: () => void,
  extras?: ByokToastExtras,
): void {
  const formatted = formatErrorMessage(error);
  const code = formatted?.code;
  const isByok =
    (typeof code === "string" && BYOK_ERROR_CODES.has(code)) ||
    isOrgScopedAuthError(code, formatted?.message);

  if (isByok && formatted) {
    toast.error(formatted.message, {
      duration: Infinity,
      ...(extras?.id !== undefined ? { id: extras.id } : {}),
      ...(openOrgModels
        ? {
            action: {
              label: "Open Organization Models",
              onClick: openOrgModels,
            },
          }
        : {}),
    });
    return;
  }

  toast.error(
    getBillingErrorMessage(error, fallback),
    extras?.id !== undefined ? { id: extras.id } : undefined,
  );
}
