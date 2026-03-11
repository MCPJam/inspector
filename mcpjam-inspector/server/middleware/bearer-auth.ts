import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import {
  getGuestTokenFingerprint,
  validateGuestTokenDetailed,
} from "../services/guest-token.js";
import { logger } from "../utils/logger.js";

/**
 * Reusable Hono middleware that:
 * 1. Requires a Bearer token in the Authorization header (401 if missing).
 * 2. Attempts to validate it as a guest JWT.
 * 3. If valid guest token, sets c.set("guestId", guestId).
 * 4. If not a guest token, assumes WorkOS and passes through.
 */
export async function bearerAuthMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const shouldDebug = c.req.path.includes("/chat-v2");
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    if (shouldDebug) {
      logger.info(
        `[guest-auth-debug] bearer missing_or_malformed path=${c.req.path}`,
      );
    }
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Bearer token required" },
      401,
    );
  }

  const token = authHeader.slice("Bearer ".length);
  const tokenFingerprint = getGuestTokenFingerprint(token);

  // Try validating as a guest token
  try {
    const result = validateGuestTokenDetailed(token);
    if (result.valid && result.guestId) {
      c.set("guestId", result.guestId);
      if (shouldDebug) {
        logger.info(
          `[guest-auth-debug] bearer guest_accepted path=${c.req.path} guestId=${result.guestId} token=${tokenFingerprint}`,
        );
      }
      return next();
    }
    if (shouldDebug) {
      logger.info(
        `[guest-auth-debug] bearer guest_rejected path=${c.req.path} reason=${result.reason ?? "unknown"} token=${tokenFingerprint} fallback=non_guest`,
      );
    }
  } catch {
    // Guest token service not initialized — treat as non-guest token
    if (shouldDebug) {
      logger.warn(
        `[guest-auth-debug] bearer validation_unavailable path=${c.req.path} token=${tokenFingerprint} fallback=non_guest`,
      );
    }
  }

  // Not a guest token — assume WorkOS token, allow through
  return next();
}
