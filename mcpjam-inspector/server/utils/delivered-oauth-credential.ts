/**
 * Credentials the MCPJam backend delivered to this process stay in it, and go
 * only where they were issued for. A delivered OAuth token (a person's own
 * sign-in, a project-shared or uploaded account) is attached only to the
 * origins the backend bound it to (`oauthBoundOrigins`, each account's
 * `boundOrigins`), or, when it names none, to the server's origin as this
 * connection found it. Its value is registered for exact-value scrubbing, and
 * `credentialSource: "mcpjam-backend"` keeps the connection out of replay.
 * Bindings wrap `hostedMcpBaseFetch()`, so the MJ-001 egress guard stays.
 */
import { isLoopbackOAuthUrl } from "@mcpjam/sdk/oauth/node";
import type {
  HttpServerConfig,
  MCPClientManager,
  MCPServerConfig,
  UnauthorizedRefreshHandler,
} from "@mcpjam/sdk";
import type { AuthorizedOAuthConnection } from "../../shared/oauth-connections.js";
import { registerDeliveredSecret } from "../../shared/delivered-secret-registry.js";
import {
  bindCredentialHeaders,
  credentialOrigin,
  type CredentialHeaderBinding,
} from "./credential-header-binding.js";
import { hostedMcpBaseFetch } from "./hosted-mcp-base-fetch.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { logger } from "./logger.js";

type DeliveredFields = Pick<
  HttpServerConfig,
  "baseFetch" | "credentialHeaderNames" | "credentialSource"
>;

type Target = { serverId?: string; serverName?: string };

/** The parts of a connection config the origin rules read. */
type ConnectionUrl = { url?: string | URL; credentialSource?: string };

/** The backend's bound origins, or `undefined` when it sent none. */
function boundOriginsFrom(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((origin) =>
    typeof origin === "string" ? (credentialOrigin(origin) ?? []) : [],
  );
}

function tokenNotSent(serverUrl: string | URL, target: Target): WebRouteError {
  const server = target.serverName ? `"${target.serverName}"` : "This server";
  const origin = credentialOrigin(serverUrl) ?? String(serverUrl);
  return new WebRouteError(
    401,
    ErrorCode.UNAUTHORIZED,
    `${server} now points at ${origin}, so its sign-in was not sent. Sign in again to connect.`,
    {
      oauthRequired: true,
      serverId: target.serverId,
      serverName: target.serverName ?? null,
      serverUrl: String(serverUrl),
    },
  );
}

/**
 * Hold a delivered OAuth token's `Authorization` header to the origins the
 * backend bound it to, on `fetchFn` and every redirect hop, and register the
 * value for scrubbing. Throws the sign-in refusal when the token may not go to
 * `url` at all.
 */
export function bindDeliveredToken(args: {
  fetchFn: typeof fetch;
  url: string | URL;
  token: string;
  /** `oauthBoundOrigins` or an account's `boundOrigins`, as received. */
  boundOrigins: unknown;
  accountKind?: string;
  accountUploaded?: boolean;
  target: Target;
}): typeof fetch {
  const secure = (origin: string) =>
    origin.startsWith("https:") || isLoopbackOAuthUrl(origin);
  const target = credentialOrigin(args.url);
  const requiresHttps = args.accountKind === "shared" || args.accountKind === "uploaded" || args.accountUploaded === true;
  if (requiresHttps && target && !secure(target)) {
    throw new WebRouteError(403, ErrorCode.FORBIDDEN,
      "This server needs HTTPS to use its saved sign-in. Ask a server administrator to configure HTTPS.",
      { credentialRefusal: "insecure_transport", serverId: args.target.serverId });
  }
  const bound = (boundOriginsFrom(args.boundOrigins) ?? (target ? [target] : [])).filter((origin) => !requiresHttps || secure(origin));
  if (target === null || !bound.includes(target)) {
    throw tokenNotSent(args.url, args.target);
  }
  const fetchFn = bindCredentialHeaders(args.fetchFn, {
    headerNames: ["authorization"],
    boundOrigins: bound,
  });
  // The bound fetch lives as long as the connection, so it holds the value.
  registerDeliveredSecret(args.token, "oauth-token", fetchFn);
  return fetchFn;
}

/**
 * A local manager's connection with its delivered token: held to its bound
 * origins on `fetchFn`, its refreshes registered for scrubbing, and marked so
 * replay skips it. Throws the sign-in refusal when the token may not go to the
 * connection's URL.
 */
export function deliveredConnection(args: {
  config: HttpServerConfig;
  fetchFn: typeof fetch;
  delivered: { token: string; bound: unknown; accountKind?: string; accountUploaded?: boolean };
  target: Target;
}): { config: HttpServerConfig; fetchFn: typeof fetch } {
  const { config, delivered } = args;
  const fetchFn = bindDeliveredToken({
    fetchFn: args.fetchFn,
    url: config.url,
    token: delivered.token,
    boundOrigins: delivered.bound,
    accountKind: delivered.accountKind,
    accountUploaded: delivered.accountUploaded,
    target: args.target,
  });
  return {
    fetchFn,
    config: {
      ...config,
      credentialSource: "mcpjam-backend",
      ...(config.onUnauthorized
        ? {
            onUnauthorized: registeringDeliveredToken(
              config.onUnauthorized,
              fetchFn,
            ),
          }
        : {}),
    },
  };
}

/**
 * Register the credential values among stored headers the backend delivered,
 * so a shared `X-API-Key` standing alone in an error is scrubbed too.
 */
export function registerStoredHeaders(
  headers: Record<string, string> | null | undefined,
  credentialNames: readonly string[] | undefined,
): void {
  if (!headers) return;
  const names = new Set(
    (credentialNames ?? Object.keys(headers)).map((name) => name.toLowerCase()),
  );
  for (const [name, value] of Object.entries(headers)) {
    if (names.has(name.toLowerCase())) {
      registerDeliveredSecret(value, "stored-header");
    }
  }
}

/**
 * The binding a connection's delivered credentials need when another client
 * sends them (a conformance run builds its own fetch): held to the server's
 * own origin, so a redirect or a discovered endpoint elsewhere never gets them.
 */
export function deliveredCredentialBinding(
  config: Pick<HttpServerConfig, "url" | "credentialSource" | "credentialHeaderNames">,
): CredentialHeaderBinding | undefined {
  const headerNames = [
    ...(config.credentialHeaderNames ?? []),
    ...(config.credentialSource === "mcpjam-backend" ? ["authorization"] : []),
  ];
  if (headerNames.length === 0) return undefined;
  const origin = credentialOrigin(config.url);
  return { headerNames, boundOrigins: origin ? [origin] : [] };
}

/** A stored-header binding that leaves `Authorization` to a delivered token's. */
export function withoutAuthorization(
  binding: CredentialHeaderBinding,
): CredentialHeaderBinding {
  return {
    ...binding,
    headerNames: binding.headerNames.filter(
      (name) => name.toLowerCase() !== "authorization",
    ),
  };
}

/**
 * What a connection to `url` adds for the credentials the backend delivered:
 * stored headers held to their bound origins, an OAuth `token` held to its
 * own. Throws the sign-in refusal when the token may not go to `url`.
 */
export function deliveredCredentialFields(args: {
  url: string | URL;
  token: string | null | undefined;
  /** `oauthBoundOrigins` or an account's `boundOrigins`, as received. */
  boundOrigins: unknown;
  accountKind?: string;
  accountUploaded?: boolean;
  stored: CredentialHeaderBinding | undefined;
  target: Target;
}): DeliveredFields {
  const fields: DeliveredFields = {};
  let fetchFn: typeof fetch | undefined;
  if (args.stored) {
    fields.credentialHeaderNames = args.stored.headerNames;
    fetchFn = bindCredentialHeaders(
      hostedMcpBaseFetch(),
      args.token ? withoutAuthorization(args.stored) : args.stored,
    );
  }
  if (args.token) {
    fetchFn = bindDeliveredToken({
      fetchFn: fetchFn ?? hostedMcpBaseFetch(),
      url: args.url,
      token: args.token,
      boundOrigins: args.boundOrigins,
      accountKind: args.accountKind,
      accountUploaded: args.accountUploaded,
      target: args.target,
    });
    fields.credentialSource = "mcpjam-backend";
  }
  if (fetchFn) fields.baseFetch = fetchFn;
  return fields;
}

/**
 * The refusal for a reconnect that would send a delivered token to another
 * origin than the connection it replaces held one for. Only when the backend
 * bound no origins; when it did, `deliveredCredentialFields` decides.
 */
function deliveredTokenMoved(
  prior: ConnectionUrl | undefined,
  next: ConnectionUrl,
  boundOrigins: unknown,
  target: Target,
): WebRouteError | undefined {
  if (
    !next.url ||
    next.credentialSource !== "mcpjam-backend" ||
    prior?.credentialSource !== "mcpjam-backend" ||
    boundOriginsFrom(boundOrigins) ||
    credentialOrigin(prior.url) === credentialOrigin(next.url)
  ) {
    return undefined;
  }
  return tokenNotSent(next.url, target);
}

/**
 * The same check before a default-account reconnect. A refused reconnect
 * closes the old connection but keeps its entry, so the next attempt is
 * refused too until the person disconnects and connects again.
 */
export async function refuseMovedDeliveredToken(
  manager: Pick<MCPClientManager, "getServerConfig" | "disconnectServer">,
  key: string,
  resolved: {
    config: MCPServerConfig;
    authorizeResult: { oauthBoundOrigins?: unknown };
  },
  target: Target,
): Promise<WebRouteError | undefined> {
  if (resolved.config.credentialSource !== "mcpjam-backend") return undefined;
  const refusal = deliveredTokenMoved(
    manager.getServerConfig(key),
    resolved.config,
    resolved.authorizeResult.oauthBoundOrigins,
    target,
  );
  if (refusal) {
    await manager.disconnectServer(key).catch((error: unknown) => {
      logger.debug("Failed to close a connection whose address moved", {
        serverId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return refusal;
}

/** The fields for one extra account's connection; throws when it is refused. */
export function deliveredAccountFields(args: {
  manager: Pick<MCPClientManager, "getServerConfig">;
  key: string;
  baseKey: string;
  url: string | URL;
  account: AuthorizedOAuthConnection;
  stored: CredentialHeaderBinding | undefined;
  target: Target;
}): DeliveredFields {
  const fields = deliveredCredentialFields({
    url: args.url,
    token: args.account.accessToken,
    boundOrigins: args.account.boundOrigins,
    accountKind: args.account.accountKind,
    accountUploaded: args.account.accountUploaded,
    stored: args.stored,
    target: args.target,
  });
  const refusal = deliveredTokenMoved(
    args.manager.getServerConfig(args.key) ??
      args.manager.getServerConfig(args.baseKey),
    { url: args.url, ...fields },
    args.account.boundOrigins,
    args.target,
  );
  if (refusal) throw refusal;
  return fields;
}

/**
 * An `onUnauthorized` hook whose refreshed token is registered too, as what
 * `holder` (the connection's bound fetch, when it has one) now sends.
 */
export function registeringDeliveredToken(
  handler: UnauthorizedRefreshHandler,
  holder?: object,
): UnauthorizedRefreshHandler {
  return async (context) => {
    const result = await handler(context);
    registerDeliveredSecret(result.accessToken, "oauth-token", holder);
    return result;
  };
}

const accountBindings = new WeakMap<object, Map<string, string>>();

/**
 * Whether an account connection still has the bindings it was connected with.
 * A reused connection keeps its old ones, so a narrowed origin list has to
 * reconnect; call `connected` once it has.
 */
export function accountBinding(manager: object, key: string, parts: unknown[]) {
  const value = JSON.stringify(parts);
  const bindings = accountBindings.get(manager) ?? new Map<string, string>();
  accountBindings.set(manager, bindings);
  return {
    unchanged: bindings.get(key) === value,
    connected: () => void bindings.set(key, value),
  };
}

type DeliveredAccountKind = "shared" | "uploaded";

const accountKinds = new WeakMap<object, Map<string, DeliveredAccountKind>>();

/**
 * Remember which kind of account a connection's delivered token belongs to:
 * the server's `oauthAccountKind`, or its default account's. Absent (a
 * person's own sign-in, or no delivered token) clears it.
 */
export function recordDeliveredAccountKind(
  manager: object,
  key: string,
  resolved: {
    config: Pick<MCPServerConfig, "credentialSource">;
    authorizeResult: {
      oauthAccountKind?: unknown;
      oauthConnections?: AuthorizedOAuthConnection[];
    };
  },
): void {
  const { oauthAccountKind, oauthConnections } = resolved.authorizeResult;
  const kind =
    oauthAccountKind ?? oauthConnections?.find((c) => c.isDefault)?.accountKind;
  const kinds =
    accountKinds.get(manager) ?? new Map<string, DeliveredAccountKind>();
  accountKinds.set(manager, kinds);
  if (
    resolved.config.credentialSource === "mcpjam-backend" &&
    (kind === "shared" || kind === "uploaded")
  ) {
    kinds.set(key, kind);
  } else {
    kinds.delete(key);
  }
}

/**
 * Why a connection may not be published through a tunnel, or `undefined`.
 * Whoever holds a tunnel's URL acts with the connection's credential, and a
 * project-shared or uploaded account was delivered for this person's own use.
 */
export function tunnelRefusal(
  manager: object | undefined,
  key: string,
): string | undefined {
  const kind = manager ? accountKinds.get(manager)?.get(key) : undefined;
  if (!kind) return undefined;
  const account =
    kind === "shared"
      ? "an account shared with the project"
      : "an uploaded test account";
  return `"${key}" uses ${account}, so you can't create a tunnel for it. Tunnels can share only a server you signed in to yourself.`;
}
