import { useEffect } from "react";
import { SESSION_KEYS } from "../lib/types/constants";
import {
  generateOAuthErrorDescription,
  parseOAuthCallbackParams,
} from "@/lib/utils/auth/oauthUtils";

interface OAuthCallbackProps {
  onConnect: ({
    authorizationCode,
    errorMsg,
  }: {
    authorizationCode?: string;
    errorMsg?: string;
  }) => void;
}

const OAuthDebugCallback = ({ onConnect }: OAuthCallbackProps) => {
  useEffect(() => {
    let isProcessed = false;

    const handleCallback = async () => {
      // Skip if we've already processed this callback
      if (isProcessed) {
        return;
      }
      isProcessed = true;

      const params = parseOAuthCallbackParams(window.location.search);
      if (!params.successful) {
        const errorMsg = generateOAuthErrorDescription(params);
        onConnect({ errorMsg });
        return;
      }

      const serverUrl = sessionStorage.getItem(SESSION_KEYS.SERVER_URL);

      // ServerURL isn't set, this can happen if we've opened the
      // authentication request in a new tab, so we don't have the same
      // session storage
      if (!serverUrl) {
        // If there's no server URL, we're likely in a new tab
        // Just display the code for manual copying
        return;
      }

      if (!params.code) {
        onConnect({ errorMsg: "Missing authorization code" });
        return;
      }

      // Instead of storing in sessionStorage, pass the code directly
      // to the auth state manager through onConnect
      onConnect({ authorizationCode: params.code });
    };

    handleCallback().finally(() => {
      // Only redirect if we have the URL set, otherwise assume this was
      // in a new tab
      if (sessionStorage.getItem(SESSION_KEYS.SERVER_URL)) {
        window.history.replaceState({}, document.title, "/");
      }
    });

    return () => {
      isProcessed = true;
    };
  }, [onConnect]);

  const callbackParams = parseOAuthCallbackParams(window.location.search);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="mt-4 p-4 bg-secondary rounded-md max-w-md">
        <p className="mb-2 text-sm">
          Please copy this authorization code and return to the Auth Debugger:
        </p>
        <code className="block p-2 bg-muted rounded-sm overflow-x-auto text-xs">
          {callbackParams.successful && "code" in callbackParams
            ? callbackParams.code
            : `No code found: ${callbackParams.error}, ${callbackParams.error_description}`}
        </code>
        <p className="mt-4 text-xs text-muted-foreground">
          Close this tab and paste the code in the OAuth flow to complete
          authentication.
        </p>
      </div>
    </div>
  );
};

export default OAuthDebugCallback;
