import { authFetch } from "@/lib/session-token";
import type {
  SubscriptionDesiredInterestsView,
  SubscriptionServerStateView,
} from "@/shared/subscription-bridge.js";

/**
 * Client for the LOCAL subscription bridge (`/api/mcp/subscriptions`).
 *
 * The browser states *desire*; the local manager's `SubscriptionCoordinator`
 * decides whether that becomes a modern `subscriptions/listen` (close + reopen
 * on a filter change) or the legacy per-URI `resources/subscribe` RPCs. There
 * is deliberately no "subscribe"/"unsubscribe" verb here on the modern path.
 */

async function postState(
  path: string,
  body: Record<string, unknown>,
): Promise<SubscriptionServerStateView> {
  const res = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: { success?: boolean; error?: string } & Record<string, unknown> =
    {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // Fall through to the status-based error below.
  }
  if (!res.ok || parsed.success === false) {
    throw new Error(
      typeof parsed.error === "string"
        ? parsed.error
        : `Subscription request failed (${res.status})`,
    );
  }
  const state = parsed.state as SubscriptionServerStateView | undefined;
  if (!state || typeof state !== "object" || !Array.isArray(state.streams)) {
    throw new Error("Subscription bridge returned no state");
  }
  return state;
}

export async function fetchSubscriptionState(
  serverId: string,
): Promise<SubscriptionServerStateView> {
  return postState("/api/mcp/subscriptions/state", { serverId });
}

export async function setDesiredSubscriptionInterests(
  serverId: string,
  desired: SubscriptionDesiredInterestsView,
): Promise<SubscriptionServerStateView> {
  return postState("/api/mcp/subscriptions/desired", { serverId, desired });
}

export async function cancelSubscriptionStream(
  serverId: string,
): Promise<SubscriptionServerStateView> {
  return postState("/api/mcp/subscriptions/cancel", { serverId });
}
