/**
 * The forwarding endpoint's defaults for who may use a web connector, decided
 * the way the rest of the Inspector decides: AuthKit as the authorization
 * server for the vendor's OAuth token, and `web-clients-enabled` from the same
 * flag source and person properties as the other server rollouts.
 */
import {
  WEB_CLIENT_SITES,
  WEB_CLIENTS_FEATURE_FLAG,
} from "../../../shared/web-clients.js";
import { HOSTED_MODE } from "../../config.js";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { serverRolloutAnswer } from "../../utils/analytics.js";
import { rolloutAnswerWithoutPostHog } from "../../utils/feature-flag-source.js";
import {
  AuthKitConfigError,
  AuthKitVerificationError,
  resolveAuthkitIssuer,
  resolveWorkosClientId,
  verifyAuthKitResourceToken,
} from "../authkit-jwt.js";

const VENDOR_ORIGINS = new Set(Object.values(WEB_CLIENT_SITES).flat());

/**
 * Whether a request with this `Origin` may use a connector. DNS rebinding and
 * cross-site requests come from a browser page, which names its origin. The
 * vendors' MCP clients run on their servers and name none; a vendor's own
 * site, or a page the Inspector already trusts, may.
 */
export function connectorOriginAllowed(origin: string | undefined): boolean {
  return (
    !origin || VENDOR_ORIGINS.has(origin) || isAllowedRequestOrigin(origin)
  );
}

/** The AuthKit issuer this Inspector already trusts, when it knows one. */
export function authkitAuthorizationServers(): string[] {
  const clientId = resolveWorkosClientId();
  const issuer = clientId ? resolveAuthkitIssuer(clientId) : undefined;
  return issuer ? [issuer] : [];
}

/** The MCPJam user (WorkOS user id) a vendor's token names, if it is valid here. */
export async function verifyAuthKitBearer(
  token: string,
  context: { audiences: string[] },
): Promise<{ userId: string } | undefined> {
  try {
    const session = await verifyAuthKitResourceToken(token, context.audiences);
    return { userId: session.sub };
  } catch (error) {
    if (
      error instanceof AuthKitVerificationError ||
      error instanceof AuthKitConfigError
    )
      return undefined;
    throw error;
  }
}

/** How long a definite answer stands for one user, so a flag change lands within a minute. */
const ANSWER_TTL_MS = 60_000;
const keptAnswers = new Map<string, { enabled: boolean; until: number }>();

/**
 * `web-clients-enabled` for the user an OAuth token names. A capability
 * connector names no user, so only a flag file can turn it on; PostHog has
 * no one to ask about.
 */
export async function webClientsEnabledFor(userId?: string): Promise<boolean> {
  if (!userId)
    return rolloutAnswerWithoutPostHog(WEB_CLIENTS_FEATURE_FLAG) === true;
  const now = Date.now();
  const kept = keptAnswers.get(userId);
  if (kept && kept.until > now) return kept.enabled;
  const answer = await serverRolloutAnswer(
    WEB_CLIENTS_FEATURE_FLAG,
    userId,
    HOSTED_MODE
      ? { deployment: "hosted", platform: "web" }
      : { deployment: "self_hosted" },
  );
  if (keptAnswers.size >= 1000) keptAnswers.clear();
  // A failed lookup is not kept, so one failure never holds a user off.
  if (answer !== undefined)
    keptAnswers.set(userId, { enabled: answer, until: now + ANSWER_TTL_MS });
  return answer === true;
}
