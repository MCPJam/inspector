import { POSTHOG_PROJECT_KEY } from "../../shared/posthog-project.js";
import { PostHog } from "posthog-node";
import { analyticsTransport } from "./analytics-transport.js";
import type { Context } from "hono";
import { randomUUID } from "crypto";
import type { ServerAnalyticsEventName } from "@/shared/analytics-events";
import type { LocalHarnessRolloutFlag } from "../../shared/harness-descriptors.js";
import {
  rolloutActorId,
  rolloutPersonProperties,
} from "../../shared/strict-server-analytics.js";
import {
  CLIENT_FEATURE_FLAG_KEYS,
  pickClientFeatureFlags,
  type ClientFeatureFlagValues,
} from "../../shared/client-feature-flags.js";
import type { RequestLogContext } from "./log-events.js";
import { resolveEnvironment } from "./log-events.js";
import { HOSTED_MODE } from "../config.js";
import { scrubDeliveredSecretsDeep } from "../../shared/delivered-secret-registry.js";
import {
  resolveFeatureFlagSource,
  rolloutAnswerWithoutPostHog,
} from "./feature-flag-source.js";

/**
 * Server-side PostHog capture for business-critical events.
 *
 * Client-side capture is ad-blockable even through the /relay proxy (a user
 * can disable JS, block the app origin, or race a page close); events that
 * feed funnel/billing/activation decisions get a server-side twin fired from
 * the route that performs the action. During the parallel-run window the
 * server twin is named `<event>_server` (see shared/analytics-events.ts) and
 * the client/server pair ratio per platform is the live block-rate metric.
 *
 * Identity contract: distinct_id MUST match the client's actorKey — the
 * WorkOS user id for signed-in users, the guestId for guests. Those arrive
 * in the request log context as userExternalId / guestExternalId after the
 * Convex authorize exchange (see routes/web/auth.ts). The Convex-internal
 * `userId` (also on the context) does NOT match and must never be used.
 * Events with no resolvable actor are dropped rather than captured
 * anonymously — an unmatched distinct_id would pollute person profiles.
 *
 * Server events go straight to us.i.posthog.com (server egress is never
 * ad-blocked) — NOT through /relay.
 */

// Public project token — same one shipped in the client bundle
// (client/src/lib/PosthogUtils.ts); it can only ingest, not read. The /relay
// proxy forwards requests for this project only.
export { POSTHOG_PROJECT_KEY } from "../../shared/posthog-project.js";
const POSTHOG_HOST = "https://us.i.posthog.com";

// Same opt-outs the client honors, plus the conventional DO_NOT_TRACK for
// npm/local installs where the server runs on the user's machine.
export function isAnalyticsDisabled(): boolean {
  const dnt = process.env.DO_NOT_TRACK;
  return (
    process.env.VITE_DISABLE_POSTHOG_LOCAL === "true" ||
    dnt === "1" ||
    dnt === "true"
  );
}

// Mirrors the pairing dimension of the client's detectPlatform(): hosted
// serves the "web" platform; the Electron-embedded and npm servers pair with
// their local clients.
function serverPlatform(): string {
  if (HOSTED_MODE) return "web";
  if (process.env.ELECTRON_APP === "true") return "electron";
  return "npm";
}

let client: PostHog | null = null;

// Feature evaluation controls product availability, so it bypasses
// `isAnalyticsDisabled()`. DO_NOT_TRACK still stops it: callers reach this
// client only when `resolveFeatureFlagSource` names PostHog, which it never
// does under DO_NOT_TRACK or when a flag file answers instead. Callers must
// also suppress feature-flag exposure events.
function getClient(forFeatureFlags = false): PostHog | null {
  if (!forFeatureFlags && isAnalyticsDisabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_PROJECT_KEY, {
      host: POSTHOG_HOST,
      disableCompression: true,
      enableExceptionAutocapture: false,
      fetch: analyticsTransport(
        POSTHOG_HOST,
        POSTHOG_PROJECT_KEY,
        isAnalyticsDisabled,
      ),
      // Low-volume, high-value stream: flush each event promptly rather than
      // batching, so a process exit can't drop a queued critical event.
      flushAt: 1,
      flushInterval: 3000,
    });
  }
  return client;
}

let batchedClient: PostHog | null = null;

/**
 * For high-volume events, such as one per Platform API request, where an
 * event lost at process exit costs a data point, not a decision. The default
 * client flushes each event on its own POST.
 */
function getBatchedClient(): PostHog | null {
  if (isAnalyticsDisabled()) return null;
  if (!batchedClient) {
    batchedClient = new PostHog(POSTHOG_PROJECT_KEY, {
      host: POSTHOG_HOST,
      disableCompression: true,
      enableExceptionAutocapture: false,
      fetch: analyticsTransport(
        POSTHOG_HOST,
        POSTHOG_PROJECT_KEY,
        isAnalyticsDisabled,
      ),
      flushAt: 20,
      flushInterval: 5000,
    });
  }
  return batchedClient;
}

/**
 * API-key and AuthKit bearer callers never pass the Convex authorize exchange
 * that fills `userExternalId`; the WorkOS user id from bearer auth IS the
 * actorKey the identity contract requires. Call before `captureServerEvent`
 * on a `/v1` route.
 */
export function fillAnalyticsActorFromBearer(c: Context): void {
  const ctx = c.var.requestLogContext as RequestLogContext | undefined;
  const workosUserId = c.get("workosUserId");
  if (ctx && !ctx.userExternalId && workosUserId) {
    c.set("requestLogContext", { ...ctx, userExternalId: workosUserId });
  }
}

/**
 * Capture a server-authoritative event for the actor behind a request.
 * Never throws; silently drops when analytics is disabled or the request
 * has no resolvable actor identity.
 */
export function captureServerEvent(
  c: Context,
  event: ServerAnalyticsEventName,
  properties: Record<string, unknown> = {},
): void {
  const ctx = c.var.requestLogContext as RequestLogContext | undefined;
  const distinctId =
    ctx?.userExternalId ?? ctx?.guestExternalId ?? c.get("guestId") ?? null;
  if (!distinctId) return;

  captureServerEventForActor(
    {
      distinctId,
      organizationId: ctx?.orgId ?? undefined,
      projectId: ctx?.projectId ?? undefined,
    },
    event,
    properties,
  );
}

/** The actor a detached event is attributed to. */
export interface ServerAnalyticsActor {
  /**
   * MUST be the same actorKey the client uses — the WorkOS user id, or the
   * guest id. The Convex-internal `userId` does NOT match and would pollute
   * person profiles.
   */
  distinctId: string;
  organizationId?: string;
  projectId?: string;
}

/**
 * Capture for work that OUTLIVES the request that started it.
 *
 * Detached execution — a readiness run, anything else handed off after a
 * `202` — has no `Context` to read an actor from by the time it finishes, and
 * the interesting event is precisely the one at the end. So the identity is
 * resolved while the request still exists and carried into the work, rather
 * than the work being left uninstrumented or attributed anonymously.
 *
 * Never throws; drops silently when analytics is disabled.
 */
export function captureServerEventForActor(
  actor: ServerAnalyticsActor,
  event: ServerAnalyticsEventName,
  properties: Record<string, unknown> = {},
  options: { batched?: boolean } = {},
): void {
  try {
    const posthog = options.batched ? getBatchedClient() : getClient();
    if (!posthog) return;
    posthog.capture({
      event,
      distinctId: actor.distinctId,
      properties: {
        ...scrubDeliveredSecretsDeep(properties),
        // Retry-dedupe key: posthog-node may resend on transient failures.
        $insert_id: randomUUID(),
        platform: serverPlatform(),
        environment: resolveEnvironment(),
        source: "server",
        // Same discriminator the client registers (client/src/lib/
        // PosthogUtils.ts) — this server runs on self-hosted machines too
        // (npm installs, the Electron-embedded local server, Docker), not
        // just the hosted Railway deployment.
        deployment: HOSTED_MODE ? "hosted" : "self_hosted",
      },
    });
  } catch {
    // Analytics must never break the request path.
  }
}

/**
 * Flush and close the client. Wire into graceful shutdown (bounded — the
 * caller's force-exit timer is the backstop).
 */
/** Rollout evaluation does not emit exposure events or trust client flags. */
export async function evaluateHostedBrowserRollout(
  distinctId: string,
): Promise<boolean> {
  const key = "hosted-browser-enabled";
  if (!rolloutActorId(distinctId)) return false;
  const answer = rolloutAnswerWithoutPostHog(key);
  if (answer !== undefined) return answer;
  try {
    return (
      (await getClient(true)?.isFeatureEnabled(key, distinctId, {
        sendFeatureFlagEvents: false,
      })) === true
    );
  } catch {
    return false;
  }
}


/**
 * A local harness rollout's own answer: yes, no, or `undefined` when the
 * request failed. Only a refusal's explanation needs the third state.
 */
export async function localHarnessRolloutAnswer(
  distinctId: string,
  trustedEmail?: string,
  flagKey: LocalHarnessRolloutFlag = "local-harness-enabled",
): Promise<boolean | undefined> {
  return serverRolloutAnswer(
    flagKey,
    distinctId,
    { deployment: "self_hosted" },
    trustedEmail,
  );
}

/** Same server-owned rollout decision for setup, launches and client visibility. */
export async function evaluateLocalHarnessRollout(
  distinctId: string,
  trustedEmail?: string,
  flagKey: LocalHarnessRolloutFlag = "local-harness-enabled",
): Promise<boolean> {
  return (await localHarnessRolloutAnswer(distinctId, trustedEmail, flagKey)) === true;
}

/**
 * A boolean rollout the server enforces, from the same flag source and person
 * properties `GET /api/web/flags` uses. No exposure events; any failure is off.
 */
export async function evaluateServerRollout(
  flagKey: string,
  distinctId: string,
  personProperties: Record<string, string>,
  trustedEmail?: string,
): Promise<boolean> {
  return (
    (await serverRolloutAnswer(
      flagKey,
      distinctId,
      personProperties,
      trustedEmail,
    )) === true
  );
}

/**
 * {@link evaluateServerRollout}'s decision, or `undefined` when there was
 * none to read: the PostHog request failed or did not evaluate the flag. A
 * caller that keeps answers keeps only a definite one.
 */
export async function serverRolloutAnswer(
  flagKey: string,
  distinctId: string,
  personProperties: Record<string, string>,
  trustedEmail?: string,
): Promise<boolean | undefined> {
  if (!rolloutActorId(distinctId)) return false;
  const answer = rolloutAnswerWithoutPostHog(flagKey);
  if (answer !== undefined) return answer;
  try {
    return await getClient(true)?.isFeatureEnabled(flagKey, distinctId, {
      sendFeatureFlagEvents: false,
      personProperties: rolloutPersonProperties(personProperties, trustedEmail),
    });
  } catch {
    // A request that failed is no answer; callers read it as off.
    return undefined;
  }
}

/**
 * Values for the flags the web client reads, for `GET /api/web/flags`
 * (MJ-015). Only allowlisted keys are evaluated or returned, no exposure
 * events are sent, and any failure yields `{}` so the client keeps its own
 * fallback instead of failing the page. A flag file's answers are the same for
 * every visitor; under DO_NOT_TRACK without one, every flag is off.
 */
export async function evaluateClientFeatureFlags(
  distinctId: string,
  personProperties: Record<string, string>,
  trustedEmail?: string,
): Promise<ClientFeatureFlagValues> {
  if (!rolloutActorId(distinctId)) return {};
  const source = resolveFeatureFlagSource();
  if (source.kind === "file") return pickClientFeatureFlags(source.answers);
  if (source.kind === "off") return {};
  try {
    const values = await getClient(true)?.getAllFlags(distinctId, {
      flagKeys: [...CLIENT_FEATURE_FLAG_KEYS],
      personProperties: rolloutPersonProperties(personProperties, trustedEmail),
    });
    return pickClientFeatureFlags(values);
  } catch {
    return {};
  }
}

export async function shutdownAnalytics(): Promise<void> {
  const clients = [client, batchedClient].filter(
    (c): c is PostHog => c !== null,
  );
  client = null;
  batchedClient = null;
  await Promise.all(
    clients.map(async (c) => {
      try {
        await c.shutdown(2000);
      } catch {
        // Losing a final flush beats hanging shutdown.
      }
    }),
  );
}
