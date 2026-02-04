import { OAuthFlowState, OAuthStep } from "@/lib/types/oauth-flow-types";
import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { useEffect, useState, useMemo } from "react";
import { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Button } from "@/components/ui/button";
import { DebugMCPOAuthClientProvider } from "@/lib/oauth/debug-oauth-provider";
import { OAuthAuthorizationModal } from "@/components/oauth/OAuthAuthorizationModal";

interface OAuthStepProps {
  label: string;
  isComplete: boolean;
  isCurrent: boolean;
  error?: Error | null;
  children?: React.ReactNode;
}

const OAuthStepDetails = ({
  label,
  isComplete,
  isCurrent,
  error,
  children,
}: OAuthStepProps) => {
  return (
    <div>
      <div
        className={`flex items-center p-2 rounded-md ${isCurrent ? "bg-accent" : ""}`}
      >
        {isComplete ? (
          <CheckCircle2 className="h-5 w-5 text-success mr-2" />
        ) : (
          <Circle className="h-5 w-5 text-muted-foreground mr-2" />
        )}
        <span className={`${isCurrent ? "font-medium" : ""}`}>{label}</span>
      </div>

      {/* Show children if current step or complete and children exist */}
      {(isCurrent || isComplete) && children && (
        <div className="ml-7 mt-1">{children}</div>
      )}

      {/* Display error if current step and an error exists */}
      {isCurrent && error && (
        <div className="ml-7 mt-2 p-3 border border-destructive/30 bg-destructive/10 rounded-md">
          <p className="text-sm font-medium text-destructive">Error:</p>
          <p className="text-xs text-destructive/80 mt-1">{error.message}</p>
        </div>
      )}
    </div>
  );
};

interface OAuthFlowProgressSimpleProps {
  serverUrl: string;
  flowState: OAuthFlowState;
  updateFlowState: (updates: Partial<OAuthFlowState>) => void;
  proceedToNextStep: () => Promise<void>;
}

const steps: Array<OAuthStep> = [
  "metadata_discovery",
  "client_registration",
  "authorization_redirect",
  "authorization_code",
  "token_request",
  "complete",
];

export const OAuthFlowProgressSimple = ({
  serverUrl,
  flowState,
  updateFlowState,
  proceedToNextStep,
}: OAuthFlowProgressSimpleProps) => {
  const provider = useMemo(
    () => new DebugMCPOAuthClientProvider(serverUrl),
    [serverUrl],
  );
  const [clientInfo, setClientInfo] = useState<OAuthClientInformation | null>(
    null,
  );

  // Track if authorization modal is open
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  const currentStepIdx = steps.findIndex((s) => s === flowState.oauthStep);

  useEffect(() => {
    const fetchClientInfo = async () => {
      if (flowState.oauthClientInfo) {
        setClientInfo(flowState.oauthClientInfo);
      } else {
        try {
          const info = await provider.clientInformation();
          if (info) {
            setClientInfo(info);
          }
        } catch (error) {
          console.error("Failed to fetch client information:", error);
        }
      }
    };

    if (currentStepIdx > steps.indexOf("client_registration")) {
      fetchClientInfo();
    }
  }, [
    provider,
    flowState.oauthStep,
    flowState.oauthClientInfo,
    currentStepIdx,
  ]);

  // Helper to get step props
  const getStepProps = (stepName: OAuthStep) => ({
    isComplete:
      currentStepIdx > steps.indexOf(stepName) ||
      currentStepIdx === steps.length - 1, // last step is "complete"
    isCurrent: flowState.oauthStep === stepName,
    error: flowState.oauthStep === stepName ? flowState.latestError : null,
  });

  return (
    <div className="rounded-md border p-6 space-y-4 mt-4">
      <h3 className="text-lg font-medium">OAuth Flow Progress</h3>
      <p className="text-sm text-muted-foreground">
        Follow these steps to complete OAuth authentication with the server.
      </p>

      <div className="space-y-3">
        <OAuthStepDetails
          label="Metadata Discovery"
          {...getStepProps("metadata_discovery")}
        >
          {flowState.oauthMetadata && (
            <details className="text-xs mt-2">
              <summary className="cursor-pointer text-muted-foreground font-medium">
                OAuth Metadata Sources
                {!flowState.resourceMetadata && " ℹ️"}
              </summary>

              {flowState.resourceMetadata && (
                <div className="mt-2">
                  <p className="font-medium">Resource Metadata:</p>
                  <p className="text-xs text-muted-foreground">
                    From{" "}
                    {
                      new URL(
                        "/.well-known/oauth-protected-resource",
                        serverUrl,
                      ).href
                    }
                  </p>
                  <pre className="mt-2 p-2 bg-muted rounded-md overflow-auto max-h-[300px]">
                    {JSON.stringify(flowState.resourceMetadata, null, 2)}
                  </pre>
                </div>
              )}

              {flowState.resourceMetadataError && (
                <div className="mt-2 p-3 border border-info/30 bg-info/10 rounded-md">
                  <p className="text-sm font-medium text-info">
                    ℹ️ Problem with resource metadata from{" "}
                    <a
                      href={
                        new URL(
                          "/.well-known/oauth-protected-resource",
                          serverUrl,
                        ).href
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-info hover:text-info/80"
                    >
                      {
                        new URL(
                          "/.well-known/oauth-protected-resource",
                          serverUrl,
                        ).href
                      }
                    </a>
                  </p>
                  <p className="text-xs text-info/80 mt-1">
                    Resource metadata was added in the{" "}
                    <a
                      href="https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-server-location"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      2025-06-18 specification update
                    </a>
                    <br />
                    {flowState.resourceMetadataError.message}
                    {flowState.resourceMetadataError instanceof TypeError &&
                      " (This could indicate the endpoint doesn't exist or does not have CORS configured)"}
                  </p>
                </div>
              )}

              {flowState.oauthMetadata && (
                <div className="mt-2">
                  <p className="font-medium">Authorization Server Metadata:</p>
                  {flowState.authServerUrl && (
                    <p className="text-xs text-muted-foreground">
                      From{" "}
                      {
                        new URL(
                          "/.well-known/oauth-authorization-server",
                          flowState.authServerUrl,
                        ).href
                      }
                    </p>
                  )}
                  <pre className="mt-2 p-2 bg-muted rounded-md overflow-auto max-h-[300px]">
                    {JSON.stringify(flowState.oauthMetadata, null, 2)}
                  </pre>
                </div>
              )}
            </details>
          )}
        </OAuthStepDetails>

        <OAuthStepDetails
          label="Client Registration"
          {...getStepProps("client_registration")}
        >
          {clientInfo && (
            <details className="text-xs mt-2">
              <summary className="cursor-pointer text-muted-foreground font-medium">
                Registered Client Information
              </summary>
              <pre className="mt-2 p-2 bg-muted rounded-md overflow-auto max-h-[300px]">
                {JSON.stringify(clientInfo, null, 2)}
              </pre>
            </details>
          )}
        </OAuthStepDetails>

        <OAuthStepDetails
          label="Preparing Authorization"
          {...getStepProps("authorization_redirect")}
        >
          {flowState.authorizationUrl && (
            <div className="mt-2 p-3 border rounded-md bg-muted">
              <p className="font-medium mb-2 text-sm">Authorization URL:</p>
              <div className="flex items-center gap-2">
                <p className="text-xs break-all">
                  {String(flowState.authorizationUrl)}
                </p>
                <button
                  onClick={() => {
                    setIsAuthModalOpen(true);
                  }}
                  className="flex items-center text-info hover:text-info/80"
                  aria-label="Open authorization URL"
                  title="Open authorization URL"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Click the link to authorize in your browser. After
                authorization, you'll be redirected back to continue the flow.
              </p>
            </div>
          )}
        </OAuthStepDetails>

        <OAuthStepDetails
          label="Request Authorization and acquire authorization code"
          {...getStepProps("authorization_code")}
        >
          <div className="mt-3">
            <label
              htmlFor="authCode"
              className="block text-sm font-medium mb-1"
            >
              Authorization Code
            </label>
            <div className="flex gap-2">
              <input
                id="authCode"
                value={flowState.authorizationCode}
                onChange={(e) => {
                  updateFlowState({
                    authorizationCode: e.target.value,
                    validationError: null,
                  });
                }}
                placeholder="Enter the code from the authorization server"
                className={`flex h-9 w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                  flowState.validationError
                    ? "border-destructive"
                    : "border-input"
                }`}
              />
            </div>
            {flowState.validationError && (
              <p className="text-xs text-destructive mt-1">
                {flowState.validationError}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Once you've completed authorization in the link, paste the code
              here.
            </p>
          </div>
        </OAuthStepDetails>

        <OAuthStepDetails
          label="Token Request"
          {...getStepProps("token_request")}
        >
          {flowState.oauthMetadata && (
            <details className="text-xs mt-2">
              <summary className="cursor-pointer text-muted-foreground font-medium">
                Token Request Details
              </summary>
              <div className="mt-2 p-2 bg-muted rounded-md">
                <p className="font-medium">Token Endpoint:</p>
                <code className="block mt-1 text-xs overflow-x-auto">
                  {flowState.oauthMetadata.token_endpoint}
                </code>
              </div>
            </details>
          )}
        </OAuthStepDetails>

        <OAuthStepDetails
          label="Authentication Complete"
          {...getStepProps("complete")}
        >
          {flowState.oauthTokens && (
            <details className="text-xs mt-2">
              <summary className="cursor-pointer text-muted-foreground font-medium">
                Access Tokens
              </summary>
              <p className="mt-1 text-sm">
                Authentication successful! You can now use the authenticated
                connection. These tokens will be used automatically for server
                requests.
              </p>
              <pre className="mt-2 p-2 bg-muted rounded-md overflow-auto max-h-[300px]">
                {JSON.stringify(flowState.oauthTokens, null, 2)}
              </pre>
            </details>
          )}
        </OAuthStepDetails>
      </div>

      <div className="flex gap-3 mt-4">
        {flowState.oauthStep !== "complete" && (
          <>
            <Button
              onClick={proceedToNextStep}
              disabled={flowState.isInitiatingAuth}
            >
              {"Continue"}
            </Button>
          </>
        )}

        {flowState.oauthStep === "authorization_redirect" &&
          flowState.authorizationUrl && (
            <Button
              variant="outline"
              onClick={() => {
                setIsAuthModalOpen(true);
              }}
            >
              Authorize
            </Button>
          )}
      </div>

      {/* OAuth Authorization Modal */}
      {flowState.authorizationUrl && (
        <OAuthAuthorizationModal
          open={isAuthModalOpen}
          onOpenChange={setIsAuthModalOpen}
          authorizationUrl={String(flowState.authorizationUrl)}
        />
      )}
    </div>
  );
};
