// Cross-App Access (XAA) token-mint orchestration, extracted from the XAA
// router so BOTH the debugger's `/proxy/token` endpoint AND the connect-page
// server-side mint depend on one implementation. Keeping the jwt-bearer body
// assembly here (see `buildJwtBearerBody`) is what prevents the two surfaces
// from drifting on the wire.
import type { Context } from "hono";
import { issueIdJag } from "./xaa-idjag-signer.js";
import { getXAAIssuerUrl } from "./xaa-idp-keypair.js";
import {
  buildDiscoveryCandidates,
  buildResourceMetadataCandidates,
  evaluateDiscovery,
  extractAuthorizationServer,
} from "./xaa-discovery.js";
import { executeOAuthProxy, fetchOAuthMetadata } from "../utils/oauth-proxy.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import type { ServerClientSecretResult } from "../utils/server-secrets.js";

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
  clientId?: string;
  clientSecret?: string;
}

type ResolveServerSecretFn = (args: {
  serverId: string;
  projectId: string;
  bearerToken: string;
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
export async function discoverServerTargetTokenEndpoint(
  args: {
    resource?: string;
    explicitIssuer?: string;
  },
  httpsOnly: boolean
): Promise<{ issuer: string; tokenEndpoint: string }> {
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
      if (verdict.tokenEndpoint) {
        // Prefer the AS's self-declared canonical issuer from metadata; fall
        // back to the requested issuer. This becomes the ID-JAG `aud`.
        return {
          issuer: verdict.issuer ?? issuer,
          tokenEndpoint: verdict.tokenEndpoint,
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
  });

  if (!resolved.xaaAuthzIssuer && !resolved.serverUrl) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "The server has no URL or issuer to discover an authorization server from"
    );
  }

  const discovered = await discoverServerTargetTokenEndpoint(
    {
      resource: resolved.serverUrl ?? undefined,
      explicitIssuer: resolved.xaaAuthzIssuer ?? undefined,
    },
    deps.httpsOnly
  );

  return {
    tokenEndpoint: discovered.tokenEndpoint,
    authzIssuer: discovered.issuer,
    clientId: resolved.clientId ?? undefined,
    clientSecret: resolved.clientSecret ?? undefined,
  };
}

// The jwt-bearer (RFC 7523) token-request body posted to the resource
// authorization server. SINGLE SOURCE OF TRUTH — both `/proxy/token` (debugger)
// and `mintXaaAccessToken` (connect) build their request body here so the two
// surfaces stay byte-identical on the wire.
export function buildJwtBearerBody(args: {
  assertion: string;
  clientId?: string | null;
  clientSecret?: string | null;
  scope?: string | null;
  resource?: string | null;
}): Record<string, string> {
  return {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: args.assertion,
    ...(args.clientId ? { client_id: args.clientId } : {}),
    ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
    ...(args.scope ? { scope: args.scope } : {}),
    ...(args.resource ? { resource: args.resource } : {}),
  };
}

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
  scope?: string;
  /** Mock-login subject — already resolved (override or signed-in user). */
  subject: string;
  email?: string;
}): Promise<{ accessToken: string; tokenEndpoint: string }> {
  const target = await resolveServerTarget({
    resolveServerSecret: args.resolveServerSecret,
    httpsOnly: args.httpsOnly,
    serverId: args.serverId,
    projectId: args.projectId,
    bearerToken: args.bearerToken,
  });

  const idJag = issueIdJag({
    issuer: args.issuer,
    subject: args.subject,
    email: args.email,
    // The ID-JAG `aud` is the resource authorization server's issuer (what it
    // validates against), NOT its token endpoint.
    audience: target.authzIssuer,
    resource: args.resource ?? "",
    clientId: target.clientId ?? "",
    scope: args.scope,
  });

  const proxyResult = await executeOAuthProxy({
    url: target.tokenEndpoint,
    method: "POST",
    body: buildJwtBearerBody({
      assertion: idJag.token,
      clientId: target.clientId,
      clientSecret: target.clientSecret,
      scope: args.scope,
      resource: args.resource,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
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
