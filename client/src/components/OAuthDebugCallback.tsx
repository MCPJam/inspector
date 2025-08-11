import React from "react";

export default function OAuthDebugCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");
  const errorDescription = params.get("error_description");

  return (
    <div className="flex items-center justify-center min-h-[100vh] p-4">
      <div className="mt-4 p-4 bg-secondary rounded-md max-w-md w-full border">
        {code ? (
          <>
            <p className="mb-2 text-sm">
              Please copy this authorization code and return to the Auth screen:
            </p>
            <code className="block p-2 bg-muted rounded-sm overflow-x-auto text-xs">
              {code}
            </code>
            <p className="mt-4 text-xs text-muted-foreground">
              Close this tab and paste the code in the OAuth flow to complete
              authentication.
            </p>
          </>
        ) : (
          <>
            <p className="mb-2 text-sm font-medium">
              No authorization code found
            </p>
            <div className="text-xs text-muted-foreground">
              <div>Error: {error || "unknown"}</div>
              {errorDescription && (
                <div>Description: {decodeURIComponent(errorDescription)}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
