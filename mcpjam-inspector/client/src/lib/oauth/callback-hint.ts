/**
 * The OAuth checks and the OAuth Debugger sign in through
 * `/oauth/callback/debug`, not the `/oauth/callback` Connect uses. A provider
 * whose OAuth app only allows some redirect URLs rejects it on its own page,
 * inside the sign-in pop-up, where we cannot say anything. This is the hint
 * for when that sign-in never comes back.
 */
import { toast } from "@/lib/toast";
import { copyToClipboard } from "@/lib/clipboard";
import { getDebugRedirectUrl } from "@/lib/oauth/debug-state-machine-adapter";

// One id, so a closed pop-up and a deadline never stack two toasts.
const HINT_TOAST_ID = "oauth-callback-hint";

/** `retry` names what to do after: "run again" for a run, "try again" otherwise. */
export function showOAuthCallbackHint(retry = "run again"): void {
  const url = getDebugRedirectUrl();
  toast.warning(
    "OAuth sign-in didn't finish. Check your OAuth app's redirect URLs.",
    {
      id: HINT_TOAST_ID,
      description: `If your OAuth app only allows certain redirect URLs, add ${url} to it, then ${retry}.`,
      action: {
        label: "Copy URL",
        onClick: () => {
          void copyToClipboard(url).then((copied) => {
            if (!copied)
              toast.error("Couldn't copy the URL. Copy it by hand.", {
                description: url,
              });
          });
        },
      },
    },
  );
}

/** A code that arrives after all means the hint was shown too early. */
export function dismissOAuthCallbackHint(): void {
  toast.dismiss(HINT_TOAST_ID);
}
