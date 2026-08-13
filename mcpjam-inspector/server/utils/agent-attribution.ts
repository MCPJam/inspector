/**
 * Which agent channel a `/api/v1` request arrived on, forwarded to the backend
 * so its audit trail can say more than "this human did it".
 *
 * The backend mints these onto the delegated JWT from headers that only a
 * holder of the Inspector service token can set (see the backend's
 * `lib/agentAttribution.ts`). This module decides what those headers say.
 *
 * THE SURFACE IS INFERRED HERE, NOT TRUSTED FROM THE CALLER. An `sk_` key
 * holder can put anything in `user-agent`, and a caller who could stamp
 * `surface: "workspace"` onto their own writes would make the trail actively
 * misleading — worse than the unlabelled state this replaces. So the value is
 * derived from things the gateway knows: the authentication method it just
 * resolved, and a small allowlist of first-party user agents. Anything else is
 * `rest`, which is the honest label for "someone called the API directly".
 */
import type { Context } from "hono";

/**
 * The closed vocabulary, mirroring the backend's `AGENT_SURFACES`. A closed
 * union rather than a free string because these end up in audit queries, where
 * `slack` and `Slack` and `slack-bot` being three values is how a trail stops
 * being answerable.
 */
export const AGENT_SURFACES = [
  "rest",
  "cli",
  "mcp",
  "slack",
  "discord",
  "workspace",
] as const;

export type AgentSurface = (typeof AGENT_SURFACES)[number];

export type AgentAttribution = {
  surface: AgentSurface;
  apiKeyId?: string;
  agentActionId?: string;
  requestId?: string;
};

/** Mirrors the backend's `AGENT_ATTRIBUTION_HEADERS`. */
export const AGENT_ATTRIBUTION_HEADERS = {
  surface: "x-mcpjam-agent-surface",
  apiKeyId: "x-mcpjam-agent-api-key-id",
  agentActionId: "x-mcpjam-agent-action-id",
  requestId: "x-request-id",
} as const;

/**
 * First-party user agents, by exact product token. Prefix-matched on the
 * `product/version` head so a version bump does not silently drop a surface's
 * label, but NOT substring-matched: `contains("mcpjam-cli")` would let any
 * caller relabel itself by appending our token to their own UA.
 */
const USER_AGENT_SURFACES: ReadonlyArray<[string, AgentSurface]> = [
  ["mcpjam-cli", "cli"],
  ["mcpjam-mcp-worker", "mcp"],
  ["mcpjam-workspace", "workspace"],
];

function surfaceFromUserAgent(
  userAgent: string | undefined
): AgentSurface | null {
  if (!userAgent) return null;
  const product = userAgent.trim().split(/[\s/]/, 1)[0]?.toLowerCase() ?? "";
  for (const [token, surface] of USER_AGENT_SURFACES) {
    if (product === token) return surface;
  }
  return null;
}

/**
 * The surface for this request.
 *
 * `authMethod` wins over the user agent because it is the thing the gateway
 * verified rather than the thing the caller typed: a Slack service token IS
 * the Slack bot, whatever its UA claims.
 */
export function resolveAgentSurface(c: Context): AgentSurface {
  const authMethod = c.get("authMethod");
  if (authMethod === "slack_service") return "slack";
  if (authMethod === "discord_service") return "discord";
  return surfaceFromUserAgent(c.req.header("user-agent")) ?? "rest";
}

/**
 * The attribution to forward for this request.
 *
 * `requestId` and `agentActionId` are deliberately NOT included here — see
 * `agentAttributionCacheKey` and `volatileAgentAttribution` below for why they
 * cannot ride a cached token.
 */
export function stableAgentAttribution(c: Context): AgentAttribution {
  const apiKeyId = c.get("workosApiKeyId");
  return {
    surface: resolveAgentSurface(c),
    ...(typeof apiKeyId === "string" && apiKeyId.length > 0
      ? { apiKeyId }
      : {}),
  };
}

/**
 * The per-request half of the attribution, present only when this request is
 * executing an action a human approved.
 *
 * WHY THE SPLIT. A delegated token is cached for its ~2h life, keyed by the
 * identity it was minted for. `surface` and `apiKeyId` are stable across every
 * request that shares that key, so they can be baked in. `requestId` is not:
 * a cached token carrying request A's id would attribute request B's write to
 * A, which is worse than recording nothing — a wrong id in an audit trail is
 * believed. So the volatile fields ride only tokens minted uncached, and the
 * only caller worth that cost is proposal execution, where the join between
 * "a human pressed Run it" and the row that changed is the entire point and
 * the request already does far more expensive work than one token mint.
 *
 * For everything else the request id lives in the gateway log, correlated to
 * the audit row by actor and timestamp. That is a real gap, stated rather than
 * papered over with an id that might be a lie.
 */
export function volatileAgentAttribution(
  c: Context,
  agentActionId: string
): AgentAttribution {
  return {
    ...stableAgentAttribution(c),
    agentActionId,
    ...(requestIdOf(c) ? { requestId: requestIdOf(c) } : {}),
  };
}

function requestIdOf(c: Context): string | undefined {
  const logContext = c.get("requestLogContext") as
    | { requestId?: unknown }
    | undefined;
  const requestId = logContext?.requestId;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : undefined;
}

/**
 * The part of an attribution that must participate in the delegated-token
 * cache key.
 *
 * Every field that is baked into a token has to be here, or two requests with
 * different attributions share one token and the second is mislabelled. The
 * volatile fields are absent by construction: they never reach a cached token.
 */
export function agentAttributionCacheKey(
  attribution: AgentAttribution | undefined
): string {
  if (!attribution) return "";
  return `${attribution.surface}:${attribution.apiKeyId ?? ""}`;
}

/** The mint headers for an attribution, ready to spread into a fetch. */
export function agentAttributionHeaders(
  attribution: AgentAttribution | undefined
): Record<string, string> {
  if (!attribution) return {};
  return {
    [AGENT_ATTRIBUTION_HEADERS.surface]: attribution.surface,
    ...(attribution.apiKeyId
      ? { [AGENT_ATTRIBUTION_HEADERS.apiKeyId]: attribution.apiKeyId }
      : {}),
    ...(attribution.agentActionId
      ? {
          [AGENT_ATTRIBUTION_HEADERS.agentActionId]: attribution.agentActionId,
        }
      : {}),
    ...(attribution.requestId
      ? { [AGENT_ATTRIBUTION_HEADERS.requestId]: attribution.requestId }
      : {}),
  };
}
