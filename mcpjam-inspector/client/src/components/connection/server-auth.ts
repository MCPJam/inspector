import type { ServerFormAuthType } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { hasOAuthConfig } from "@/lib/oauth/mcp-oauth";

/**
 * How a saved server authenticates, read from the server record alone.
 *
 * The edit form and the Auth tab both ask this, so it lives here once: a second
 * copy would drift on the canonical-wins rule (a persisted "auto" shows as
 * Auto, not as whichever flow it currently derives to).
 */
export type ServerAuthBearer =
  | { kind: "value"; token: string }
  /** Saved, but the value was stripped from the config (redacted load). */
  | { kind: "stored" }
  | null;

export type ServerAuthHeaders =
  | { kind: "values"; entries: Array<[string, string]> }
  /** Saved, but the values were stripped from the config (redacted load). */
  | { kind: "stored" }
  | null;

export interface ServerAuth {
  method: ServerFormAuthType;
  bearer: ServerAuthBearer;
  /** Custom headers, without an Authorization header already shown as the
   * bearer token. */
  headers: ServerAuthHeaders;
}

export function isAuthorizationHeader(key: string): boolean {
  return key.trim().toLowerCase() === "authorization";
}

export function getAuthorizationHeaderValue(
  headers?: Record<string, unknown>,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (isAuthorizationHeader(key) && typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

export function getRedactedConfigFlag(
  config: unknown,
  flag: "hasEnv" | "hasHeaders" | "hasBearerToken",
): boolean {
  return (
    !!config &&
    typeof config === "object" &&
    (config as Record<string, unknown>)[flag] === true
  );
}

/**
 * Splits revealed header values. Only a bearer-auth server pulls its
 * Authorization header into the bearer token. OAuth/none servers keep
 * Authorization as a normal custom header (e.g. Basic auth, or an OAuth access
 * token surfaced as a header), so we don't silently switch their auth type or
 * strip the row.
 */
export function splitAuthorizationHeader(
  method: ServerFormAuthType,
  headers: Record<string, string> | null | undefined,
): { bearerToken: string | undefined; entries: Array<[string, string]> } {
  const entries = Object.entries(headers ?? {});
  const authorizationValue = entries.find(([key]) =>
    isAuthorizationHeader(key),
  )?.[1];
  const bearerToken =
    method === "bearer" &&
    typeof authorizationValue === "string" &&
    authorizationValue.startsWith("Bearer ")
      ? authorizationValue.replace("Bearer ", "")
      : undefined;
  return {
    bearerToken,
    entries: entries.filter(
      ([key]) => !(bearerToken !== undefined && isAuthorizationHeader(key)),
    ),
  };
}

/**
 * The names-only side of the same rule. A stored Authorization header only
 * stops being a header row when a reveal would route it into the bearer token,
 * which is exactly a bearer server with a stored bearer token. An OAuth/none
 * server can hold an Authorization header of its own (Basic auth, say);
 * dropping that from the names would hide a row that reappears the moment the
 * values land.
 */
export function headerNamesWithoutBearer(
  method: ServerFormAuthType,
  hasStoredBearerToken: boolean,
  names: string[],
): string[] {
  if (method !== "bearer" || !hasStoredBearerToken) return names;
  return names.filter((key) => !isAuthorizationHeader(key));
}

export function resolveServerAuth(server: ServerWithName): ServerAuth {
  const config = server.config;
  const isHttpServer = "url" in config;

  // Check if OAuth is configured by looking at multiple sources:
  // 1. Check if server has oauth tokens
  // 2. Check if there's stored OAuth data
  let hasOAuth = false;
  let hasServerOAuth = false;
  if (isHttpServer) {
    // Bind stored-credential reads to the exact server URL so a reused
    // server name can't surface a previous authorization server's data.
    const httpServerUrl = config.url ? config.url.toString() : undefined;
    hasServerOAuth =
      server.useOAuth === true ||
      server.oauthTokens != null ||
      server.oauthFlowProfile != null;
    hasOAuth = hasServerOAuth || hasOAuthConfig(server.name, httpServerUrl);
  }

  const requestHeaders = isHttpServer
    ? (config.requestInit?.headers as Record<string, unknown> | undefined)
    : undefined;
  const normalizedAuthorizationHeader =
    getAuthorizationHeaderValue(requestHeaders)?.trim();
  const hasBearer =
    typeof normalizedAuthorizationHeader === "string" &&
    normalizedAuthorizationHeader.toLowerCase().startsWith("bearer ");
  // Redacted configs strip the Authorization header but set hasBearerToken.
  // Treat that as a bearer server whose token is stored-but-hidden, the
  // same way hasClientSecret / hasHeaders flag other stripped secrets.
  const hasStoredBearerToken =
    isHttpServer &&
    !hasBearer &&
    (server.hasBearerToken === true ||
      getRedactedConfigFlag(config, "hasBearerToken"));

  // The CANONICAL authMethod wins over the derived booleans (see
  // feedback: canonical-wins-every-read-site) — a persisted "auto" must
  // display as Automatic, not as whichever flow it currently derives to.
  // On legacy rows XAA is checked FIRST: an XAA server keeps
  // `useOAuth === false`, so without this branch it would fall through to
  // the "oauth" catch-all and a save would silently rewrite it to OAuth.
  const canonicalAuthType =
    server.authMethod === "auto" ||
    server.authMethod === "oauth" ||
    server.authMethod === "xaa" ||
    server.authMethod === "bearer" ||
    server.authMethod === "none"
      ? server.authMethod
      : undefined;
  const method: ServerFormAuthType =
    canonicalAuthType ??
    (server.useXaa === true
      ? "xaa"
      : hasServerOAuth
        ? "oauth"
        : hasBearer || hasStoredBearerToken
          ? "bearer"
          : hasOAuth
            ? "oauth"
            : "none");

  const bearer: ServerAuthBearer = hasBearer
    ? {
        kind: "value",
        token: normalizedAuthorizationHeader.slice("bearer ".length),
      }
    : hasStoredBearerToken
      ? { kind: "stored" }
      : null;

  const localEntries = Object.entries(requestHeaders ?? {})
    .filter(
      ([key]) =>
        !(method === "bearer" && hasBearer && isAuthorizationHeader(key)),
    )
    .map(([key, value]): [string, string] => [key, String(value)]);
  const headers: ServerAuthHeaders =
    localEntries.length > 0
      ? { kind: "values", entries: localEntries }
      : isHttpServer &&
          (server.hasHeaders === true ||
            getRedactedConfigFlag(config, "hasHeaders"))
        ? { kind: "stored" }
        : null;

  return { method, bearer, headers };
}
