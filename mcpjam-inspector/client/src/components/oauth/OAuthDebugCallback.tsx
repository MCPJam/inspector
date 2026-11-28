import { useEffect, useMemo, useState, useRef } from "react";
import {
  parseOAuthCallbackParams,
  generateOAuthErrorDescription,
} from "@/lib/oauth/oauthUtils";
import {
  consumeOAuthCallbackParams,
  readOAuthCallbackParams,
} from "@/lib/oauth-callback-inbox";
import {
  buildOAuthCallbackMessage,
  deleteOAuthPopupMarker,
  hashOAuthState,
  oauthCallbackChannelName,
  resolveOAuthCallbackRoute,
} from "@/lib/oauth/popup-handoff-marker";
import { CheckCircle2, XCircle } from "lucide-react";

/**
 * The debugger callback's answer. From the inbox `main.tsx` moved it into,
 * not `window.location.search`: by the time this renders, the address bar of
 * `/oauth/callback/debug` holds only `?oauth_pending=1` (see
 * `lib/oauth-callback-inbox.ts`).
 */
function readDebugCallbackSearch(): URLSearchParams {
  return readOAuthCallbackParams() ?? new URLSearchParams();
}

export function buildElectronDebugCallbackUrl(
  params: URLSearchParams = readDebugCallbackSearch(),
): string {
  const callbackUrl = new URL("mcpjam://oauth/callback");
  callbackUrl.searchParams.set("flow", "debug");

  for (const [key, value] of params.entries()) {
    callbackUrl.searchParams.append(key, value);
  }

  return callbackUrl.toString();
}

export default function OAuthDebugCallback() {
  // Captured ONCE. The answer is consumed after it has been handed to the
  // opener, and a re-render reading the then-empty inbox would flip this card
  // from "code sent" to "Missing code or error in response".
  const [callbackSearch] = useState(readDebugCallbackSearch);
  const callbackParams = useMemo(
    () => parseOAuthCallbackParams(callbackSearch.toString()),
    [callbackSearch],
  );
  const [codeSent, setCodeSent] = useState(false);
  const [returnToElectronUrl, setReturnToElectronUrl] = useState<string | null>(
    null,
  );
  const hasAttemptedSendRef = useRef(false);

  useEffect(() => {
    // Prevent multiple sends (this useEffect might run multiple times in React 18 StrictMode)
    if (hasAttemptedSendRef.current) {
      return;
    }

    const hasOpener = Boolean(window.opener && !window.opener.closed);
    const message = buildOAuthCallbackMessage(callbackSearch);
    const state = callbackSearch.get("state");
    // Decided by the marker the opening tab left, not by `window.opener` or
    // `window.name`: a COOP provider page clears both, which makes a web
    // popup look exactly like a desktop app's system-browser return.
    const route = resolveOAuthCallbackRoute(hasOpener, state);

    // Electron cold-start debug callbacks do not have a live opener session to
    // hand results back to, so keep the callback visible instead of attempting
    // popup behavior in the only app window.
    if (window.isElectron && route === "desktop") {
      return;
    }

    // No tab in this browser is waiting on this sign-in, so the desktop app
    // started it in the system browser.
    if (route === "desktop") {
      hasAttemptedSendRef.current = true;
      const electronUrl = buildElectronDebugCallbackUrl(callbackSearch);
      setReturnToElectronUrl(electronUrl);
      window.location.replace(electronUrl);
      return;
    }

    if (!message) return;
    hasAttemptedSendRef.current = true;
    try {
      if (route === "opener") {
        window.opener.postMessage(message, window.location.origin);
      } else if (state) {
        const channel = new BroadcastChannel(
          oauthCallbackChannelName(hashOAuthState(state)),
        );
        channel.postMessage(message);
        channel.close();
        deleteOAuthPopupMarker(state);
      }
      // Handed off: the opener redeems it, so its reload copy goes now.
      consumeOAuthCallbackParams();
      if (message.code) setCodeSent(true);
      // A small delay so the message is out before the window goes.
      setTimeout(
        () => {
          window.close();
        },
        route === "opener" ? 100 : 500,
      );
    } catch (error) {
      // The manual copy UI below stays up as the fallback.
      console.error("[OAuth Callback] Failed to send the callback:", error);
    }
  }, [callbackParams, callbackSearch]);

  return (
    <div className="flex items-center justify-center min-h-[100vh] p-4">
      <div className="mt-4 p-4 bg-secondary rounded-md max-w-md w-full border">
        {callbackParams.successful ? (
          <>
            {codeSent ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-5 w-5" />
                  <p className="text-sm font-medium">
                    Authorization code sent successfully!
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  This window will close automatically. You can now continue in
                  the OAuth Flow tab.
                </p>
              </div>
            ) : (
              <>
                <p className="mb-2 text-sm">
                  Authorization successful! Copy this code:
                </p>
                <code className="block p-2 bg-muted rounded-sm overflow-x-auto text-xs">
                  {callbackParams.code}
                </code>
                <p className="mt-4 text-xs text-muted-foreground">
                  Return to the OAuth Flow tab and paste the code to continue.
                </p>
                {window.isElectron && !window.opener && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    The debug session is no longer attached to a popup window.
                    Reopen the OAuth Flow tab in MCPJam Inspector and start the
                    flow again to exchange a fresh code.
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2">
              <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                Authorization Failed
              </p>
            </div>
            <div className="text-xs text-muted-foreground whitespace-pre-wrap">
              {generateOAuthErrorDescription(callbackParams)}
            </div>
            {window.isElectron && !window.opener && (
              <p className="mt-3 text-xs text-muted-foreground">
                The debug session is no longer active in a popup window. Return
                to MCPJam Inspector and start a new flow to retry.
              </p>
            )}
          </>
        )}
        {!window.isElectron && returnToElectronUrl && (
          <div className="mt-4 space-y-2 text-xs text-muted-foreground">
            <p>
              MCPJam Desktop should open automatically. If you are back in the
              browser, please close this page and continue in MCPJam Desktop.
            </p>
            <p>
              If nothing happened,{" "}
              <a className="underline" href={returnToElectronUrl}>
                click here
              </a>
              .
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
