// Cross-App Access (XAA) token-mint orchestration, extracted from the XAA
// router so BOTH the debugger's `/proxy/token` endpoint AND the connect-page
// server-side mint depend on one implementation. Keeping the jwt-bearer body
// assembly here (see `buildJwtBearerBody`) is what prevents the two surfaces
// from drifting on the wire.
import type { Context } from "hono";
import {
  buildJwtBearerBody,
  buildXaaJwtBearerRequest,
  buildJwtBearerRequest,
  DEFAULT_XAA_CLIENT_AUTH,
  getXAAIssuerUrl,
  issueIdJag,
  normalizeXaaClientAuth,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
  type ConfidentialCimdProvider,
  type RegistrationMode,
  type XaaClientAuthMethod,
  type XaaTokenEndpointAuthMethod,
} from "@mcpjam/sdk";
import {
  buildDiscoveryCandidates,
  buildResourceMetadataCandidates,
  evaluateDiscovery,
  extractAuthorizationServer,
} from "./xaa-discovery.js";
import { executeOAuthProxy, fetchOAuthMetadata } from "../utils/oauth-proxy.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import type { ServerClientSecretResult } from "../utils/server-secrets.js";
import { logger } from "../utils/logger.js";

const XAA_MINT_ERROR_REPORTED = Symbol("xaaMintErrorReported");

function markXaaMintErrorReported(
  routeError: WebRouteError,
  cause: unknown
): WebRouteError {
  routeError.cause = cause;
  Object.defineProperty(routeError, XAA_MINT_ERROR_REPORTED, { value: true });
  return routeError;
}

export function isXaaMintErrorReported(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    XAA_MINT_ERROR_REPORTED in error
  );
}

// Resolved authorization-server target for a server-target run. Every field is
// pinned server-side from the stored server config; nothing is taken from the
// request body.
export interface ResolvedServerTarget {
  tokenEndpoint: string;
  /**
   * The authorization server's canonical issuer. This — NOT the token endpoint
   * — is the ID-JAG `aud` claim the resource AS validates against, so the mint
   * must sign with it.
   */
  authzIssuer: string;
  /**
   * The protected resource (the stored server URL). Pinned server-side so the
   * mint always exchanges for the target's own resource — never a
   * caller-supplied one — when using the stored confidential client secret.
   */
  resource?: string;
  clientId?: string;
  clientSecret?: string;
  clientIdMetadataDocumentSupported: boolean;
}

type ResolveServerSecretFn = (args: {
  serverId: string;
  projectId: string;
  bearerToken: string;
  clientIp?: string | null;
}) => Promise<ServerClientSecretResult>;

// RFC 9728: ask the resource (the MCP server URL) which authorization server
// protects it, by reading authorization_servers[0] from its protected-resource
// metadata. The resource URL is NOT itself an AS issuer, so this is the only
// spec-defined way to learn the issuer when one isn't configured. Returns
// undefined (rather than throwing) when no PRM/issuer is found, so the caller
// can fall back to probing the resource URL directly.
async function discoverIssuerFromResourceMetadata(
  resource: string,
  httpsOnly: boolean
): Promise<string | undefined> {
  let candidates: string[];
  try {
    candidates = buildResourceMetadataCandidates(resource);
  } catch {
    return undefined;
  }

  for (const candidate of candidates) {
    const result = await fetchOAuthMetadata(candidate, httpsOnly);
    if ("metadata" in result) {
      const issuer = extractAuthorizationServer(result.metadata);
      if (issuer) {
        return issuer;
      }
    }
  }

  return undefined;
}

// Discover the token endpoint for a server target, reusing the same well-known
// sweep as /discover-as. The issuer is resolved server-side (the client never
// supplies it), in priority order:
//   1. the stored xaaAuthzIssuer, if configured;
//   2. otherwise the authorization server named in the resource's RFC 9728
//      protected-resource metadata;
//   3. otherwise the resource URL itself (legacy behavior — covers servers that
//      self-host RFC 8414 metadata at the resource origin and serve no PRM).
// Same scheme + host + port. Used to bind a path-scoped AS's token endpoint
// to its issuer origin before the confidential secret is posted. Unparseable
// input fails closed (not same origin).
function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export async function discoverServerTargetTokenEndpoint(
  args: {
    resource?: string;
    explicitIssuer?: string;
    /**
     * Per-server opt-in: accept an advertised issuer that is a same-origin
     * path-prefix ancestor of the requested URL (multi-tenant AS deployments
     * with path-scoped issuers, e.g. /resources/res_x). Off = strict RFC 8414 match.
     */
    allowPathScopedIssuer?: boolean;
  },
  httpsOnly: boolean
): Promise<{
  issuer: string;
  tokenEndpoint: string;
  clientIdMetadataDocumentSupported: boolean;
}> {
  let issuer = args.explicitIssuer;
  if (!issuer && args.resource) {
    issuer = await discoverIssuerFromResourceMetadata(args.resource, httpsOnly);
  }
  // Legacy fallback: treat the resource URL as the issuer when neither a stored
  // issuer nor a PRM-advertised one is available.
  issuer = issuer || args.resource;

  if (!issuer) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "The server has no URL or issuer to discover an authorization server from"
    );
  }

  let candidates: string[];
  try {
    candidates = buildDiscoveryCandidates(issuer);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "The server's authorization issuer is not a valid URL"
    );
  }

  for (const candidate of candidates) {
    const result = await fetchOAuthMetadata(candidate, httpsOnly);
    if ("metadata" in result) {
      const verdict = evaluateDiscovery(result.metadata, {
        requestedIssuer: issuer,
        metadataUrl: candidate,
      });
      // Fail closed on an issuer mismatch: the metadata's advertised issuer
      // differs from the one we asked for, so its token endpoint can't be
      // trusted with the stored confidential client secret. This deliberate
      // abort must NOT wear a 502/504 — CDN edges (Cloudflare in hosted)
      // replace origin 502/504 bodies with their own branded error page, which
      // would hide this message from the user entirely.
      // A same-origin path-prefix "mismatch" is the multi-tenant AS shape
      // (issuer at the origin root, endpoints scoped under a path). Only the
      // per-server opt-in accepts it.
      const originPrefixOptIn =
        args.allowPathScopedIssuer === true &&
        verdict.issuerMismatch?.originPrefix === true;
      // Even under the opt-in, the token endpoint must stay on the advertised
      // issuer's own origin. Otherwise a same-origin tenant's metadata (the
      // exact scenario this feature relaxes trust for) could advertise the
      // origin-root issuer to pass the prefix check yet point token_endpoint
      // at an arbitrary public host, redirecting the confidential client
      // secret off-origin. Bind it explicitly; the strict path never reaches
      // this branch.
      const tokenEndpointEscapesOrigin =
        originPrefixOptIn &&
        verdict.tokenEndpoint != null &&
        !isSameOrigin(verdict.tokenEndpoint, verdict.issuerMismatch!.advertised);
      const acceptedPathScoped = originPrefixOptIn && !tokenEndpointEscapesOrigin;
      if (verdict.issuerMismatch && !acceptedPathScoped) {
        const { requested, advertised, schemeOnly, originPrefix } =
          verdict.issuerMismatch;
        const hint = tokenEndpointEscapesOrigin
          ? `The path-scoped authorization server's token endpoint ("${verdict.tokenEndpoint}") is on a different origin than its issuer ("${advertised}"); refusing to send the client secret off-origin.`
          : schemeOnly
            ? "Only the scheme differs — the authorization server is likely behind a TLS-terminating proxy but advertises an http:// issuer."
            : originPrefix
              ? "The advertised issuer is the same-origin root of the requested URL — a multi-tenant, path-scoped authorization server. Enable \"Path-scoped authorization server\" in the server's XAA settings to allow this."
              : "Set the server's Authorization Server issuer to the advertised value (or fix the server URL).";
        throw new WebRouteError(
          409,
          ErrorCode.VALIDATION_ERROR,
          `Authorization server issuer mismatch: the stored config expects "${requested}" but the server's metadata advertises "${advertised}". ${hint}`,
          {
            requestedIssuer: requested,
            advertisedIssuer: advertised,
            schemeOnly,
            originPrefix,
            ...(tokenEndpointEscapesOrigin
              ? { tokenEndpointOffOrigin: true }
              : {}),
          }
        );
      }
      // The AS explicitly declares it doesn't support the jwt-bearer grant —
      // skip its token endpoint and try the next candidate. (Missing
      // grant_types is "warn", not "fail", so imperfect metadata isn't skipped.)
      if (verdict.jwtBearerSupport === "fail") {
        continue;
      }
      if (verdict.tokenEndpoint) {
        // Prefer the AS's self-declared canonical issuer from metadata; fall
        // back to the requested issuer. This becomes the ID-JAG `aud`.
        return {
          issuer: verdict.issuer ?? issuer,
          tokenEndpoint: verdict.tokenEndpoint,
          clientIdMetadataDocumentSupported:
            verdict.clientIdMetadataDocumentSupported,
        };
      }
    }
  }

  throw new WebRouteError(
    404,
    ErrorCode.NOT_FOUND,
    "Couldn't discover an authorization server. Set the issuer in Configure Server to Test."
  );
}

async function resolveAuthorizedServerTarget(args: {
  resource?: string;
  explicitIssuer?: string;
  allowPathScopedIssuer?: boolean;
  httpsOnly: boolean;
}): Promise<ResolvedServerTarget> {
  if (!args.explicitIssuer && !args.resource) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "The server has no URL or issuer to discover an authorization server from"
    );
  }

  const discovered = await discoverServerTargetTokenEndpoint(
    {
      resource: args.resource,
      explicitIssuer: args.explicitIssuer,
      allowPathScopedIssuer: args.allowPathScopedIssuer,
    },
    args.httpsOnly
  );

  return {
    tokenEndpoint: discovered.tokenEndpoint,
    authzIssuer: discovered.issuer,
    resource: args.resource,
    clientIdMetadataDocumentSupported:
      discovered.clientIdMetadataDocumentSupported,
  };
}

// Resolve a server target's secret AND token endpoint entirely server-side.
// The browser sends only serverId + projectId; the stored config dictates the
// secret, client id, and the endpoint the secret may be posted to — so a
// caller can never redirect the confidential secret elsewhere.
export async function resolveServerTarget(deps: {
  resolveServerSecret?: ResolveServerSecretFn;
  httpsOnly: boolean;
  serverId: string;
  projectId?: string;
  bearerToken: string;
  clientIp?: string | null;
}): Promise<ResolvedServerTarget> {
  if (!deps.resolveServerSecret) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Server-target runs are not available on this instance"
    );
  }
  if (!deps.projectId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "projectId is required for server-target runs"
    );
  }

  const resolved = await deps.resolveServerSecret({
    serverId: deps.serverId,
    projectId: deps.projectId,
    bearerToken: deps.bearerToken,
    clientIp: deps.clientIp,
  });

  const target = await resolveAuthorizedServerTarget({
    resource: resolved.serverUrl ?? undefined,
    explicitIssuer: resolved.xaaAuthzIssuer ?? undefined,
    allowPathScopedIssuer: resolved.xaaAllowPathScopedIssuer === true,
    httpsOnly: deps.httpsOnly,
  });

  return {
    ...target,
    clientId: resolved.clientId ?? undefined,
    clientSecret: resolved.clientSecret ?? undefined,
  };
}

// `buildJwtBearerBody`, `buildJwtBearerRequest`, and `XaaTokenEndpointAuthMethod`
// (the single-source jwt-bearer request body + method-aware client-auth request)
// now live in @mcpjam/sdk and are re-exported here so existing importers keep
// their path. This is the ONE implementation shared by the debugger's
// `/proxy/token` endpoint, the connect-page server-side mint, and the CLI.
export { buildJwtBearerBody, buildJwtBearerRequest };
export type { XaaTokenEndpointAuthMethod };

// Derive the MCPJam test-IdP issuer from the inbound request. Shared by the XAA
// router endpoints and the connect-page mint so the signed ID-JAG `iss` matches
// the published JWKS regardless of which surface mints it.
export function getIssuerForRequest(
  c: Context,
  issuerBasePath: string,
  trustForwardedHeaders: boolean
): string {
  const parsed = new URL(c.req.url);

  if (trustForwardedHeaders) {
    // Only the scheme is reconstructed from a forwarded header: the edge
    // terminates TLS so c.req.url is http:// internally. The host already
    // comes from the validated Host header in c.req.url, so we do NOT trust
    // X-Forwarded-Host — honoring it would let a client inject an arbitrary
    // issuer/jwks_uri (and a forged `iss` on the signed ID-JAG). Restrict to
    // a known scheme so a forwarded value can't switch to another protocol.
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    if (proto === "https" || proto === "http") {
      parsed.protocol = proto;
    }
  }

  return getXAAIssuerUrl(`${parsed.origin}${issuerBasePath}`);
}

/** Minimal stored-server shape needed to assemble XAA mint args. */
export interface XaaMintServerConfig {
  url?: string;
  oauthScopes?: string[];
  xaaAuthzIssuer?: string;
  xaaAllowPathScopedIssuer?: boolean;
  xaaSubject?: string;
  xaaEmail?: string;
  registrationMode?: RegistrationMode;
  xaaClientAuth?: XaaClientAuthMethod;
}

export function resolveXaaConnectRegistrationMode(
  mode: RegistrationMode | undefined
): "preregistered" | "cimd" | "dcr" {
  return mode === "cimd" || mode === "dcr" ? mode : "preregistered";
}

export function scopeXaaIssuerForAuthorizedProject(args: {
  issuer: string;
  organizationId?: string | null;
  isAnonymous?: boolean;
}): string {
  if (!args.organizationId) return args.issuer;
  const parsedIssuer = new URL(args.issuer);
  if (!parsedIssuer.pathname.endsWith("/api/web/xaa")) return args.issuer;
  const segment = args.isAnonymous ? "g" : "o";
  return `${args.issuer.replace(/\/+$/, "")}/${segment}/${encodeURIComponent(
    args.organizationId
  )}`;
}

/**
 * Resolve the MCPJam test-IdP issuer for an XAA mint. In hosted mode only the
 * `/api/web/xaa` router is mounted (`/api/mcp/*` returns 410), and the TLS-
 * terminating edge means `c.req.url` is `http://` internally — so we trust
 * `x-forwarded-proto` to keep the `https://` scheme. Off-hosted, the
 * `/api/mcp/xaa` router is live and the request scheme is already correct.
 */
export function resolveXaaIssuer(c: Context, hostedMode: boolean): string {
  return getIssuerForRequest(
    c,
    hostedMode ? "/api/web" : "/api/mcp",
    hostedMode,
  );
}

/**
 * Resolve the issuer surface used by Connect before the authorized project is
 * scoped below. A local Inspector still uses the membership-gated `/api/web`
 * issuer when Convex authorization returned an organization; `/api/mcp`
 * remains the unscoped fallback for a genuinely local project. This choice is
 * independent from `hostedMode`, which continues to control outbound HTTPS
 * enforcement. Forwarded-scheme handling follows the selected issuer surface
 * so the minted `iss` matches that surface's discovery document.
 */
export function resolveXaaConnectIssuer(
  c: Context,
  args: { hostedMode: boolean; organizationId?: string | null }
): string {
  const usesScopedWebIssuer = Boolean(args.organizationId);
  const usesWebIssuer = args.hostedMode || usesScopedWebIssuer;
  return getIssuerForRequest(
    c,
    usesWebIssuer ? "/api/web" : "/api/mcp",
    usesWebIssuer,
  );
}

/**
 * Assemble the full `mintXaaAccessToken` args from a stored server config so
 * every connect surface (local resolver + hosted authorize) shares one identical
 * shape and can't drift on the wire.
 */
export function buildXaaMintArgs(args: {
  issuer: string;
  hostedMode: boolean;
  serverConfig: XaaMintServerConfig;
  serverId: string;
  projectId: string;
  bearerToken: string;
  resolveServerSecret?: ResolveServerSecretFn;
  organizationId?: string | null;
  isAnonymous?: boolean;
  confidentialCimdProvider?: ConfidentialCimdProvider;
}): Parameters<typeof mintXaaAccessToken>[0] {
  const sc = args.serverConfig;
  return {
    resolveServerSecret: args.resolveServerSecret,
    // Hosted targets are always remote HTTPS; off-hosted allows localhost http.
    httpsOnly: args.hostedMode,
    issuer: scopeXaaIssuerForAuthorizedProject({
      issuer: args.issuer,
      organizationId: args.organizationId,
      isAnonymous: args.isAnonymous,
    }),
    serverId: args.serverId,
    projectId: args.projectId,
    bearerToken: args.bearerToken,
    resource: sc.url,
    explicitIssuer: sc.xaaAuthzIssuer,
    allowPathScopedIssuer: sc.xaaAllowPathScopedIssuer,
    registrationMode: sc.registrationMode,
    xaaClientAuth: sc.xaaClientAuth,
    confidentialCimdProvider: args.confidentialCimdProvider,
    scope: sc.oauthScopes?.join(" ") || undefined,
    // Mock-login identity: stored override if set, else the XAA IdP mock-login
    // defaults.
    subject: sc.xaaSubject || "user-12345",
    email: sc.xaaEmail || "demo.user@example.com",
  };
}

// Full server-side XAA mint for the connect path: resolve the target's
// confidential credentials + token endpoint, sign an ID-JAG asserting the
// supplied (already-authenticated) identity, then exchange it for a resource
// access token via the jwt-bearer grant. With MCPJam as the IdP we mint the
// ID-JAG directly rather than first issuing a mock ID token — the resource AS
// only ever sees the jwt-bearer request, which stays identical to the debugger.
export async function mintXaaAccessToken(args: {
  resolveServerSecret?: ResolveServerSecretFn;
  httpsOnly: boolean;
  issuer: string;
  serverId: string;
  projectId: string;
  bearerToken: string;
  /** The protected resource (the MCP server URL). */
  resource?: string;
  explicitIssuer?: string;
  allowPathScopedIssuer?: boolean;
  registrationMode?: RegistrationMode;
  xaaClientAuth?: XaaClientAuthMethod;
  confidentialCimdProvider?: ConfidentialCimdProvider;
  scope?: string;
  /** Mock-login subject — already resolved (override or signed-in user). */
  subject: string;
  email?: string;
}): Promise<{ accessToken: string; tokenEndpoint: string }> {
  const registrationMode = resolveXaaConnectRegistrationMode(
    args.registrationMode
  );
  if (registrationMode === "dcr") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "XAA DCR is not supported in Connect yet. Choose pre-registered credentials or CIMD."
    );
  }

  let target: ResolvedServerTarget;
  let clientId: string;
  let clientSecret: string | undefined;
  let tokenEndpointAuthMethod: XaaTokenEndpointAuthMethod;
  let confidentialCimdProvider: ConfidentialCimdProvider | undefined;

  if (registrationMode === "cimd") {
    target = await resolveAuthorizedServerTarget({
      resource: args.resource,
      explicitIssuer: args.explicitIssuer,
      allowPathScopedIssuer: args.allowPathScopedIssuer,
      httpsOnly: args.httpsOnly,
    });
    if (!target.clientIdMetadataDocumentSupported) {
      throw new WebRouteError(
        409,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "The authorization server does not advertise client_id_metadata_document_supported: true. Choose pre-registered credentials or update the authorization server."
      );
    }

    const clientAuth =
      normalizeXaaClientAuth(args.xaaClientAuth) ?? DEFAULT_XAA_CLIENT_AUTH;
    if (clientAuth === "private_key_jwt") {
      if (!args.confidentialCimdProvider) {
        throw new WebRouteError(
          409,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "Confidential CIMD is not available for this connection. Choose Public client authentication or contact your administrator."
        );
      }
      confidentialCimdProvider = args.confidentialCimdProvider;
      try {
        clientId = confidentialCimdProvider.getClientIdMetadataUrl();
      } catch (error) {
        logger.error(
          "[XAA connect] confidential CIMD client identity resolution failed",
          error,
          {
            serverId: args.serverId,
            projectId: args.projectId,
            resource: args.resource,
            tokenEndpoint: target.tokenEndpoint,
            authorizationServer: target.authzIssuer,
          }
        );
        const routeError = new WebRouteError(
          500,
          ErrorCode.INTERNAL_ERROR,
          "Could not prepare the confidential CIMD client identity"
        );
        throw markXaaMintErrorReported(routeError, error);
      }
      tokenEndpointAuthMethod = "private_key_jwt";
    } else {
      clientId = XAA_DEBUG_CLIENT_ID_METADATA_URL;
      tokenEndpointAuthMethod = "none";
    }
  } else {
    target = await resolveServerTarget({
      resolveServerSecret: args.resolveServerSecret,
      httpsOnly: args.httpsOnly,
      serverId: args.serverId,
      projectId: args.projectId,
      bearerToken: args.bearerToken,
    });
    if (!target.clientId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Client ID is required for pre-registered XAA Connect"
      );
    }
    clientId = target.clientId;
    clientSecret = target.clientSecret;
    tokenEndpointAuthMethod = clientSecret ? "client_secret_post" : "none";
  }

  // Pin the grant resource to the resolved server target (its stored URL), so
  // the stored confidential secret is only ever exchanged for the target's own
  // resource. `args.resource` is only a fallback when the target has no URL.
  const tokenResource = target.resource ?? args.resource ?? "";

  const idJag = issueIdJag({
    issuer: args.issuer,
    subject: args.subject,
    email: args.email,
    // The ID-JAG `aud` is the resource authorization server's issuer (what it
    // validates against), NOT its token endpoint.
    audience: target.authzIssuer,
    resource: tokenResource,
    clientId,
    scope: args.scope,
  });

  let tokenRequest: ReturnType<typeof buildXaaJwtBearerRequest>;
  try {
    tokenRequest = buildXaaJwtBearerRequest(
      {
        tokenEndpoint: target.tokenEndpoint,
        assertion: idJag.token,
        clientId,
        clientSecret,
        scope: args.scope,
        resource: tokenResource || undefined,
        tokenEndpointAuthMethod,
      },
      confidentialCimdProvider
    );
  } catch (error) {
    if (registrationMode === "cimd") {
      logger.error(
        "[XAA connect] confidential CIMD assertion signing failed",
        error,
        {
          serverId: args.serverId,
          projectId: args.projectId,
          resource: tokenResource,
          tokenEndpoint: target.tokenEndpoint,
          authorizationServer: target.authzIssuer,
          clientId,
        }
      );
      const routeError = new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Could not sign the confidential CIMD token request"
      );
      throw markXaaMintErrorReported(routeError, error);
    }
    throw error;
  }

  const proxyResult = await executeOAuthProxy({
    url: target.tokenEndpoint,
    method: "POST",
    body: tokenRequest.body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...tokenRequest.headers,
    },
    httpsOnly: args.httpsOnly,
  });

  const body =
    proxyResult.body && typeof proxyResult.body === "object"
      ? (proxyResult.body as Record<string, unknown>)
      : null;

  if (proxyResult.status < 200 || proxyResult.status >= 300) {
    // Surface the authorization server's actual rejection (RFC 6749 error /
    // error_description, or a raw string body) so the failure is debuggable
    // instead of a generic "rejected".
    const oauthError =
      body && typeof body.error === "string" ? body.error : undefined;
    const oauthDesc =
      body && typeof body.error_description === "string"
        ? body.error_description
        : undefined;
    const rawDetail =
      !oauthError && typeof proxyResult.body === "string"
        ? proxyResult.body.slice(0, 400)
        : undefined;
    const detail =
      [oauthError, oauthDesc].filter(Boolean).join(": ") || rawDetail;
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `XAA token exchange (jwt-bearer grant) was rejected by the authorization server at ${target.tokenEndpoint} (HTTP ${proxyResult.status})${
        detail ? ` — ${detail}` : ""
      }`,
      { status: proxyResult.status, body: proxyResult.body }
    );
  }

  const accessToken =
    body && typeof body.access_token === "string"
      ? body.access_token
      : undefined;
  if (!accessToken) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `The authorization server at ${target.tokenEndpoint} accepted the grant (HTTP ${proxyResult.status}) but returned no access_token.`
    );
  }

  return { accessToken, tokenEndpoint: target.tokenEndpoint };
}
