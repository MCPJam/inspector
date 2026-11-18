import type { FeatureSetupKind } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/state/app-types";

/**
 * Setup the canvas can send the reader to: a pre-registered OAuth client, in
 * the server's Configuration tab, whose next sign-in records the OAuth flow
 * summary the feature reads. XAA can be set up there too, but nothing records
 * which auth a connect used, so its result would never show here. The client
 * credentials grant, event webhooks and OpenAI onboarding are not set up in
 * Configuration. Every other setup kind reads "MCPJam cannot check this yet".
 */
export const CANVAS_SETUP_OFFERED: readonly FeatureSetupKind[] = [
  "pre-registered-client",
];

type SetupFields = Pick<
  ServerWithName,
  "registrationMode" | "oauthFlowProfile" | "useXaa" | "authMethod"
>;

/** Setup this server has saved, read from its stored auth settings. */
export function configuredSetup(server: SetupFields): FeatureSetupKind[] {
  // An XAA server saves its own pre-registered client, but signs in without
  // the OAuth flow summary the pre-registration feature reads.
  const usesXaa = server.authMethod === "xaa" || server.useXaa === true;
  const preregistered =
    server.registrationMode === "preregistered" ||
    server.oauthFlowProfile?.registrationStrategy === "preregistered";
  return preregistered && !usesXaa ? ["pre-registered-client"] : [];
}
