import { Hono, type Context } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { validateGuestTokenDetailedAsync } from "../../services/guest-token.js";
import { verifyAuthKitToken } from "../../services/authkit-jwt.js";
import { evaluateClientFeatureFlags } from "../../utils/analytics.js";

/**
 * Values for the PostHog flags the web client reads (MJ-015). The client
 * bootstraps posthog-js with this response and does not load flags from
 * PostHog itself; the evaluated keys are the checked-in allowlist in
 * shared/client-feature-flags.ts, whatever the request asks for.
 *
 * Whose flags:
 *  - a request with a bearer gets the flags of the identity the server
 *    verifies from it (guest token or AuthKit access token), and any
 *    `distinct_id` it also sends is ignored. A bearer that does not verify
 *    gets no values;
 *  - a request without one gets the flags of the anonymous PostHog id the
 *    client already uses (`distinct_id`).
 *
 * "No values" is a 200 with `{ flags: {} }`, never an error: the client keeps
 * the flags it already has, and app boot never depends on PostHog being
 * reachable (local, Electron and air-gapped installs included).
 */

const ANONYMOUS_ID_PATTERN = /^[\x21-\x7e]{1,200}$/;

// The platforms a local client reports (detectPlatform in PosthogUtils.ts).
// Hosted is always "web".
const LOCAL_PLATFORMS = new Set(["npm", "docker", "mac", "win", "electron"]);

async function verifiedDistinctId(token: string): Promise<string | null> {
  try {
    const guest = await validateGuestTokenDetailedAsync(token);
    if (guest.valid && guest.guestId) return guest.guestId;
  } catch {
    // Guest token service unavailable; the AuthKit check below still runs.
  }
  try {
    return (await verifyAuthKitToken(token)).sub;
  } catch {
    return null;
  }
}

async function resolveDistinctId(c: Context): Promise<string | null> {
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    return token ? verifiedDistinctId(token) : null;
  }
  const anonymousId = c.req.query("distinct_id");
  return anonymousId && ANONYMOUS_ID_PATTERN.test(anonymousId)
    ? anonymousId
    : null;
}

// The person properties the client used to send with its own flag requests,
// derived here where the server knows them.
function flagPersonProperties(c: Context): Record<string, string> {
  const reportedPlatform = c.req.query("platform");
  const platform = HOSTED_MODE
    ? "web"
    : reportedPlatform && LOCAL_PLATFORMS.has(reportedPlatform)
      ? reportedPlatform
      : undefined;
  return {
    deployment: HOSTED_MODE ? "hosted" : "self_hosted",
    ...(!HOSTED_MODE ? { local_browser_security_version: "1" } : {}),
    ...(platform ? { platform } : {}),
  };
}

const clientFlags = new Hono();

clientFlags.get("/", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Authorization");
  const distinctId = await resolveDistinctId(c);
  const flags = distinctId
    ? await evaluateClientFeatureFlags(distinctId, flagPersonProperties(c))
    : {};
  return c.json({ flags });
});

export default clientFlags;
