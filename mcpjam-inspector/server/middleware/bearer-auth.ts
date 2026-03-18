import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { validateGuestTokenDetailedAsync } from "../services/guest-token.js";

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
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Bearer token required" },
      401,
    );
  }

  const token = authHeader.slice("Bearer ".length);

  // Try validating as a guest token
  try {
    const result = await validateGuestTokenDetailedAsync(token);
    if (result.valid && result.guestId) {
      c.set("guestId", result.guestId);
      return next();
    }
  } catch {
    // Guest token service not initialized — treat as non-guest token
  }

  // Not a guest token — assume WorkOS token, allow through
  return next();
}
