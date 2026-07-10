import { PostHog } from "posthog-node";
import type { Context } from "hono";
import { randomUUID } from "crypto";
import type { AnalyticsEventName } from "@/shared/analytics-events";
import type { RequestLogContext } from "./log-events.js";
import { resolveEnvironment } from "./log-events.js";
import { HOSTED_MODE } from "../config.js";

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
// (client/src/lib/PosthogUtils.ts); it can only ingest, not read.
const POSTHOG_PROJECT_KEY = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
const POSTHOG_HOST = "https://us.i.posthog.com";

// Same opt-outs the client honors, plus the conventional DO_NOT_TRACK for
// npm/local installs where the server runs on the user's machine.
function isAnalyticsDisabled(): boolean {
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

function getClient(): PostHog | null {
  if (isAnalyticsDisabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_PROJECT_KEY, {
      host: POSTHOG_HOST,
      // Low-volume, high-value stream: flush each event promptly rather than
      // batching, so a process exit can't drop a queued critical event.
      flushAt: 1,
      flushInterval: 3000,
    });
  }
  return client;
}

/**
 * Capture a server-authoritative event for the actor behind a request.
 * Never throws; silently drops when analytics is disabled or the request
 * has no resolvable actor identity.
 */
export function captureServerEvent(
  c: Context,
  event: AnalyticsEventName,
  properties: Record<string, unknown> = {},
): void {
  try {
    const posthog = getClient();
    if (!posthog) return;

    const ctx = c.var.requestLogContext as RequestLogContext | undefined;
    const distinctId =
      ctx?.userExternalId ?? ctx?.guestExternalId ?? c.get("guestId") ?? null;
    if (!distinctId) return;

    posthog.capture({
      distinctId,
      event,
      properties: {
        // Retry-dedupe key: posthog-node may resend on transient failures.
        $insert_id: randomUUID(),
        platform: serverPlatform(),
        environment: resolveEnvironment(),
        source: "server",
        ...(ctx?.orgId ? { organization_id: ctx.orgId } : {}),
        ...(ctx?.projectId ? { project_id: ctx.projectId } : {}),
        ...properties,
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
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown(2000);
  } catch {
    // Losing a final flush beats hanging shutdown.
  }
  client = null;
}
