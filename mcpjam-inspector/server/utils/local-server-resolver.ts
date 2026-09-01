import type { Context } from "hono";
import type { MCPClientManager, MCPServerConfig } from "@mcpjam/sdk";
import { narrowElicitationToLocalSupport } from "../routes/mcp/elicitation.js";
import {
  registerLocalMrtrCollector,
  withLocalMrtrElicitationCapability,
} from "../routes/mcp/mrtr.js";
import {
  describeError,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  isUnauthorized401,
  type McpProtocolVersion,
} from "@mcpjam/sdk";
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";
import {
  buildHostedOAuthUnauthorizedHandler,
  refreshHostedOAuthAccessTokenWithLocalFallback,
} from "./hosted-oauth-refresh.js";
import { logger } from "./logger.js";
import { maybeCaptureOriginError } from "./error-origin-capture.js";
import {
  parseXaaPolicyValue,
  resolveEffectiveAuthMethod,
  withXaaExtensionCapability,
  xaaPolicyRequiresConfiguration,
  type EffectiveAuthMethod,
} from "./effective-auth.js";
import type { XaaEnterprisePolicy } from "@mcpjam/sdk";
import { exportSingleServerForInspection } from "./export-helpers.js";
import { ConvexHttpClient } from "convex/browser";
import { getInspectorClientRuntimeConfig } from "../env.js";
import { setRequestLogContext } from "./request-logger.js";
import {
  type InternalLogContext,
  mapInternalToRequestContext,
} from "./internal-log-context.js";
import {
  fetchRuntimeServerSecrets,
  fetchServerClientSecret,
} from "./server-secrets.js";
import {
  buildXaaMintArgs,
  isXaaMintErrorReported,
  mintXaaAccessToken,
  resolveXaaConnectIssuer,
  resolveXaaConnectRegistrationMode,
} from "../services/xaa-mint.js";
import { toXaaConnectFailure } from "../services/xaa-connect-error.js";
import {
  getLocalConfidentialCimdProvider,
  withSkillsExtensionCapability,
} from "@mcpjam/sdk";
import type { ConnectionDefaults } from "../../shared/connection-defaults.js";
import { HOSTED_MODE } from "../config.js";
import {
  materializePluginStdioForConnect,
  releasePluginLease,
} from "../services/plugins/local-stdio.js";
import type { PluginStdioLaunchSpec } from "../services/plugins/plugin-root.js";

type LocalAuthorizeServerConfig =
  | {
      transportType: "http";
      url: string;
      // Declared wire transport from a plugin manifest (parser
      // `httpVariant`), once the backend persists + serves it. Absent on
      // every ordinary row and on older backends — absence means "no
      // declaration", never a default.
      httpVariant?: "streamable-http" | "sse";
      headers: Record<string, string>;
      hasHeaders?: boolean;
      timeout?: number;
      clientCapabilities?: unknown;
      useOAuth?: boolean;
      oauthScopes?: string[];
      clientId?: string;
      oauthResourceUrl?: string;
      // Cross-App Access (XAA) non-secret config. The secret + token endpoint
      // are resolved separately via the hardened reveal-secret path at mint time.
      useXaa?: boolean;
      authServerMode?: "mcpjam" | "own";
      xaaAuthzIssuer?: string;
      xaaAllowPathScopedIssuer?: boolean;
      xaaSubject?: string;
      xaaEmail?: string;
      // Backend-resolved identity failure: a LEGACY partial per-server
      // override (one member stored) can't resolve an atomic identity, so
      // the backend omits BOTH identity fields and sends this actionable,
      // value-free message instead. The mint must fail with it — never
      // silently fall back to the demo identity.
      xaaIdentityError?: string;
      // Unified canonical auth fields (useOAuth/useXaa are their derived
      // compat mirrors). Absent on legacy rows.
      authMethod?: "auto" | "oauth" | "xaa" | "bearer" | "none";
      registrationMode?: "auto" | "preregistered" | "cimd" | "dcr";
      xaaClientAuth?: "none" | "private_key_jwt";
    }
  | {
      transportType: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      /**
       * Working directory for the child process. For plugin components this
       * arrives as a `${PLUGIN_ROOT}`-rooted template and is substituted at
       * materialization, immediately before the SDK config is built.
       */
      cwd?: string;
      hasEnv?: boolean;
      timeout?: number;
      clientCapabilities?: unknown;
    };

type LocalAuthorizeBatchSuccess = {
  ok: true;
  role: string;
  accessLevel: string;
  permissions: { chatOnly: boolean };
  serverConfig: LocalAuthorizeServerConfig;
  oauthAccessToken?: string | null;
  internalLogContext?: InternalLogContext;
};

type LocalAuthorizeBatchFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type LocalAuthorizeBatchResult =
  | LocalAuthorizeBatchSuccess
  | LocalAuthorizeBatchFailure;

export type LocalAuthorizeBatchResponse = {
  organizationId?: string | null;
  isAnonymous?: boolean;
  results: Record<string, LocalAuthorizeBatchResult>;
};

/**
 * Read the WorkOS or guest bearer the client attached to a /api/mcp/* request.
 * Local mode runs both `X-MCP-Session-Auth` (loopback secret, checked by
 * sessionAuthMiddleware) AND `Authorization: Bearer ...` (Convex actor identity).
 * The session token alone gates access to the local API process; Convex itself
 * still enforces project ownership via the bearer.
 */
export function readLocalApiBearer(c: Context): string | null {
  const raw = c.req.header("Authorization") ?? c.req.header("authorization");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

function hasNonEmptyStringRecord(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).some(
      ([, recordValue]) => typeof recordValue === "string"
    )
  );
}

/**
 * Delegated-identity exchange for callers authenticated via a WorkOS API key
 * (the harness proxy passes an EMPTY bearer on that path): Inspector swaps
 * the bearer for `INSPECTOR_SERVICE_TOKEN` + acting-as headers, exactly as
 * `fetchRuntimeServerSecrets` and the hosted `authorizeBatch` exchange do.
 * The backend resolves delegation before JWT verification, so the local
 * authorize endpoint honors the same trust model.
 */
export interface WorkosApiKeyActingAs {
  /** WorkOS user id (Convex `externalId`), NOT the Convex user `_id`. */
  workosUserId: string;
  mcpjamOrganizationId: string;
}

/**
 * Call Convex `/web/authorize-batch-local` with the user's bearer.
 * Returns the full server config for each requested serverId, including
 * STDIO command/args/env. Hosted-only fields (share/scenario tokens) are not
 * accepted by this endpoint by design.
 *
 * `c` is only a request-log sink; callers without a live Hono context (the
 * web-route stdio divert inside `createAuthorizedManager`, whose caller
 * already logged attribution from the hosted batch) pass `null` and skip it.
 */
export async function authorizeBatchLocal(
  c: Context | null,
  bearerToken: string,
  projectId: string,
  serverIds: string[],
  workosApiKeyActingAs?: WorkosApiKeyActingAs
): Promise<LocalAuthorizeBatchResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  // Cap the call so a hung Convex instance can't tie up the inspector worker
  // for the inbound /api/mcp/connect or /api/mcp/servers/reconnect request.
  // 10s is well above the 99p of the underlying authorize* query and below
  // most browser/proxy idle timeouts.
  const AUTHORIZE_BATCH_LOCAL_TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    AUTHORIZE_BATCH_LOCAL_TIMEOUT_MS
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (workosApiKeyActingAs) {
    const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
    if (!serviceToken) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing INSPECTOR_SERVICE_TOKEN for WorkOS API key auth"
      );
    }
    headers["Authorization"] = `Bearer ${serviceToken}`;
    headers["x-mcpjam-acting-as"] = workosApiKeyActingAs.workosUserId;
    headers["x-mcpjam-acting-in-org"] =
      workosApiKeyActingAs.mcpjamOrganizationId;
  } else {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize-batch-local`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, serverIds }),
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
        ? `Authorization service timed out after ${AUTHORIZE_BATCH_LOCAL_TIMEOUT_MS}ms`
        : `Failed to reach authorization service: ${parseErrorMessage(error)}`
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
    const code =
      typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Authorization failed (${response.status})`;
    throw new WebRouteError(response.status, code as ErrorCode, message);
  }

  if (!body?.results || typeof body.results !== "object") {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorization response is missing batch results"
    );
  }

  const raw = body as LocalAuthorizeBatchResponse;
  const successful = Object.entries(raw.results).filter(
    (entry): entry is [string, LocalAuthorizeBatchSuccess] => entry[1].ok
  );
  const sourceCtx = successful.find(([, r]) => r.internalLogContext)?.[1]
    .internalLogContext;
  if (sourceCtx && c) {
    const partial = mapInternalToRequestContext(sourceCtx);
    if (successful.length > 1) {
      // Multi-server batch: a single per-server identifier on the request log
      // line would be misleading. Null them out so the line aggregates over
      // the batch instead.
      partial.serverId = null;
      partial.serverTransport = null;
      partial.scenarioId = null;
    }
    setRequestLogContext(c, partial);
  }

  // Strip internalLogContext from results so it never leaks downstream.
  const stripped: Record<string, LocalAuthorizeBatchResult> = {};
  for (const [serverId, result] of Object.entries(raw.results)) {
    if (result.ok) {
      const { internalLogContext: _omit, ...clean } = result;
      stripped[serverId] = clean;
    } else {
      stripped[serverId] = result;
    }
  }
  return {
    organizationId:
      typeof raw.organizationId === "string" ? raw.organizationId : null,
    isAnonymous:
      typeof raw.isAnonymous === "boolean" ? raw.isAnonymous : undefined,
    results: stripped,
  };
}

/**
 * Convenience wrapper: authorize a single server and return the {success: true}
 * payload directly. Throws WebRouteError for any non-ok result.
 */
export async function authorizeServerLocal(
  c: Context | null,
  bearerToken: string,
  projectId: string,
  serverId: string,
  workosApiKeyActingAs?: WorkosApiKeyActingAs
): Promise<
  LocalAuthorizeBatchSuccess & {
    organizationId?: string | null;
    isAnonymous?: boolean;
  }
> {
  const batch = await authorizeBatchLocal(
    c,
    bearerToken,
    projectId,
    [serverId],
    workosApiKeyActingAs
  );
  const result = batch.results[serverId];
  if (!result) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      `Authorization response is missing result for server "${serverId}"`
    );
  }
  if (!result.ok) {
    throw new WebRouteError(
      result.status,
      result.code as ErrorCode,
      result.message
    );
  }
  return {
    ...result,
    organizationId: batch.organizationId,
    isAnonymous: batch.isAnonymous,
  };
}

// Header precedence (lowest → highest) when the resolver merges these
// onto Convex-stored server config: Convex-stored server headers, project
// default headers from `defaults.headers`, OAuth `Authorization` (if the
// server uses OAuth), so OAuth always wins.

/**
 * Validate `connectionDefaults` from an /api/mcp/* request body. Returns
 * `undefined` for missing/non-object input so the caller can fall back to
 * Convex-stored values. Drops any fields that aren't of the expected shape
 * rather than rejecting the whole request — defaults are advisory.
 */
export function parseConnectionDefaults(
  raw: unknown
): ConnectionDefaults | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const out: ConnectionDefaults = {};

  if (input.headers && typeof input.headers === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      input.headers as Record<string, unknown>
    )) {
      if (typeof v === "string") headers[k] = v;
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
  }

  if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)) {
    out.timeoutMs = input.timeoutMs;
  }

  if (
    input.clientCapabilities &&
    typeof input.clientCapabilities === "object"
  ) {
    out.clientCapabilities = input.clientCapabilities as Record<
      string,
      unknown
    >;
  }

  // Accept clientInfo as a plain object (not null/array/scalar). Drop on
  // shape mismatch rather than reject — a malformed payload shouldn't kill
  // the whole connect request. Extras-only objects (`{ title: "..." }`
  // without name/version) survive this gate because the upstream MCP
  // Client backfills name/version from manager defaults; gating on
  // name/version presence here used to silently drop forward-compat
  // payloads where the host only wanted to pin `title` or future spec
  // fields.
  if (
    input.clientInfo &&
    typeof input.clientInfo === "object" &&
    !Array.isArray(input.clientInfo)
  ) {
    const ci = input.clientInfo as Record<string, unknown>;
    // Require at least one own enumerable key so a literal `{}` doesn't
    // hash distinctly from "field omitted" in downstream wire logs.
    if (Object.keys(ci).length > 0) {
      out.clientInfo = ci as ConnectionDefaults["clientInfo"];
    }
  }

  // Accept the full supportedProtocolVersions array. Filter to non-empty
  // trimmed strings — preserves order (semantic per the SDK contract:
  // `supportedProtocolVersions[0]` is what the SDK proposes). Drop the
  // field entirely if no valid entries remain.
  if (Array.isArray(input.supportedProtocolVersions)) {
    const versions = input.supportedProtocolVersions
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    if (versions.length > 0) {
      out.supportedProtocolVersions = versions;
    }
  }

  // Pinned MCP protocol version. Membership-gate against
  // MCP_PROTOCOL_VERSIONS at this trust boundary (per the
  // validate-then-route discipline) so typo strings drop to undefined
  // instead of slipping through to the factory's open-routing
  // predicate.
  if (
    typeof input.mcpProtocolVersion === "string" &&
    isKnownProtocolVersion(input.mcpProtocolVersion)
  ) {
    out.mcpProtocolVersion = input.mcpProtocolVersion;
  }

  // SEP-2243 mirroring knob. Only an explicit `false` is honored: `true` and
  // absent both mean "mirror", which is what the SDK does with no field, and
  // an unrecognized value must fail closed into the conforming default rather
  // than into the simulation.
  if (input.mirrorToolParamHeaders === false) {
    out.mirrorToolParamHeaders = false;
  }

  // Sibling client-conformance knobs, same fail-closed reading: only the
  // explicit non-default value opts into the simulation.
  if (input.firstPageOnly === true) {
    out.firstPageOnly = true;
  }
  if (input.supportsMrtr === false) {
    out.supportsMrtr = false;
  }
  if (input.suppressLegacyRequestCancellation === true) {
    out.suppressLegacyRequestCancellation = true;
  }
  if (input.suppressModernRequestCancellation === true) {
    out.suppressModernRequestCancellation = true;
  }

  // Enterprise-managed authorization policy. UNLIKE every field above, this
  // one is enforcement, not advisory: silently dropping a malformed value
  // would un-enforce a policy the host believes is on (fail-open), so the
  // shared gate throws 409 instead. Local connects are the user's own
  // session — body-sourced policy here is self-tampering only.
  const xaaPolicy = parseXaaPolicyValue(input.xaaPolicy);
  if (xaaPolicy) out.xaaPolicy = xaaPolicy;

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Can this connection land on the 2026-era (modern) protocol?
 *
 * Deliberately asks the NEGATIVE question — "is a modern landing ruled out?" —
 * and defaults to `true`. That is the difference from the `isModernOnlyLocalConnection`
 * predicate this supersedes (see `withLocalMrtrElicitationCapability` in
 * `routes/mcp/mrtr.ts`): proving a connection *must* land modern is impossible
 * for the common case, an unpinned auto-negotiated connection, where auto in
 * fact lands modern against a modern server. Proving it *cannot* is decidable
 * from the config alone, which is all this needs — the only cost of a `true`
 * here is that a url the host config already declared stays declared.
 *
 * Ruled out by:
 * - **stdio** — the SDK factory throws `StatelessRequiresHttpTransport`; the
 *   modern era is HTTP-only, so a stdio connection is always legacy.
 * - **a legacy protocol pin** — an explicit non-stateless `mcpProtocolVersion`.
 * - **a legacy-only accept-list** — a `supportedProtocolVersions` naming no
 *   stateless version, so negotiation cannot arrive at one.
 *
 * ## Why every version goes through `isKnownProtocolVersion` first
 *
 * `isStatelessProtocolVersion` is a DENY-list (`!STATEFUL.has(v)`), so it
 * answers `true` for any unrecognized string — its own docblock says to call
 * it only after the membership check. `supportedProtocolVersions` is taken
 * verbatim from the host profile and validated for non-emptiness only, so a
 * typo (`"2025-11-52"`) would otherwise classify as stateless and put `url` on
 * a connection that lands legacy — inverting this predicate's fail-closed
 * direction on exactly the malformed input where it matters most.
 */
function canLandModernEra(
  serverConfig: { transportType?: string },
  options?: {
    mcpProtocolVersion?: McpProtocolVersion;
    supportedProtocolVersions?: string[];
  }
): boolean {
  const isModernVersion = (version: string): boolean =>
    isKnownProtocolVersion(version) && isStatelessProtocolVersion(version);

  if (serverConfig.transportType !== "http") return false;
  if (options?.mcpProtocolVersion) {
    return isModernVersion(options.mcpProtocolVersion);
  }
  const acceptList = options?.supportedProtocolVersions;
  if (acceptList && acceptList.length > 0) {
    return acceptList.some(isModernVersion);
  }
  return true;
}

/**
 * Build an `MCPServerConfig` (the SDK's union of stdio + http configs) from a
 * local authorize result. Distinct from hosted's `toHttpConfig` which strips
 * STDIO and rejects non-HTTPS — this is the unstripped local-mode equivalent.
 */
export function toMCPServerConfig(
  authResult: LocalAuthorizeBatchSuccess,
  options?: {
    timeoutMs?: number;
    oauthAccessToken?: string;
    clientCapabilities?: Record<string, unknown>;
    defaultHeaders?: Record<string, string>;
    /**
     * Identity needed to attach the SDK's `onUnauthorized` 401-recovery hook
     * for hosted-OAuth servers. When all four are present and the server has
     * a hosted OAuth token, the hook calls Convex `/web/oauth/force-refresh`
     * with this same bearer to mint a fresh token without prompting reconnect.
     * Header-only HTTP servers and stdio servers never get the hook.
     */
    refreshContext?: {
      bearerToken: string;
      projectId: string;
      serverId: string;
      serverName: string;
    };
    /**
     * XAA re-mint hook. When the server uses Cross-App Access, the connect
     * resolver builds a bounded (one-shot) handler that re-mints the access
     * token on a 401. Attached only when `serverConfig.useXaa === true` — the
     * OAuth `refreshContext` path and this are mutually exclusive.
     */
    xaaUnauthorizedHandler?: () => Promise<{ accessToken: string }>;
    /**
     * Per-connection MCP `initialize.params.clientInfo` override resolved
     * from `hostConfig.mcpProfile.initialize.clientInfo`. Undefined means
     * "use SDK defaults" (the inspector's hardcoded clientInfo). Forwarded
     * verbatim to MCPClientManager so extra fields (`title`, future spec
     * additions) survive without an SDK bump.
     */
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    /**
     * Per-connection supported protocol versions accept-list, resolved
     * verbatim from `hostConfig.mcpProfile.initialize.supportedProtocolVersions`.
     * Undefined means "use SDK defaults" — the upstream Client falls back
     * to its built-in `SUPPORTED_PROTOCOL_VERSIONS`. When set, the SDK
     * sends `supportedProtocolVersions[0]` as
     * `initialize.params.protocolVersion` and uses the full list as the
     * accept-set; a server negotiating any listed version is accepted, an
     * unlisted version fails fast.
     */
    supportedProtocolVersions?: string[];
    /**
     * Resolved per-server pinned MCP protocol version —
     * `resolveEffectiveMcpProtocolVersion` already applied (server
     * override > host default > undefined). Forwarded only for HTTP
     * configs; the SDK factory throws `StatelessRequiresHttpTransport`
     * for stdio when the pin is stateless, so we silently skip on stdio
     * rather than crash a non-HTTP server config a user toggled the
     * host default on for.
     */
    mcpProtocolVersion?: McpProtocolVersion;
    /**
     * SEP-2243 `Mcp-Param-*` mirroring policy, already reduced to the boolean
     * the SDK config takes: `false` when the host asked to simulate a client
     * that does not mirror (`mcpProfile.toolParamHeaderMirroring: "omit"`),
     * `undefined` for the conforming default.
     *
     * HTTP-only, like the pin above — mirroring is a Streamable HTTP concern
     * and the flag is inert on stdio, so it is not forwarded there.
     */
    mirrorToolParamHeaders?: boolean;
    /**
     * Client-conformance knobs. UNLIKE the mirroring flag above these are NOT
     * HTTP-only — pagination truncation is enforced on JSON-RPC frames and
     * the MRTR knob works through capability advertisement — so they are
     * forwarded on the stdio branch too.
     */
    firstPageOnly?: boolean;
    supportsMrtr?: boolean;
    suppressLegacyRequestCancellation?: boolean;
    suppressModernRequestCancellation?: boolean;
    /**
     * The host's enterprise-managed authorization policy (validated `on`
     * value). Present ⇒ the EMA extension is advertised on EVERY server of
     * this host — including explicit-OAuth overrides and stdio servers: the
     * client's *support* for enterprise-managed auth is host-wide, even
     * where a specific connection's auth flow is overridden. Also feeds the
     * effective-auth resolution for the per-connection merge condition.
     */
    xaaPolicy?: XaaEnterprisePolicy;
  }
): MCPServerConfig {
  const { serverConfig } = authResult;
  const timeout = options?.timeoutMs ?? serverConfig.timeout;
  const baseClientCapabilities =
    options?.clientCapabilities ??
    (serverConfig.clientCapabilities as Record<string, unknown> | undefined);
  // Spec (MCP enterprise-managed authorization): a client whose access is
  // enterprise-managed MUST advertise the extension in initialize. Merged —
  // never overwriting — into whatever capabilities the caller configured.
  // Advertised when the connection actually uses XAA (the backstop) or
  // whenever the host's enterprise policy is on (host-wide declare-support).
  const xaaMerged =
    options?.xaaPolicy != null ||
    (serverConfig.transportType === "http" &&
      resolveEffectiveAuthMethod(serverConfig, options?.xaaPolicy) === "xaa")
      ? withXaaExtensionCapability(baseClientCapabilities)
      : baseClientCapabilities;
  // Skills over MCP (SEP-2640). In LOCAL mode the inspector IS the MCPJam
  // client, and it ships the fulfiller: the verified read path in
  // `server-skills.ts` plus the chat wrapper in `server-skill-tools.ts`. So
  // advertise = enforce is satisfied unconditionally here, and the declaration
  // is not gated on the `skills-enabled` product flag — that flag controls UI
  // rollout, and gating a PROTOCOL declaration on a client-evaluated flag would
  // make the wire depend on a hidden switch (and would be unreadable from the
  // server anyway). Hosted connections get the declaration from the host's
  // stored `clientCapabilities` instead, which is why only the MCPJam persona
  // advertises there.
  const skillsMerged = withSkillsExtensionCapability(xaaMerged);
  // Advertise = enforce, per era. The MODERN fulfiller (the MRTR bridge)
  // completes url rounds; the LEGACY one (the inbound `elicitation/create` SSE
  // bridge) is form-only. So `elicitation.url` — which the host toggle writes —
  // may go on the wire only for a connection that can actually land modern.
  const clientCapabilities = narrowElicitationToLocalSupport(skillsMerged, {
    urlCapable: canLandModernEra(serverConfig, options),
  });

  if (serverConfig.transportType === "stdio") {
    const stdio: any = {
      command: serverConfig.command,
      args: serverConfig.args ?? [],
      env: serverConfig.env ?? {},
    };
    // A plugin component's substituted working directory (or any declared
    // cwd) must reach the transport — the MCPClientManager forwards it to
    // the child process spawn.
    if (serverConfig.cwd !== undefined) stdio.cwd = serverConfig.cwd;
    if (typeof timeout === "number") stdio.timeout = timeout;
    if (clientCapabilities) {
      stdio.capabilities = clientCapabilities;
      stdio.clientCapabilities = clientCapabilities;
    }
    // mcpProfile.initialize fields flow into the SDK's per-server config.
    // Undefined skips the field entirely so callers that don't opt in stay
    // byte-identical to historical behavior on the wire.
    if (options?.clientInfo) stdio.clientInfo = options.clientInfo;
    if (
      options?.supportedProtocolVersions &&
      options.supportedProtocolVersions.length > 0
    ) {
      stdio.supportedProtocolVersions = options.supportedProtocolVersions;
    }
    // The conformance knobs DO apply on stdio (see the options docblock), so
    // unlike the mirroring flag they are forwarded here as well as on HTTP.
    if (options?.firstPageOnly === true) stdio.firstPageOnly = true;
    if (options?.supportsMrtr === false) stdio.supportsMrtr = false;
    if (options?.suppressLegacyRequestCancellation === true)
      stdio.suppressLegacyRequestCancellation = true;
    if (options?.suppressModernRequestCancellation === true)
      stdio.suppressModernRequestCancellation = true;
    return stdio as MCPServerConfig;
  }

  // Header precedence for HTTP servers: Convex-stored server headers form the
  // base, project-default headers from the runtime `defaultHeaders` overlay
  // them (so org/project policy can add headers without touching individual
  // server records), and a bearer for OAuth-using servers always wins because
  // it carries the actor identity.
  const headers: Record<string, string> = {
    ...(serverConfig.headers ?? {}),
    ...(options?.defaultHeaders ?? {}),
  };
  const oauthToken = options?.oauthAccessToken ?? authResult.oauthAccessToken;
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
  }

  // Match the legacy connect-path shape: legacy `connect.ts` upgrades the
  // URL string to a `URL` object before calling `connectToServer`, and any
  // downstream code (HOSTED_MODE protocol checks, future SDK / middleware
  // logic that does `instanceof URL` or accesses `.protocol`/`.hostname`)
  // has been validated against that shape. Passing a string here would be
  // silent drift between the two paths.
  let url: URL;
  try {
    url = new URL(serverConfig.url);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Server config has an invalid URL: ${serverConfig.url}`
    );
  }

  const http: any = {
    url,
    requestInit: { headers },
  };
  // Plugin-declared transports are authoritative: `sse` skips the Streamable
  // HTTP attempt, `streamable-http` rules out the silent SSE downgrade. Rows
  // without a declaration keep the SDK's URL-heuristic + fallback behavior.
  //
  // `preferSSE: false` is load-bearing on the streamable-http branch: the SDK
  // resolves `config.preferSSE ?? url.pathname.endsWith("/sse")`, so a
  // DECLARED streamable-http server served at a `/sse` path would otherwise
  // be routed straight to SSE by the URL heuristic and never attempt
  // Streamable HTTP at all — `disableSseFallback` only guards the fallback
  // AFTER an attempt, so it cannot rescue that case.
  if (serverConfig.httpVariant === "sse") {
    http.preferSSE = true;
  } else if (serverConfig.httpVariant === "streamable-http") {
    http.preferSSE = false;
    http.disableSseFallback = true;
  }
  if (typeof timeout === "number") http.timeout = timeout;
  if (clientCapabilities) {
    http.capabilities = clientCapabilities;
    http.clientCapabilities = clientCapabilities;
  }
  // mcpProfile.initialize fields — same opt-in shape as the stdio branch.
  if (options?.clientInfo) http.clientInfo = options.clientInfo;
  if (
    options?.supportedProtocolVersions &&
    options.supportedProtocolVersions.length > 0
  ) {
    http.supportedProtocolVersions = options.supportedProtocolVersions;
  }
  // Outbound wire mode — only forwarded for HTTP configs (the SDK
  // factory rejects stateless on stdio at construction time). Undefined
  // = SDK default (legacy upstream Client + initialize).
  if (options?.mcpProtocolVersion)
    http.mcpProtocolVersion = options.mcpProtocolVersion;
  // Only `false` says anything — `undefined` and `true` both mean "mirror",
  // and writing `true` would put a field on every connection that never
  // carried one.
  if (options?.mirrorToolParamHeaders === false)
    http.mirrorToolParamHeaders = false;
  if (options?.firstPageOnly === true) http.firstPageOnly = true;
  if (options?.supportsMrtr === false) http.supportsMrtr = false;
  if (options?.suppressLegacyRequestCancellation === true)
    http.suppressLegacyRequestCancellation = true;
  if (options?.suppressModernRequestCancellation === true)
    http.suppressModernRequestCancellation = true;

  // Attach the SDK's 401-recovery hook only when this is a hosted-OAuth
  // server (we have a token from `authorize-batch-local`) AND the caller
  // supplied refresh context. Header-only HTTP servers can't be refreshed
  // server-side, so the hook would be a no-op there. A "discover" server
  // (non-XAA auto) that HAS a token is on its stored-OAuth rung and gets the
  // same hook; tokenless discover connects bare and recovers via the tagged
  // 401 instead.
  //
  // INVARIANT: deliberately resolved WITHOUT the enterprise policy. The
  // policy and no-policy resolutions differ only for an UNCONFIGURED `auto`
  // server (xaa vs discover), and that case throws
  // XAA_CONNECTION_NOT_CONFIGURED before any config/hook is built — so by
  // the time hooks attach, both resolutions agree. If policy semantics ever
  // change an ENROLLED server's resolution, this must start taking the
  // policy too (covered by a test in local-server-resolver tests).
  const effectiveAuthForHooks = resolveEffectiveAuthMethod(serverConfig);
  if (
    oauthToken &&
    (effectiveAuthForHooks === "oauth" ||
      effectiveAuthForHooks === "discover") &&
    options?.refreshContext
  ) {
    http.onUnauthorized = buildHostedOAuthUnauthorizedHandler({
      bearerToken: options.refreshContext.bearerToken,
      projectId: options.refreshContext.projectId,
      serverId: options.refreshContext.serverId,
      serverName: options.refreshContext.serverName,
      // In local mode this process is the one that can reach a private
      // authorization server. Covers the in-flight 401 during a long session,
      // not just the connect. `!HOSTED_MODE` rather than `true`:
      // toMCPServerConfig is exported, so gate at the call site too instead of
      // relying solely on the assertion inside local-oauth-refresh.
      allowPrivateAuthorizationServerFallback: !HOSTED_MODE,
    });
  } else if (
    oauthToken &&
    effectiveAuthForHooks === "xaa" &&
    options?.xaaUnauthorizedHandler
  ) {
    // XAA re-mint on 401 — mutually exclusive with the OAuth hook above.
    http.onUnauthorized = options.xaaUnauthorizedHandler;
  }

  return http as MCPServerConfig;
}

/**
 * Runtime resolution shared by every local connect surface, applied AFTER
 * authorization and BEFORE the SDK config is built:
 *
 *   1. Vault-backed runtime secrets — fill in env (stdio) / headers (http)
 *      the authorize batch deliberately omitted (`hasEnv` / `hasHeaders`
 *      with no values).
 *   2. Plugin bundle materialization — stdio components whose config still
 *      carries the SDK's `${PLUGIN_ROOT}` placeholders (the parser preserves
 *      them verbatim; substitution belongs at spawn) resolve against the
 *      verified local bundle cache, so a launch can never inherit a stale
 *      root and a component whose plugin was just disabled fails closed
 *      instead of running from cached files.
 *
 * Order matters: materialization substitutes over the COMPLETE env, so
 * secrets must land first.
 */
async function applyLocalRuntimeResolution<
  T extends LocalAuthorizeBatchSuccess
>(
  result: T,
  args: {
    bearerToken: string;
    projectId: string;
    serverId: string;
    /**
     * The key THIS surface's manager registers the server under — the plugin
     * bundle lease is bound to it, so acquire and any later release always
     * agree. /api/mcp managers key by display name; web-route managers key
     * by serverId (display names are user-entered and can collide across
     * servers, which would let one server's reconnect drop another's lease).
     */
    managerKey: string;
    serverDisplayName?: string;
    /** Secret-reveal scope; must match what the hosted mint path would send. */
    accessScope?: "project_member" | "chat_v2";
    scenarioId?: string;
    accessVersion?: number;
    workosApiKeyActingAs?: WorkosApiKeyActingAs;
    /**
     * Caller-held plugin bundle lease (see `materializePluginStdioForConnect`).
     * Absent ⇒ the process-wide registry, which is what the /api/mcp
     * long-lived manager wants.
     */
    onPluginLease?: (release: () => void) => void;
  }
): Promise<T> {
  const { bearerToken, projectId, serverId } = args;
  const needsRuntimeSecrets =
    (result.serverConfig.transportType === "stdio" &&
      result.serverConfig.hasEnv === true &&
      !hasNonEmptyStringRecord(result.serverConfig.env)) ||
    (result.serverConfig.transportType === "http" &&
      result.serverConfig.hasHeaders === true &&
      !hasNonEmptyStringRecord(result.serverConfig.headers));
  if (needsRuntimeSecrets) {
    const secrets = await fetchRuntimeServerSecrets({
      bearerToken,
      projectId,
      serverId,
      accessScope: args.accessScope,
      scenarioId: args.scenarioId,
      accessVersion: args.accessVersion,
      workosApiKeyActingAs: args.workosApiKeyActingAs,
    });
    result = {
      ...result,
      serverConfig:
        result.serverConfig.transportType === "stdio"
          ? {
              ...result.serverConfig,
              env: secrets.env ?? result.serverConfig.env ?? {},
            }
          : {
              ...result.serverConfig,
              headers: {
                ...(result.serverConfig.headers ?? {}),
                ...(secrets.headers ?? {}),
              },
            },
    };
  }

  if (result.serverConfig.transportType === "stdio") {
    const stdioConfig = result.serverConfig;
    const materialized = await materializePluginStdioForConnect({
      // Lazy: an ordinary stdio server must not pay a Convex read — or
      // require Convex configuration at all — to connect.
      createClient: () => {
        // The plugin runtime reads ride the Convex QUERY protocol (a user
        // JWT via setAuth) — the service-token acting-as exchange is an
        // HTTP-route header mechanism and cannot authenticate
        // `client.query()`. A delegated (WorkOS API key) caller's bearer is
        // deliberately empty, so fail closed with the real reason instead of
        // letting the reads run unauthenticated into a confusing 401.
        if (args.workosApiKeyActingAs) {
          throw new WebRouteError(
            501,
            ErrorCode.FEATURE_NOT_SUPPORTED,
            `Server "${
              args.serverDisplayName ?? args.managerKey
            }" is a plugin component; plugin materialization is not yet supported for API-key (delegated) callers.`,
            { serverId }
          );
        }
        return createPluginRuntimeConvexClient(bearerToken);
      },
      projectId,
      serverId,
      serverName: args.managerKey,
      displayName: args.serverDisplayName ?? args.managerKey,
      onLease: args.onPluginLease,
      spec: {
        command: stdioConfig.command,
        args: stdioConfig.args ?? [],
        env: stdioConfig.env ?? {},
        // A plugin component's declared cwd rides the config as a
        // `${PLUGIN_ROOT}`-rooted template; substitution happens with the
        // rest of the launch spec.
        ...(stdioConfig.cwd !== undefined
          ? { workingDirectory: stdioConfig.cwd }
          : {}),
      },
    });
    if (materialized) {
      logger.debug("[plugin-stdio] materialized bundle for launch", {
        serverId,
        pluginId: materialized.origin.pluginId,
        bundleHash: materialized.origin.bundleHash,
      });
      result = {
        ...result,
        serverConfig: {
          ...stdioConfig,
          command: materialized.command,
          args: materialized.args,
          env: materialized.env,
          ...(materialized.workingDirectory !== undefined
            ? { cwd: materialized.workingDirectory }
            : {}),
        },
      };
    }
  }

  return result;
}

/**
 * The stdio launch spec exactly as CONFIGURED — full command/args/env with
 * runtime secrets applied, placeholders still verbatim.
 *
 * Same re-read and same trust model as {@link resolveLocalStdioServerConfig}
 * (`/web/authorize-batch-local` with the caller's own bearer, so authorization
 * is re-checked rather than assumed), stopping one step earlier: no plugin
 * materialization and no SDK config. Hosted plugin execution needs precisely
 * this, because it substitutes the placeholders for paths inside a SANDBOX and
 * never builds a local spawn config at all.
 *
 * Refuses an http row for the same reason the local resolver does: a transport
 * mismatch between the two authorize reads means the row changed mid-request.
 *
 * Takes NO delegated-identity (WorkOS API key) option, unlike its siblings: the
 * one caller refuses those callers outright before reaching here, because the
 * plugin-runtime reads that follow ride the Convex query protocol and cannot be
 * authenticated by the service-token exchange. A threaded-but-unreachable knob
 * would only suggest otherwise.
 */
export async function readAuthorizedStdioLaunchSpec(args: {
  bearerToken: string;
  projectId: string;
  serverId: string;
  serverDisplayName?: string;
  accessScope?: "project_member" | "chat_v2";
  scenarioId?: string;
  accessVersion?: number;
}): Promise<PluginStdioLaunchSpec> {
  const result = await authorizeServerLocal(
    null,
    args.bearerToken,
    args.projectId,
    args.serverId
  );
  if (result.serverConfig.transportType !== "stdio") {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `Server "${
        args.serverDisplayName ?? args.serverId
      }" changed transport while the request was in flight. Retry the request.`,
      { serverId: args.serverId }
    );
  }
  const config = result.serverConfig;
  // Same redaction rule the local path applies: the authorize read returns
  // `hasEnv` with no values when the env is secret-backed, and the reveal is
  // what fills it in.
  const env =
    config.hasEnv === true && !hasNonEmptyStringRecord(config.env)
      ? (
          await fetchRuntimeServerSecrets({
            bearerToken: args.bearerToken,
            projectId: args.projectId,
            serverId: args.serverId,
            accessScope: args.accessScope,
            scenarioId: args.scenarioId,
            accessVersion: args.accessVersion,
          })
        ).env ??
        config.env ??
        {}
      : config.env ?? {};

  return {
    command: config.command,
    args: config.args ?? [],
    env,
    ...(config.cwd !== undefined ? { workingDirectory: config.cwd } : {}),
  };
}

/**
 * Resolve ONE stdio server to a connectable SDK config for a web-route
 * surface running as the LOCAL binary (`createAuthorizedManager`'s stdio
 * divert). The hosted authorize batch strips `command`/`args`/`env` by
 * contract, so this re-reads the full config through
 * `/web/authorize-batch-local` — with the same bearer, so authorization is
 * re-checked, not assumed — then applies runtime secrets, materializes
 * plugin bundles, and builds the stdio `MCPServerConfig` exactly as the
 * /api/mcp connect path would.
 *
 * Refuses an http row rather than silently building one: the caller routes
 * http servers through the hosted mint path (OAuth/XAA), so a transport
 * mismatch between the two authorize reads means the row changed
 * mid-request — connecting either way would race the edit.
 */
export async function resolveLocalStdioServerConfig(
  bearerToken: string,
  projectId: string,
  serverId: string,
  options?: {
    timeoutMs?: number;
    clientCapabilities?: Record<string, unknown>;
    serverDisplayName?: string;
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    firstPageOnly?: boolean;
    supportsMrtr?: boolean;
    suppressLegacyRequestCancellation?: boolean;
    suppressModernRequestCancellation?: boolean;
    xaaPolicy?: XaaEnterprisePolicy;
    /**
     * Secret-reveal scope + delegated identity, threaded from
     * `createAuthorizedManager`'s options and caller context so the local
     * reread and reveal follow the same trust model as the hosted batch —
     * a scenario-scoped or WorkOS-API-key caller must not get a lesser (or
     * failing) resolution just because the deployment is local.
     */
    accessScope?: "project_member" | "chat_v2";
    scenarioId?: string;
    accessVersion?: number;
    workosApiKeyActingAs?: WorkosApiKeyActingAs;
    /**
     * Receives the plugin bundle release closure when this server is a
     * plugin component. Ephemeral web-route managers MUST pass this and
     * release at teardown — the process-wide registry's replace-on-retain
     * semantics assume one long-lived manager per key.
     */
    onPluginLease?: (release: () => void) => void;
  }
): Promise<MCPServerConfig> {
  let result = await authorizeServerLocal(
    null,
    bearerToken,
    projectId,
    serverId,
    options?.workosApiKeyActingAs
  );
  if (result.serverConfig.transportType !== "stdio") {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `Server "${
        options?.serverDisplayName ?? serverId
      }" changed transport while the request was in flight. Retry the request.`,
      { serverId }
    );
  }
  result = await applyLocalRuntimeResolution(result, {
    bearerToken,
    projectId,
    serverId,
    // Web-route managers register servers under their serverId, so the
    // plugin bundle lease is keyed by it here (see managerKey docs).
    managerKey: serverId,
    serverDisplayName: options?.serverDisplayName,
    accessScope: options?.accessScope,
    scenarioId: options?.scenarioId,
    accessVersion: options?.accessVersion,
    workosApiKeyActingAs: options?.workosApiKeyActingAs,
    onPluginLease: options?.onPluginLease,
  });
  return toMCPServerConfig(result, {
    timeoutMs: options?.timeoutMs,
    clientCapabilities: options?.clientCapabilities,
    clientInfo: options?.clientInfo,
    supportedProtocolVersions: options?.supportedProtocolVersions,
    firstPageOnly: options?.firstPageOnly,
    supportsMrtr: options?.supportsMrtr,
    suppressLegacyRequestCancellation: options?.suppressLegacyRequestCancellation,
    suppressModernRequestCancellation: options?.suppressModernRequestCancellation,
    // Advertises the EMA extension host-wide on stdio too, matching the
    // /api/mcp path; stdio never gets OAuth/XAA hooks, so no
    // refreshContext / xaaUnauthorizedHandler here.
    xaaPolicy: options?.xaaPolicy,
  });
}

/**
 * Single-call convenience: authorize a serverId and return both the raw
 * response (for OAuth token plumbing) and a ready-to-pass MCPServerConfig.
 * Throws WebRouteError for unauthorized / not found / OAuth-required cases.
 */
export async function resolveLocalServerForConnect(
  c: Context,
  bearerToken: string,
  projectId: string,
  serverId: string,
  options?: {
    timeoutMs?: number;
    clientCapabilities?: Record<string, unknown>;
    serverDisplayName?: string;
    /**
     * Runtime defaults the inspector client computed via
     * `withProjectConnectionDefaults` and forwarded explicitly so the
     * resolver can reproduce the same MCPServerConfig the legacy
     * `{serverConfig}` body would have produced. Without this, project-level
     * header/timeout/capability defaults applied client-side are lost on the
     * resolver path.
     */
    defaults?: ConnectionDefaults;
  }
): Promise<{
  config: MCPServerConfig;
  authorizeResult: LocalAuthorizeBatchSuccess;
  /**
   * The resolved dispatch decision, surfaced so the connect executor can
   * scope its 401 handling: only a "discover" connect (non-XAA auto) tags a
   * live 401 as oauthRequired for client-side escalation.
   */
  effectiveAuth: EffectiveAuthMethod;
}> {
  let result = await authorizeServerLocal(c, bearerToken, projectId, serverId);

  // One resolver decides the flow for every dispatch below: canonical
  // authMethod wins ("auto" selects XAA when configured, "discover"
  // otherwise); legacy rows fall back to the boolean pair. The host's
  // enterprise policy (already validated at parseConnectionDefaults) forces
  // `auto` servers to XAA; stdio servers stay outside the policy — XAA is
  // HTTP-only, so an enterprise-managed host still runs its stdio servers
  // as today (the EMA capability is still advertised on them).
  const xaaPolicy = options?.defaults?.xaaPolicy;
  const effectiveAuth =
    result.serverConfig.transportType === "http"
      ? resolveEffectiveAuthMethod(result.serverConfig, xaaPolicy)
      : "none";

  // Enterprise policy, unconfigured `auto` server: fail first-class BEFORE
  // any mint/connect attempt — never silently downgrade to the discover
  // ladder (that would mask the exact misconfiguration an admin needs to
  // see). "Not configured" (no stored client registration at the resource
  // authorization server), deliberately NOT "not enrolled" — enrollment
  // verdicts belong to the future issuer-policy evaluator.
  if (
    result.serverConfig.transportType === "http" &&
    xaaPolicyRequiresConfiguration(result.serverConfig, xaaPolicy)
  ) {
    const displayName = options?.serverDisplayName ?? serverId;
    throw new WebRouteError(
      409,
      ErrorCode.XAA_CONNECTION_NOT_CONFIGURED,
      `Server "${displayName}" has no XAA client registration configured. This host requires enterprise-managed authorization — add the server's client registration in its auth settings, or set an explicit auth method to override the host policy.`,
      {
        serverId,
        serverName: options?.serverDisplayName ?? null,
        reason: "xaa_connection_not_configured",
      }
    );
  }
  const useOAuth = effectiveAuth === "oauth";
  // Track the access token we'll hand to `toMCPServerConfig`. Starts from
  // whatever `authorize-batch-local` returned, but for hosted-OAuth servers
  // we fall back to a server-side refresh — same `force-refresh` endpoint
  // the chat path's `onUnauthorized` hook uses — when the batch returned
  // empty. Without this, an expired access token aborts the reconnect with
  // a 401 *before* the SDK gets a chance to attach `onUnauthorized`, so
  // auto-connect and the manual reconnect toggle would stay disconnected
  // even though sending a chat message works (chat goes through the same
  // refresh helper for in-flight 401s).
  let resolvedOauthAccessToken: string | undefined =
    result.oauthAccessToken ?? undefined;
  if (useOAuth && !resolvedOauthAccessToken) {
    const displayName = options?.serverDisplayName ?? serverId;
    try {
      resolvedOauthAccessToken =
        await refreshHostedOAuthAccessTokenWithLocalFallback(
          bearerToken,
          projectId,
          serverId,
          { serverName: displayName }
        );
    } catch (error) {
      const refreshTokenInvalid =
        error instanceof WebRouteError &&
        Boolean(
          (error.details as { refreshTokenInvalid?: boolean } | undefined)
            ?.refreshTokenInvalid
        );
      if (!refreshTokenInvalid) {
        // Transient (rate limit, network, backend 5xx). Bubble up so the
        // UI / caller can retry rather than telling the user to reconnect.
        throw error;
      }
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        `Server "${displayName}" requires OAuth authentication. Please complete the OAuth flow first.`,
        {
          oauthRequired: true,
          refreshTokenInvalid: true,
          serverId,
          serverName: options?.serverDisplayName ?? null,
          serverUrl:
            result.serverConfig.transportType === "http"
              ? result.serverConfig.url
              : undefined,
        }
      );
    }
  }

  // Discover (non-XAA auto), stored-token rung: recover an expired hosted
  // token the same way the oauth branch does, but swallow EVERY refresh
  // failure and fall through to an unauthenticated attempt instead of
  // throwing pre-connect. A tokenless discover server has usually never
  // OAuth'd (refreshTokenInvalid), and in pure-local deployments the refresh
  // helper isn't even configured (CONVEX_HTTP_URL unset throws a 500) — in
  // both cases the right move is to just try the server bare; if it actually
  // needs auth, the connect 401s and the tagged error escalates client-side.
  if (effectiveAuth === "discover" && !resolvedOauthAccessToken) {
    try {
      resolvedOauthAccessToken =
        await refreshHostedOAuthAccessTokenWithLocalFallback(
          bearerToken,
          projectId,
          serverId,
          { serverName: options?.serverDisplayName ?? serverId }
        );
    } catch (error) {
      logger.debug(
        "[discover connect] silent token refresh unavailable; attempting unauthenticated connect",
        {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  // Cross-App Access: mint the resource access token server-side (MCPJam as the
  // test IdP), then hand it to `toMCPServerConfig` through the same
  // `oauthAccessToken` channel that injects the Bearer header. The effective
  // method is a hard selection (auto picked XAA because the server is
  // XAA-configured, or the row says xaa) — it can never collide with the
  // OAuth branch above.
  const useXaa = effectiveAuth === "xaa";
  let xaaUnauthorizedHandler:
    | (() => Promise<{ accessToken: string }>)
    | undefined;
  if (useXaa && result.serverConfig.transportType === "http") {
    const sc = result.serverConfig;
    const registrationMode = resolveXaaConnectRegistrationMode(
      sc.registrationMode
    );
    const xaaFailureTarget = {
      serverId,
      serverName: options?.serverDisplayName ?? serverId,
      ...(sc.url ? { serverUrl: sc.url } : {}),
    };
    // Backend-resolved identity failure (legacy partial per-server
    // override): a distinct configuration error, surfaced BEFORE any mint.
    // No silent fallback to the demo identity, no silent XAA→OAuth fallback.
    // Framed for this surface (the stored sentence is written for the server's
    // auth form and names neither the server nor where to fix it).
    if (sc.xaaIdentityError) {
      throw toXaaConnectFailure(
        new WebRouteError(400, ErrorCode.VALIDATION_ERROR, sc.xaaIdentityError),
        xaaFailureTarget
      );
    }
    const mintArgs = buildXaaMintArgs({
      issuer: resolveXaaConnectIssuer(c, {
        hostedMode: HOSTED_MODE,
        organizationId: result.organizationId,
      }),
      hostedMode: HOSTED_MODE,
      serverConfig: sc,
      serverId,
      projectId,
      bearerToken,
      resolveServerSecret: fetchServerClientSecret,
      organizationId: result.organizationId,
      isAnonymous: result.isAnonymous,
      confidentialCimdProvider:
        registrationMode === "cimd" && sc.xaaClientAuth === "private_key_jwt"
          ? getLocalConfidentialCimdProvider()
          : undefined,
    });
    // Always mint for XAA, overriding any access token the authorize batch
    // returned. A server converted from OAuth still has a stored OAuth token,
    // and reusing it here would inject the wrong credential — the XAA-protected
    // server rejects it. The XAA token must come from the mint, full stop.
    try {
      const minted = await mintXaaAccessToken(mintArgs);
      resolvedOauthAccessToken = minted.accessToken;
    } catch (error) {
      if (!isXaaMintErrorReported(error)) {
        logger.error("[XAA connect] mint failed", error, {
          serverId,
          serverName: options?.serverDisplayName ?? serverId,
          resource: sc.url,
        });
      }
      // Re-framed AFTER the log above: the debugger-worded original still
      // reaches Sentry/Axiom (as `cause`), the caller gets one sentence that
      // names this server and the action that fixes it.
      throw toXaaConnectFailure(error, xaaFailureTarget);
    }
    // Bounded re-mint: the SDK invokes this once on a 401 and retries; a second
    // 401 surfaces to the caller rather than looping mint→401→mint.
    let reMinted = false;
    xaaUnauthorizedHandler = async () => {
      if (reMinted) {
        throw new WebRouteError(
          401,
          ErrorCode.UNAUTHORIZED,
          `Server "${
            options?.serverDisplayName ?? serverId
          }" rejected the cross-app access token. Reconnect to retry.`
        );
      }
      reMinted = true;
      try {
        const minted = await mintXaaAccessToken(mintArgs);
        return { accessToken: minted.accessToken };
      } catch (error) {
        throw toXaaConnectFailure(error, xaaFailureTarget);
      }
    };
  }

  result = await applyLocalRuntimeResolution(result, {
    bearerToken,
    projectId,
    serverId,
    // /api/mcp managers register servers under their display name — the same
    // key `releasePluginLease` gets on the disconnect route and on connect
    // failure — so the lease binds to it here.
    managerKey: options?.serverDisplayName ?? serverId,
    serverDisplayName: options?.serverDisplayName,
  });

  const config = toMCPServerConfig(result, {
    timeoutMs: options?.timeoutMs ?? options?.defaults?.timeoutMs,
    clientCapabilities:
      options?.clientCapabilities ?? options?.defaults?.clientCapabilities,
    defaultHeaders: options?.defaults?.headers,
    // mcpProfile.initialize fields ride through ConnectionDefaults end-to-end:
    // client computes them from hostConfig.mcpProfile, wire-serializes onto
    // /api/mcp/connect, parseConnectionDefaults gates the shape, and they
    // land on the per-server SDK config here. Undefined preserves
    // historical wire behavior — no opt-in, no change.
    clientInfo: options?.defaults?.clientInfo,
    supportedProtocolVersions: options?.defaults?.supportedProtocolVersions,
    // Same opt-in path for the wire mode — `resolveEffectiveMcpProtocolVersion`
    // runs client-side, the literal is wire-serialized via
    // ConnectionDefaults, and lands on the SDK config here.
    mcpProtocolVersion: options?.defaults?.mcpProtocolVersion,
    // Same path again for the SEP-2243 mirroring knob.
    mirrorToolParamHeaders: options?.defaults?.mirrorToolParamHeaders,
    // Same path again for the sibling conformance knobs.
    firstPageOnly: options?.defaults?.firstPageOnly,
    supportsMrtr: options?.defaults?.supportsMrtr,
    suppressLegacyRequestCancellation:
      options?.defaults?.suppressLegacyRequestCancellation,
    suppressModernRequestCancellation:
      options?.defaults?.suppressModernRequestCancellation,
    oauthAccessToken: resolvedOauthAccessToken,
    refreshContext: {
      bearerToken,
      projectId,
      serverId,
      serverName: options?.serverDisplayName ?? serverId,
    },
    xaaUnauthorizedHandler,
    xaaPolicy,
  });
  return { config, authorizeResult: result, effectiveAuth };
}

// ---------------------------------------------------------------------------
// Connect-flow plumbing shared by /api/mcp/connect + /api/mcp/servers/reconnect
// ---------------------------------------------------------------------------
//
// The two local connect endpoints used to inline ~120 lines each of body
// parsing + WebRouteError translation + tolerant disconnect/connect, with
// drift accumulating between them (different success envelopes, neither
// returning `initInfo` — see the reconnect-warning false-positive bug).
// These helpers consolidate that flow and bring the success envelope shape
// in line with hosted `/api/web/servers/validate`.

/**
 * Parsed + validated body for the local connect/reconnect endpoints. Strict
 * about the resolver-path fields because both endpoints now require them
 * (the legacy `{serverConfig}` body was removed in the local-mode purge).
 */
export interface LocalConnectRequestParams {
  serverId: string;
  projectId: string;
  serverDisplayName: string;
  bearer: string;
  clientCapabilities?: Record<string, unknown>;
  defaults?: ConnectionDefaults;
}

/**
 * Validate a JSON body posted to the local connect/reconnect endpoints.
 * Returns parsed params on success, or a `WebRouteError` whose status the
 * caller passes straight to `c.json` — no other branching needed.
 *
 * Doesn't throw on validation issues so callers don't have to differentiate
 * between auth/format errors and config-resolve errors (which DO throw via
 * `resolveLocalServerForConnect`).
 */
export function parseLocalConnectRequestBody(
  c: Context,
  body: unknown
):
  | { ok: true; params: LocalConnectRequestParams }
  | { ok: false; error: WebRouteError } {
  const raw = (body ?? {}) as Record<string, unknown>;

  const serverId = typeof raw.serverId === "string" ? raw.serverId.trim() : "";
  if (!serverId) {
    return {
      ok: false,
      error: new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "serverId is required"
      ),
    };
  }

  const projectId =
    typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  if (!projectId) {
    return {
      ok: false,
      error: new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required"
      ),
    };
  }

  const serverDisplayName =
    typeof raw.serverName === "string" ? raw.serverName.trim() : "";
  if (!serverDisplayName) {
    return {
      ok: false,
      error: new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "serverName is required with projectId"
      ),
    };
  }

  const bearer = readLocalApiBearer(c);
  if (!bearer) {
    return {
      ok: false,
      error: new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Authorization bearer token is required"
      ),
    };
  }

  const clientCapabilities =
    typeof raw.clientCapabilities === "object" &&
    raw.clientCapabilities !== null
      ? (raw.clientCapabilities as Record<string, unknown>)
      : undefined;

  return {
    ok: true,
    params: {
      serverId,
      projectId,
      serverDisplayName,
      bearer,
      clientCapabilities,
      defaults: parseConnectionDefaults(raw.connectionDefaults),
    },
  };
}

/**
 * Translate a `WebRouteError` into the error envelope local-mode handlers
 * have always returned (`{success: false, error, ...details}`), and tag
 * OAuth-required 401s with the `X-MCP-Auth-Required` header so the client's
 * `authFetch` doesn't waste a guest-session refresh round-trip on a failure
 * the next attempt would inevitably repeat.
 *
 * Distinct from `webError` (used by the hosted routes): hosted returns a
 * `{code, message, details}` shape; local has historically used
 * `{success: false, error, ...details}` and clients depend on that.
 */
export function respondWithLocalRouteError(c: Context, error: WebRouteError) {
  // Both tags mean "the UPSTREAM MCP server demands auth" — refreshing the
  // inspector session or guest token can't change that outcome, so authFetch
  // must skip its 401-retry round-trips. Only `oauthRequired` additionally
  // drives client-side OAuth escalation.
  if (
    error.details?.oauthRequired === true ||
    error.details?.upstreamAuthRequired === true
  ) {
    c.header("X-MCP-Auth-Required", "oauth");
  }
  const normalized = error.normalized ?? describeError(error);
  // Skip-if-stamped by construction: most callers reach here holding a
  // `WebRouteError` that `mapRuntimeError` already ruled on, and the helper
  // short-circuits on the stamp. The call is still made so the local-mode
  // paths that build a `WebRouteError` by hand — never passing through the
  // mapper — are classified too.
  const { origin } = maybeCaptureOriginError(error, normalized, {
    source: "mcp.localRouteError",
    extra: { status: error.status, code: error.code },
  });
  c.set("webErrorMeta", {
    status: error.status,
    code: error.code,
    message: error.message,
    origin,
    slug: normalized.slug,
  });
  return c.json(
    {
      success: false,
      error: error.message,
      ...(error.details ?? {}),
      normalized,
      origin,
    },
    error.status as any
  );
}

/**
 * Standard success envelope for local connect/reconnect responses. Mirrors
 * the hosted `/api/web/servers/validate` shape so the inspector client's
 * `storeInitInfo(name, result.initInfo)` takes the synchronous-dispatch
 * path on both surfaces — no second `/api/mcp/servers/init-info` round-trip
 * for the warning indicator to race against.
 *
 * `initInfo` is `null` (not omitted) when the manager has no live state
 * yet, so the client can distinguish "server connected but init data not
 * available" from "field missing because old server forgot to include it."
 */
export function buildConnectSuccessEnvelope(
  manager: Pick<MCPClientManager, "getInitializationInfo">,
  managerKey: string
): { success: true; status: "connected"; initInfo: unknown } {
  return {
    success: true,
    status: "connected",
    initInfo: manager.getInitializationInfo(managerKey) ?? null,
  };
}

/**
 * Tolerant disconnect-then-connect plus init-info pickup, shared by both
 * local connect endpoints. `removeOnFailure` cleans up the manager entry
 * after a failed connect (used by /api/mcp/connect for first-time connects
 * so a doomed entry doesn't pollute subsequent listServers calls);
 * /reconnect leaves the entry around since the caller intends to retry.
 *
 * Throws via the supplied `c.json` machinery — callers `return` the result.
 * Tests assert a specific success envelope shape; if you change it here,
 * sync the inspector client's `storeInitInfo` callsites and the connect/
 * reconnect tests in `server/routes/mcp/__tests__`.
 */
export async function executeLocalServerConnect(
  c: Context,
  params: LocalConnectRequestParams,
  options: { removeOnFailure: boolean }
) {
  const { serverId, projectId, serverDisplayName, bearer } = params;
  const mcpClientManager = c.mcpClientManager;

  let resolved: Awaited<ReturnType<typeof resolveLocalServerForConnect>>;
  try {
    resolved = await resolveLocalServerForConnect(
      c,
      bearer,
      projectId,
      serverId,
      {
        serverDisplayName,
        clientCapabilities: params.clientCapabilities,
        defaults: params.defaults,
      }
    );
  } catch (error) {
    if (error instanceof WebRouteError) {
      return respondWithLocalRouteError(c, error);
    }
    logger.error("Error resolving server config", error, { serverId });
    return c.json(
      {
        success: false,
        error: "Failed to resolve server config",
        details: error instanceof Error ? error.message : "Unknown error",
        normalized: describeError(error),
      },
      500
    );
  }

  // Tolerate "nothing to disconnect" — first-time connects have nothing in
  // the manager yet, and stale-or-already-disconnected entries on reconnect
  // shouldn't fail the call. Same tolerance as the legacy DELETE handler.
  try {
    await mcpClientManager.disconnectServer(serverDisplayName);
  } catch (disconnectError) {
    logger.debug("Failed to disconnect MCP server before connect", {
      serverId: serverDisplayName,
      error:
        disconnectError instanceof Error
          ? disconnectError.message
          : String(disconnectError),
    });
  }

  // LOAD-BEARING: register the modern MRTR (`input_required`) input collector
  // BEFORE connecting. A 2026-07-28 server only embeds `elicitation/create` in
  // an `input_required` result when the client advertised `elicitation`, and
  // the SDK advertises it (in `buildCapabilities`) exactly when a collector is
  // registered at connect time — registering afterward does not re-advertise.
  registerLocalMrtrCollector(mcpClientManager, serverDisplayName);
  // The MRTR bridge completes url rounds as well as form rounds, so a
  // modern-only connection declares both. Gated on the accept-list because the
  // legacy inbound bridge is form-only — see the helper.
  const connectConfig = withLocalMrtrElicitationCapability(resolved.config);

  try {
    await mcpClientManager.connectToServer(serverDisplayName, connectConfig);
  } catch (error) {
    // Nothing is running from the materialized bundle, so its GC lease must go
    // with the failed entry — otherwise a plugin whose component never starts
    // would pin its cache entry until the inspector process exits.
    releasePluginLease(serverDisplayName);
    if (options.removeOnFailure) {
      try {
        await mcpClientManager.removeServer(serverDisplayName);
      } catch (cleanupError) {
        logger.debug("Failed to remove MCP server after connection failure", {
          serverId: serverDisplayName,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
      }
    }
    // A live 401 from a "discover" attempt (non-XAA auto, no stored token) is
    // the MCP spec's discovery signal, not a failure to bury in a generic
    // envelope: tag it oauthRequired so the client escalates into the
    // interactive OAuth flow. Explicit "none" servers get a hint instead —
    // the user chose unauthenticated, so nothing auto-escalates.
    if (isUnauthorized401(error)) {
      const serverUrl =
        resolved.config &&
        typeof (resolved.config as { url?: unknown }).url === "object"
          ? String((resolved.config as { url: URL }).url)
          : undefined;
      if (resolved.effectiveAuth === "discover") {
        return respondWithLocalRouteError(
          c,
          new WebRouteError(
            401,
            ErrorCode.UNAUTHORIZED,
            `Server "${serverDisplayName}" requires authorization.`,
            {
              oauthRequired: true,
              serverId,
              serverName: serverDisplayName,
              serverUrl,
            },
            describeError(error)
          )
        );
      }
      if (resolved.effectiveAuth === "none") {
        // Same honest 401 status as the hosted mapping — but tagged with
        // upstreamAuthRequired instead of oauthRequired: the user explicitly
        // chose No Authentication, so the client must not auto-escalate;
        // the tag only suppresses authFetch's session/guest-token retries
        // (which can't fix an upstream 401).
        return respondWithLocalRouteError(
          c,
          new WebRouteError(
            401,
            ErrorCode.UNAUTHORIZED,
            // Same reasoning as the envelope below: no "Connection failed for
            // server X:" preamble. `serverName` is already in the details bag
            // for anyone who needs to attribute it.
            `This server requires authorization (HTTP 401). Switch Authentication to Auto or OAuth to sign in.`,
            {
              upstreamAuthRequired: true,
              serverId,
              serverName: serverDisplayName,
              serverUrl,
            },
            describeError(error)
          )
        );
      }
    }
    const failureMessage =
      error instanceof Error ? error.message : "Unknown error";
    return c.json(
      {
        success: false,
        // No "Connection failed for server X:" preamble. It was added to say
        // WHICH server failed, but every surface that renders this already
        // knows: the toast fires from that server's own connect, and the error
        // sits on that server's card. What it actually did was push the
        // sentence that explains the failure to the second half of the line —
        // and against an error that names the server itself, repeat it
        // ("Connection failed for server champions: MCP server "champions"
        // doesn't support …").
        //
        // `serverName` rides in the response for any caller that does need to
        // attribute it without parsing prose.
        error: failureMessage,
        serverName: serverDisplayName,
        details: failureMessage,
        normalized: describeError(error),
      },
      500
    );
  }

  // Capture the inspection snapshot synchronously so a fast follow-up
  // disconnect/reconnect on the same server can't tear down the manager
  // mid-`listTools`. Only the Convex write is fire-and-forget — failures
  // there never affect the connect response (the connect succeeded
  // regardless). Port of PR #1731's `use-inspection-coordinator`; mirrors
  // the hosted `/web/servers/validate` path.
  const inspectionSnapshot = await exportSingleServerForInspection(
    mcpClientManager,
    serverDisplayName,
    serverId,
    { logPrefix: "connect-inspection" }
  );
  void persistConnectInspection({
    convexBearer: bearer,
    projectId,
    snapshot: inspectionSnapshot,
  }).catch((error) => {
    logger.debug("Failed to persist connect-time inspection", {
      serverId: serverDisplayName,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return c.json(
    buildConnectSuccessEnvelope(mcpClientManager, serverDisplayName)
  );
}

/**
 * Convex client for the plugin-runtime reads the materializer needs (origin
 * attribution). Same bearer the authorize call used — plugin reads are
 * project-scoped and re-authorized backend-side on every query.
 */
export function createPluginRuntimeConvexClient(
  bearerToken: string
): ConvexHttpClient {
  const { convexUrl } = getInspectorClientRuntimeConfig();
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing Convex configuration for plugin runtime resolution"
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(bearerToken);
  return client;
}

async function persistConnectInspection(args: {
  convexBearer: string | undefined;
  projectId: string;
  snapshot: Awaited<ReturnType<typeof exportSingleServerForInspection>>;
}): Promise<void> {
  // Only `CONVEX_HTTP_URL` is boot-enforced; the convex-client URL is
  // derived from it (suffix swap) by the runtime config helper so that
  // production env (which sets only CONVEX_HTTP_URL) works.
  const { convexUrl } = getInspectorClientRuntimeConfig();
  if (!convexUrl || !args.convexBearer) {
    return;
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(args.convexBearer);
  await client.mutation("serverInspections:recordFromConnect" as any, {
    projectId: args.projectId,
    snapshot: args.snapshot,
  });
}
