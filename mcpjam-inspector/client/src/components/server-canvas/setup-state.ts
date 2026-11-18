import type { FeatureSetupKind } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/state/app-types";

/**
 * Setup the canvas can send the reader to: both live in the server's
 * Configuration tab, and both lead to evidence once the server reconnects
 * (the OAuth flow summary, or a captured XAA connect). The app cannot set up
 * the client credentials grant, event webhooks or OpenAI onboarding, so
 * those features say MCPJam cannot check them yet instead of offering a step.
 */
export const CANVAS_SETUP_OFFERED: readonly FeatureSetupKind[] = [
  "pre-registered-client",
  "enterprise-managed-authorization",
];

type SetupFields = Pick<
  ServerWithName,
  "registrationMode" | "oauthFlowProfile" | "useXaa" | "authMethod"
>;

/** Setup this server has saved, read from its stored auth settings. */
export function configuredSetup(server: SetupFields): FeatureSetupKind[] {
  const configured: FeatureSetupKind[] = [];
  if (
    server.registrationMode === "preregistered" ||
    server.oauthFlowProfile?.registrationStrategy === "preregistered"
  ) {
    configured.push("pre-registered-client");
  }
  // `useXaa` mirrors the backend's xaaConfigured rule for "auto" servers.
  if (server.authMethod === "xaa" || server.useXaa === true) {
    configured.push("enterprise-managed-authorization");
  }
  return configured;
}
