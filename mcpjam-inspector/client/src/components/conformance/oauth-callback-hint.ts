/**
 * The OAuth checks sign in through `/oauth/callback/debug`, not the
 * `/oauth/callback` Connect uses. A provider whose OAuth app only allows some
 * redirect URLs rejects it on its own page, inside the sign-in pop-up, and the
 * run just waits. This is the hint for that case: when setup reaches the
 * checks, and again when the sign-in never comes back.
 */
import { toast } from "@/lib/toast";
import { copyToClipboard } from "@/lib/clipboard";
import { getDebugRedirectUrl } from "@/lib/oauth/debug-state-machine-adapter";

// One id for both, so the failure toast replaces the setup one.
const HINT_TOAST_ID = "conformance-oauth-callback-hint";

function showHint(title: string, ending: string): void {
  const url = getDebugRedirectUrl();
  toast.warning(title, {
    id: HINT_TOAST_ID,
    description: `If your OAuth app only allows certain redirect URLs, add ${url} to it, ${ending}.`,
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
  });
}

/** Setup reached the checks with OAuth picked. */
export function showOAuthCallbackNotice(): void {
  showHint(
    "The OAuth checks sign in through their own redirect URL.",
    "before you run",
  );
}

/** A closed pop-up or the deadline: the sign-in never came back. */
export function showOAuthCallbackHint(): void {
  showHint(
    "OAuth sign-in didn't finish. Check your OAuth app's redirect URLs.",
    "then run again",
  );
}

/** A code that arrives after all means the hint was shown too early. */
export function dismissOAuthCallbackHint(): void {
  toast.dismiss(HINT_TOAST_ID);
}
