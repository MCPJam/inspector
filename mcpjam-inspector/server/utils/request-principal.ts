import { createHash } from "node:crypto";
import type { Context } from "hono";

/**
 * Who is making a request: whose budget it spends, whose session it may read.
 *
 * Dispatched on `authMethod` — the credential class `bearerAuthMiddleware`
 * verified — rather than on which identity variables happen to be set. A
 * verified session is keyed on its user, so every tab and every refreshed
 * token of one account shares one budget per server. A bearer the gateway
 * passed through unverified is keyed on the token itself, HASHED: it is a
 * credential, and an in-memory table has no business holding the raw value.
 */
export function principalKey(c: Context): string {
  switch (c.get("authMethod")) {
    case "workos_api_key": {
      const keyId = c.get("workosApiKeyId");
      if (keyId) return `key:${keyId}`;
      break;
    }
    case "guest": {
      const guestId = c.get("guestId");
      if (guestId) return `guest:${guestId}`;
      break;
    }
    case "authkit_jwt":
    // The linked user, never the bot the service credential names.
    case "slack_service":
    case "discord_service": {
      const userId = c.get("workosUserId");
      if (userId) return `user:${userId}`;
      break;
    }
  }
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  return `bearer:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}
