import { createHash } from "node:crypto";
import type { Context } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { validateGuestTokenDetailedAsync } from "../../services/guest-token.js";
import { verifyAuthKitToken } from "../../services/authkit-jwt.js";
import { evaluateBrowserRollout } from "../analytics.js";
import { isLocalhostRequest } from "../localhost-check.js";
import { validateLocalProjectKey } from "./local-machine.js";

// Bound flag staleness without a network round trip for each pointer event.
const rolloutCache = new Map<
  string,
  { until: number; value: Promise<boolean> }
>();
export async function rolloutEnabled(
  local: boolean,
  actorId: string,
): Promise<boolean> {
  const key = `${local}:${actorId}`;
  const cached = rolloutCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  if (rolloutCache.size >= 512) rolloutCache.clear();
  const value = evaluateBrowserRollout(
    local ? "local-browser-enabled" : "hosted-browser-enabled",
    actorId,
  );
  rolloutCache.set(key, { until: Date.now() + 10_000, value });
  return value;
}

/** Browser-only identity: never admits a guest to shell or hosted resources. */
export async function browserRolloutActor(c: Context) {
  const token = (c.req.header("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token) return null;
  const guest = await validateGuestTokenDetailedAsync(token);
  if (guest.valid && guest.guestId) return { id: guest.guestId, guest: true };
  const established = c.get("workosUserId");
  if (typeof established === "string" && established)
    return { id: established, guest: false };
  try {
    const member = await verifyAuthKitToken(token);
    return { id: member.sub, guest: false };
  } catch {
    return null;
  }
}

export function guestBrowserPrefix(guestId: string): string {
  return `guest-browser-${createHash("sha256")
    .update(guestId)
    .digest("hex")
    .slice(0, 24)}-`;
}

export function guestBrowserProject(
  projectId: string,
  guestId: string,
): string {
  validateLocalProjectKey(projectId);
  return (
    guestBrowserPrefix(guestId) +
    createHash("sha256").update(projectId).digest("hex").slice(0, 32)
  );
}

export async function resolveBrowserRollout(c: Context, local: boolean) {
  const actor = await browserRolloutActor(c);
  if (!actor || (actor.guest && !local)) return { enabled: false, actor };
  if (
    local &&
    (HOSTED_MODE ||
      !isLocalhostRequest(c.req.header("host") ?? new URL(c.req.url).host))
  ) {
    return { enabled: false, actor: null };
  }
  return {
    actor,
    enabled: await rolloutEnabled(local, actor.id),
  };
}
