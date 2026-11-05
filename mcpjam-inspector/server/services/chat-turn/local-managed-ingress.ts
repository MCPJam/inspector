import type { Context } from "hono";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import { HOSTED_MODE } from "../../config.js";

/** The local session gate has already run; managed setup also needs a bearer. */
export async function localManagedIngress(
  c: Context,
  run: (context: Context) => Promise<Response>,
): Promise<Response> {
  // Defense in depth for direct mounts as well as the production partition.
  if (HOSTED_MODE) {
    return c.json(
      { error: "Local chat is unavailable on a hosted service." },
      410,
    );
  }
  const authRefusal = await bearerAuthMiddleware(c, async () => {
    const rateRefusal = await guestRateLimitMiddleware(c, async () => {
      c.res = await run(c);
    });
    if (rateRefusal) c.res = rateRefusal;
  });
  return authRefusal ?? c.res;
}
