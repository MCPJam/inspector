import type { OAuthFlowStep } from "@mcpjam/sdk/browser";

/**
 * Request step → the received step that presents its response, for the OAuth
 * debugger's logger. Presentation pairing only: the SDK machines record each
 * exchange as ONE httpHistory entry tagged with the request step (the response
 * is attached to that same entry one click later); the logger renders the
 * response half under the paired card.
 *
 * Steps absent here never split. Verified against the entry-producing steps in
 * all three debug machines: the 2025-03-26 HTTP+SSE GET fallback logs an entry
 * tagged `complete` (unpaired → whole), and cimd_* / authorization_request /
 * verify_* produce info logs only, never httpHistory entries.
 */
const OAUTH_RECEIVED_STEP_FOR_REQUEST: Partial<
  Record<OAuthFlowStep, OAuthFlowStep>
> = {
  request_without_token: "received_401_unauthorized",
  request_resource_metadata: "received_resource_metadata",
  request_authorization_server_metadata:
    "received_authorization_server_metadata",
  request_client_registration: "received_client_credentials",
  token_request: "received_access_token",
  authenticated_mcp_request: "complete",
};

export function getOAuthReceivedStepForRequest(
  step: OAuthFlowStep,
): OAuthFlowStep | undefined {
  return OAUTH_RECEIVED_STEP_FOR_REQUEST[step];
}
