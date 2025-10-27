import { useEffect, useState } from "react";
import {
  parseOAuthCallbackParams,
  generateOAuthErrorDescription,
} from "@/utils/oauthUtils";
import { CheckCircle2, XCircle } from "lucide-react";

export default function OAuthDebugCallback() {
  const callbackParams = parseOAuthCallbackParams(window.location.search);
  const [codeSent, setCodeSent] = useState(false);

  useEffect(() => {
    // If successful and we have a code, send it to the parent window
    if (callbackParams.successful && callbackParams.code) {
      try {
        const message = {
          type: "OAUTH_CALLBACK",
          code: callbackParams.code,
          state: new URLSearchParams(window.location.search).get("state"),
        };

        // Check if we're in an iframe or a popup window
        const isInIframe = window.self !== window.top;
        const isInPopup = window.opener && !window.opener.closed;

        if (isInIframe) {
          // Send message to parent frame
          window.parent.postMessage(message, window.location.origin);
          setCodeSent(true);
          console.log("[OAuth Callback] Sent code to parent frame (iframe)");
        } else if (isInPopup) {
          // Send message to opener window
          window.opener.postMessage(message, window.location.origin);
          setCodeSent(true);
          console.log("[OAuth Callback] Sent code to opener window (popup)");

          // Auto-close popup after 3 seconds
          setTimeout(() => {
            window.close();
          }, 3000);
        } else {
          console.warn(
            "[OAuth Callback] Not in iframe or popup - code not sent",
          );
        }
      } catch (error) {
        console.error("[OAuth Callback] Failed to send code:", error);
      }
    }
  }, [callbackParams]);

  // Check if we're in an iframe
  const isInIframe = window.self !== window.top;

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
                  {isInIframe
                    ? "The authorization modal will close automatically. You can now continue in the OAuth Flow tab."
                    : "This window will close automatically. You can now continue in the OAuth Flow tab."}
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
