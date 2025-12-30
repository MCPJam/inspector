import { useEffect, useState, useRef } from "react";
import {
  parseOAuthCallbackParams,
  generateOAuthErrorDescription,
} from "@/lib/oauth/oauthUtils";
import { CheckCircle2, XCircle } from "lucide-react";

export default function OAuthDebugCallback() {
  const callbackParams = parseOAuthCallbackParams(window.location.search);
  const [codeSent, setCodeSent] = useState(false);
  const hasAttemptedSendRef = useRef(false);

  useEffect(() => {
    // Prevent multiple sends (this useEffect might run multiple times in React 18 StrictMode)
    if (hasAttemptedSendRef.current) {
      return;
    }

    // If successful and we have a code, send it to the parent window
    if (callbackParams.successful && callbackParams.code) {
      hasAttemptedSendRef.current = true;
      try {
        const stateParam = new URLSearchParams(window.location.search).get(
          "state",
        );
        const message = {
          type: "OAUTH_CALLBACK",
          code: callbackParams.code,
          state: stateParam,
        };

        // Check if we're in a popup window
        const isInPopup = window.opener && !window.opener.closed;

        // Method 1: Try window.opener (works most of the time)
        if (isInPopup) {
          window.opener.postMessage(message, window.location.origin);
          setCodeSent(true);

          // Auto-close popup immediately (small delay to ensure message is sent)
          setTimeout(() => {
            window.close();
          }, 100);
        } else {
          // Method 2: Fallback to BroadcastChannel (works when window.opener is broken)
          // This handles OAuth servers that use Cross-Origin-Opener-Policy headers
          try {
            const channel = new BroadcastChannel("oauth_callback_channel");
            channel.postMessage(message);
            channel.close();
            setCodeSent(true);

            // Auto-close popup after sending
            setTimeout(() => {
              window.close();
            }, 500);
          } catch (broadcastError) {
            console.error(
              "[OAuth Callback] BroadcastChannel failed:",
              broadcastError,
            );
            // Show manual copy UI (already rendered by default)
          }
        }
      } catch (error) {
        console.error("[OAuth Callback] Failed to send code:", error);
      }
    }
  }, [callbackParams]);

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
          </>
        )}
      </div>
    </div>
  );
}
