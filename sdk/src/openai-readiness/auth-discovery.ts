import { discoverProtectedResourceMetadata } from "../directory-readiness/discovery.js";
import {
  AUTH_CHALLENGE_LIMITS,
  TOOL_RESULT_AUTH_CHALLENGE_META_KEY,
} from "../mcp-client-manager/auth-challenge.js";
import {
  fetchAuthorizationServers,
  OpenAIAuthEvidence,
  OpenAIDiscoveryOptions,
  stringArray,
} from "./discovery.js";

/**
 * Read `_meta["mcp/www_authenticate"]` out of a JSON-RPC error payload.
 *
 * A server may carry the challenge in the JSON-RPC error rather than only in
 * the HTTP header, and a runner that read only the header would report a
 * conforming server as publishing no challenge at all.
 *
 * A STRING OR AN ARRAY OF STRINGS. OpenAI's documented example of this value
 * is an array of challenge strings; a reader that accepted only a string
 * would report the documented shape as no challenge at all. The entries are
 * joined with `, `, which is exactly how they would have arrived as one
 * header — the same normalization the shared tool-result parser applies.
 */
export function readMetaWwwAuthenticate(
  document: Record<string, unknown> | undefined,
): string | undefined {
  const error = document?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const meta = (error as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[
    TOOL_RESULT_AUTH_CHALLENGE_META_KEY
  ];
  const entries = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "",
  );
  if (entries.length === 0) return undefined;
  const joined = entries.join(", ");
  return joined.length > AUTH_CHALLENGE_LIMITS.rawChars
    ? joined.slice(0, AUTH_CHALLENGE_LIMITS.rawChars)
    : joined;
}

/**
 * Protected Resource Metadata and every issuer it names, from a given
 * challenge pointer.
 *
 * Separate from {@link discoverOpenAIAuthEvidence} because the pointer does
 * not always come from the first request: a lazy-authentication server
 * answers the unauthenticated `initialize`, and its challenge arrives only on
 * a protected tool call. The gatherer re-runs this from that challenge, so a
 * server whose metadata is reachable only through the challenge's
 * `resource_metadata` is graded on it rather than reported as authless.
 */
export async function discoverOpenAIAuthMetadata(
  options: OpenAIDiscoveryOptions,
  pointer: string | undefined,
): Promise<
  Pick<
    OpenAIAuthEvidence,
    "prm" | "authorizationServers" | "advertisedAuthorizationServerCount"
  >
> {
  const prm = await discoverProtectedResourceMetadata(options, pointer);

  const issuers = stringArray(prm.document?.authorization_servers);
  const authorizationServers =
    issuers.length > 0
      ? await fetchAuthorizationServers(options, issuers)
      : undefined;

  return {
    prm,
    authorizationServers,
    advertisedAuthorizationServerCount: issuers.length,
  };
}
