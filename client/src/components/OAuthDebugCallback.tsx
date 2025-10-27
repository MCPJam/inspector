import {
  parseOAuthCallbackParams,
  generateOAuthErrorDescription,
} from "@/utils/oauthUtils";

export default function OAuthDebugCallback() {
  const callbackParams = parseOAuthCallbackParams(window.location.search);

  return (
    <div className="flex items-center justify-center min-h-[100vh] p-4">
      <div className="mt-4 p-4 bg-secondary rounded-md max-w-md w-full border">
        {callbackParams.successful ? (
          <>
            <p className="mb-2 text-sm">
              Please copy this authorization code and return to the OAuth Flow tab:
            </p>
            <code className="block p-2 bg-muted rounded-sm overflow-x-auto text-xs">
              {callbackParams.code}
            </code>
            <p className="mt-4 text-xs text-muted-foreground">
              Close this tab and paste the code in the OAuth flow to complete
              authentication.
            </p>
          </>
        ) : (
          <>
            <p className="mb-2 text-sm font-medium text-red-600 dark:text-red-400">
              Authorization Failed
            </p>
            <div className="text-xs text-muted-foreground whitespace-pre-wrap">
              {generateOAuthErrorDescription(callbackParams)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
