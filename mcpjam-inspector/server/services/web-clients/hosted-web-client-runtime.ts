/**
 * The hosted pieces bound together for one turn: the backend through the
 * process's `webClientService()`, the run's person to act as, this
 * Inspector's public HTTPS origin for the connector URL, and the
 * Playground's hosted browser booted with the account's restored profile.
 */
import { webClientVendorForRuntime } from "@/shared/web-clients";
import { configuredInspectorPublicUrl } from "../../utils/inspector-public-url.js";
import { getInternalBackendConfig } from "../internal-backend.js";
import { AuthKitVerificationError, verifyAuthKitToken } from "../authkit-jwt.js";
import { BrowserSessionService } from "../browserd/session-service.js";
import { checkSessionRevocation } from "../revoked-session-cache.js";
import { webClientService, type WebClientService } from "./backend-connector-resolver.js";
import {
  createHostedWebClientEnvironment,
  createProfileForRunClient,
  type ProfileForRun,
  type WebActor,
} from "./hosted-web-client-environment.js";
import { openWebClientHostedBrowser } from "./hosted-browser.js";
import { openWebProfile } from "./recovery/profile-cipher.js";
import type { WebClientEnvironmentFactory } from "./web-client-environment.js";

/** The person a bearer names, as the backend's service calls name them. */
export async function actorFromBearer(bearer: string): Promise<WebActor | undefined> {
  const token = bearer.replace(/^Bearer\s+/i, "");
  try {
    const session = await verifyAuthKitToken(token);
    // A session this process knows to be signed out names nobody (MJ-011).
    if (!checkSessionRevocation(session.sid, { requireFresh: false }).ok) return undefined;
    return { actorExternalId: session.sub };
  } catch (error) {
    // Not an AuthKit session (a guest or service bearer): nobody to act as.
    if (error instanceof AuthKitVerificationError) return undefined;
    throw error;
  }
}

/** Downloads the sealed profile and opens it with the run's data key. */
export async function restoreWebProfile(
  profile: ProfileForRun,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(profile.downloadUrl, { redirect: "error" });
  if (!response.ok) throw new Error("The saved browser session could not be downloaded. Sign in again.");
  const key = Buffer.from(profile.dataKey, "base64");
  try {
    return openWebProfile(new Uint8Array(await response.arrayBuffer()), key);
  } finally {
    key.fill(0);
  }
}

export function createHostedWebClientEnvironmentFactory(
  options: { service?: WebClientService; env?: NodeJS.ProcessEnv } = {},
): WebClientEnvironmentFactory | undefined {
  const service = options.service ?? webClientService(options.env);
  if (!service) return undefined;
  return async (turn) => {
    const vendor = webClientVendorForRuntime(turn.runtimeId);
    if (!vendor) throw new Error(`Not a web client runtime: ${turn.runtimeId}`);
    const actor = turn.actor ?? (turn.bearer ? await actorFromBearer(turn.bearer) : undefined);
    if (!actor) {
      throw new Error("This run has no MCPJam user to act as. Start it again while signed in.");
    }
    const publicBaseUrl = configuredInspectorPublicUrl();
    if (!publicBaseUrl?.startsWith("https://")) {
      throw new Error(
        "The vendor's app can't reach this Inspector: it has no public HTTPS address. Set its public URL, then run again.",
      );
    }
    if (!turn.bearer) {
      throw new Error("A hosted browser needs the run's MCPJam session. Start the run again while signed in.");
    }
    const bearer = turn.bearer;
    const { convexUrl, serviceToken } = getInternalBackendConfig("Claude web and ChatGPT web");
    return createHostedWebClientEnvironment({
      service,
      actor,
      publicBaseUrl,
      runId: turn.runId,
      ...(turn.iterationId ? { iterationId: turn.iterationId } : {}),
      ...(turn.chosenWebAccountId ? { chosenWebAccountId: turn.chosenWebAccountId } : {}),
      profileForRun: createProfileForRunClient({ convexHttpUrl: convexUrl, serviceToken }),
      async openHostedBrowser({ profile }) {
        const browser = await openWebClientHostedBrowser({
          bearer,
          projectId: turn.projectId,
          vendor,
          ...(turn.chatSessionId ? { chatSessionId: turn.chatSessionId } : {}),
          profileArchive: await restoreWebProfile(profile),
        });
        return {
          driver: browser.driver,
          close: async () => {
            await new BrowserSessionService().agentRequest("close", {
              bearer: /^Bearer\s/i.test(bearer) ? bearer : `Bearer ${bearer}`,
              projectId: turn.projectId,
              body: { sessionId: browser.browserSessionId },
            });
          },
        };
      },
    });
  };
}
