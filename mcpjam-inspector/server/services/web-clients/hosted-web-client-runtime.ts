/**
 * The hosted pieces bound together for one turn: the backend through the
 * process's `webClientService()`, the run's person to act as, this
 * Inspector's public HTTPS origin for the connector URL, and the
 * Playground's hosted browser booted with the account's restored profile.
 */
import { z } from "zod";
import { webClientVendorForRuntime } from "@/shared/web-clients";
import { createConvexClient } from "../../routes/v1/convex-client.js";
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
import { logger } from "../../utils/logger.js";
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

const currentUser = z.object({ _id: z.string().min(1), isAnonymous: z.boolean().optional() });

/**
 * The person a run's bearer names. A person's own session is checked here.
 * Anything else a run carries is the delegated session MCPJam mints for a
 * scheduled, API or swarm run's owner (`testSuiteRun.createdBy`,
 * `journeyRuns.createdByUserId`), so the backend that minted it is asked.
 * Guests are nobody: web clients don't run for them.
 */
export async function actorForRun(
  bearer: string,
  whoIs: (token: string) => Promise<unknown> = (token) =>
    createConvexClient(token).query("users:getCurrentUser" as never, {} as never),
): Promise<WebActor | undefined> {
  const person = await actorFromBearer(bearer);
  if (person) return person;
  const user = currentUser.safeParse(await whoIs(bearer.replace(/^Bearer\s+/i, "")));
  if (!user.success || user.data.isAnonymous) return undefined;
  return { actorUserId: user.data._id };
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
    const actor = turn.actor ?? (turn.bearer ? await actorForRun(turn.bearer) : undefined);
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
      ...(turn.runWebAccountIds ? { runWebAccountIds: turn.runWebAccountIds } : {}),
      profileForRun: createProfileForRunClient({ convexHttpUrl: convexUrl, serviceToken }),
      async openHostedBrowser({ profile }) {
        // Each turn's browser is its own chat's: the person's chat browser keeps
        // its own sign-ins, and a turn closing its browser never closes theirs.
        const browser = await openWebClientHostedBrowser({
          bearer,
          projectId: turn.projectId,
          vendor,
          profileArchive: await restoreWebProfile(profile),
        });
        return {
          driver: browser.driver,
          close: async () => {
            try {
              await new BrowserSessionService().agentRequest("close", {
                bearer: /^Bearer\s/i.test(bearer) ? bearer : `Bearer ${bearer}`,
                projectId: turn.projectId,
                body: { sessionId: browser.browserSessionId },
              });
            } catch (error) {
              // Closing runs after the turn's outcome is known, so a browser
              // that won't close is reported here rather than failing the turn.
              logger.warn("[web-clients] the turn's hosted browser did not close", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        };
      },
    });
  };
}
