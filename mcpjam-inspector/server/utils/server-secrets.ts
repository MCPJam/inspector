import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";

export interface ServerSecretsResult {
  env: Record<string, string> | null;
  headers: Record<string, string> | null;
}

function parseRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === "string" &&
    (Object.values(ErrorCode) as string[]).includes(value)
  );
}

function statusToErrorCode(status: number): ErrorCode {
  if (status === 400) return ErrorCode.VALIDATION_ERROR;
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status === 502) return ErrorCode.SERVER_UNREACHABLE;
  if (status === 504) return ErrorCode.TIMEOUT;
  return ErrorCode.INTERNAL_ERROR;
}

const CONVEX_POST_TIMEOUT_MS = 10_000;

/**
 * POST to a Convex authorized HTTP endpoint, forwarding the caller's bearer so
 * Convex resolves the identity and enforces membership/ownership. Shared by
 * every secret-reveal / authorization gate here so the CONVEX_HTTP_URL guard,
 * timeout, abort/unreachable classification, and `{ success }` envelope check
 * can't drift across copies. Returns the parsed success body; throws
 * WebRouteError on any failure. `serviceName` only shapes error copy.
 */
async function postToConvexAuthorized(args: {
  path: string;
  bearerToken: string;
  body: Record<string, unknown>;
  serviceName: string;
}): Promise<any> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CONVEX_POST_TIMEOUT_MS
  );

  let body: any = null;
  let response: Response;
  try {
    response = await fetch(`${convexUrl}${args.path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.bearerToken}`,
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
    // Read the body while the abort signal is still armed: a Convex action
    // that flushes headers and then stalls the body would otherwise hang here
    // indefinitely (the timeout only covered the header round-trip).
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body; body stays null
    }
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error as { code?: string }).code === "ABORT_ERR");
    throw new WebRouteError(
      isAbort ? 504 : 502,
      isAbort ? ErrorCode.TIMEOUT : ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `The ${args.serviceName} timed out after ${CONVEX_POST_TIMEOUT_MS}ms`
        : `Failed to reach the ${args.serviceName}: ${parseErrorMessage(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok || !body?.success) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : `The ${args.serviceName} request failed (${response.status})`;
    throw new WebRouteError(
      response.ok ? 500 : response.status,
      statusToErrorCode(response.ok ? 500 : response.status),
      message
    );
  }
  return body;
}

export async function fetchRuntimeServerSecrets(args: {
  bearerToken: string;
  projectId: string;
  serverId: string;
  accessScope?: "project_member" | "chat_v2";
  chatboxId?: string;
  accessVersion?: number;
  /**
   * When the caller authenticated via a WorkOS API key, Inspector exchanges
   * the user bearer for `INSPECTOR_SERVICE_TOKEN` + `x-mcpjam-acting-as`
   * (the WorkOS user id / Convex `externalId`) + `x-mcpjam-acting-in-org`
   * (the org the key is bound to). Passed by `createAuthorizedManager` so
   * secret reveals during the `/api/v1/*` flow follow the same trust model
   * as `authorizeBatch`. The bearer middleware sets
   * `authMethod="workos_api_key"`; callers just forward those Context values.
   */
  workosApiKeyActingAs?: {
    workosUserId: string;
    mcpjamOrganizationId: string;
  };
}): Promise<ServerSecretsResult> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const RUNTIME_REVEAL_TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    RUNTIME_REVEAL_TIMEOUT_MS
  );

  let response: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (args.workosApiKeyActingAs) {
      const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
      if (!serviceToken) {
        throw new WebRouteError(
          500,
          ErrorCode.INTERNAL_ERROR,
          "Server missing INSPECTOR_SERVICE_TOKEN for WorkOS API key auth"
        );
      }
      headers["Authorization"] = `Bearer ${serviceToken}`;
      headers["x-mcpjam-acting-as"] = args.workosApiKeyActingAs.workosUserId;
      headers["x-mcpjam-acting-in-org"] =
        args.workosApiKeyActingAs.mcpjamOrganizationId;
    } else {
      headers["Authorization"] = `Bearer ${args.bearerToken}`;
    }

    response = await fetch(`${convexUrl}/web/server/reveal-secrets`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        purpose: "runtime",
        projectId: args.projectId,
        serverId: args.serverId,
        ...(args.accessScope ? { accessScope: args.accessScope } : {}),
        ...(args.chatboxId ? { chatboxId: args.chatboxId } : {}),
        ...(typeof args.accessVersion === "number"
          ? { accessVersion: args.accessVersion }
          : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error as { code?: string }).code === "ABORT_ERR");
    throw new WebRouteError(
      isAbort ? 504 : 502,
      ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `Secret reveal service timed out after ${RUNTIME_REVEAL_TIMEOUT_MS}ms`
        : `Failed to reach secret reveal service: ${parseErrorMessage(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code = isErrorCode(body?.code)
      ? body.code
      : statusToErrorCode(response.status);
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
        ? body.error
        : `Secret reveal failed (${response.status})`;
    throw new WebRouteError(response.status, code, message);
  }

  if (!body?.success) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Secret reveal response was invalid"
    );
  }

  return {
    env: parseRecord(body.env),
    headers: parseRecord(body.headers),
  };
}

export interface XaaResourceAppSecretResult {
  clientSecret: string;
  /** The registration's stored token endpoint — the only URL the proxy may
   * post the secret to. */
  tokenEndpoint: string | null;
  targetClientId: string | null;
  scopes: string[] | null;
}

/**
 * Resolve a registered XAA resource app's client secret (plus the stored
 * token endpoint it must be posted to) server-side, mirroring
 * fetchRuntimeServerSecrets: the caller's bearer is forwarded as-is, so the
 * backend enforces that the caller is a member of the registration's org.
 * The secret never reaches the browser.
 */
export async function fetchXaaResourceAppSecret(args: {
  bearerToken: string;
  registrationId: string;
}): Promise<XaaResourceAppSecretResult> {
  const body = await postToConvexAuthorized({
    path: "/web/xaa/resource-app/reveal-secret",
    bearerToken: args.bearerToken,
    body: { id: args.registrationId },
    serviceName: "secret-reveal service",
  });

  if (typeof body.clientSecret !== "string") {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Secret reveal response was invalid"
    );
  }

  return {
    clientSecret: body.clientSecret,
    tokenEndpoint:
      typeof body.tokenEndpoint === "string" ? body.tokenEndpoint : null,
    targetClientId:
      typeof body.targetClientId === "string" ? body.targetClientId : null,
    scopes: Array.isArray(body.scopes)
      ? body.scopes.filter((s: unknown): s is string => typeof s === "string")
      : null,
  };
}

export interface ServerClientSecretResult {
  /** null for a public client (server with no stored secret). */
  clientSecret: string | null;
  /** The server's stored OAuth client id — pinned server-side. */
  clientId: string | null;
  /** The server's stored URL, used to discover the auth server when no
   * explicit issuer is set. */
  serverUrl: string | null;
  /** Optional issuer override; takes precedence over serverUrl for discovery. */
  xaaAuthzIssuer: string | null;
  /** Per-server opt-in: accept a same-origin path-scoped authorization server
   * whose metadata advertises the origin root as issuer. Absent/false =
   * strict; the guard only relaxes on an explicit true. */
  xaaAllowPathScopedIssuer?: boolean;
}

/**
 * Resolve a server target's confidential client secret plus the non-secret
 * config (client id, url, issuer) server-side, mirroring
 * fetchXaaResourceAppSecret: the caller's bearer is forwarded as-is, so the
 * backend enforces per-server ownership. The secret never reaches the browser
 * and the inspector server — not the client — decides where it is posted.
 */
export async function fetchServerClientSecret(args: {
  bearerToken: string;
  serverId: string;
  projectId: string;
}): Promise<ServerClientSecretResult> {
  const body = await postToConvexAuthorized({
    path: "/web/xaa/server/reveal-secret",
    bearerToken: args.bearerToken,
    body: { serverId: args.serverId, projectId: args.projectId },
    serviceName: "secret-reveal service",
  });

  return {
    clientSecret:
      typeof body.clientSecret === "string" ? body.clientSecret : null,
    clientId: typeof body.clientId === "string" ? body.clientId : null,
    serverUrl: typeof body.serverUrl === "string" ? body.serverUrl : null,
    xaaAuthzIssuer:
      typeof body.xaaAuthzIssuer === "string" ? body.xaaAuthzIssuer : null,
    // Strict by default: only an explicit true from the stored config relaxes
    // the issuer check (older backends simply omit the field).
    xaaAllowPathScopedIssuer: body.xaaAllowPathScopedIssuer === true,
  };
}

/**
 * Membership gate for the org-scoped MCPJam XAA test issuer
 * (`/api/web/xaa/o/<orgId>`). Forwards the caller's bearer to Convex, which
 * resolves the identity and requires org membership (guests are always
 * rejected there). Throws a WebRouteError on any failure — minting under a
 * scoped issuer is fail-closed.
 */
export async function authorizeXaaOrgIssuer(args: {
  bearerToken: string;
  organizationId: string;
}): Promise<void> {
  await postToConvexAuthorized({
    path: "/web/xaa/issuer/authorize",
    bearerToken: args.bearerToken,
    body: { organizationId: args.organizationId },
    serviceName: "issuer-authorization service",
  });
}
