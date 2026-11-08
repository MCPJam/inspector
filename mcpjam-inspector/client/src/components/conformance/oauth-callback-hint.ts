/**
 * The OAuth checks sign in through `/oauth/callback/debug`, not the
 * `/oauth/callback` Connect uses. A provider whose OAuth app only allows some
 * redirect URLs rejects it on its own page, inside the sign-in pop-up, and the
 * run just waits. This is the hint for that case: before the run in setup,
 * and as a toast when the sign-in never comes back.
 */
import { toast } from "@/lib/toast";
import { copyToClipboard } from "@/lib/clipboard";
import { getDebugRedirectUrl } from "@/lib/oauth/debug-state-machine-adapter";

const HINT_TOAST_ID = "conformance-oauth-callback-hint";

/** The sentence setup and the toast share, around the callback URL. */
export const OAUTH_CALLBACK_HINT_PREFIX =
  "If your OAuth app only allows certain redirect URLs, add";

/** One toast for both triggers, so a closed pop-up and the deadline never stack. */
export function showOAuthCallbackHint(): void {
  const url = getDebugRedirectUrl();
  toast.warning("OAuth sign-in didn't finish. Check your OAuth app's redirect URLs.", {
    id: HINT_TOAST_ID,
    description: `${OAUTH_CALLBACK_HINT_PREFIX} ${url} to it, then run again.`,
    action: {
      label: "Copy URL",
      onClick: () => {
        void copyToClipboard(url);
      },
    },
  });
}

/** A code that arrives after all means the hint was shown too early. */
export function dismissOAuthCallbackHint(): void {
  toast.dismiss(HINT_TOAST_ID);
}
