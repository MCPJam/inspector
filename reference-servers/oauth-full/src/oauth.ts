import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { CaptureSession } from "./capture.js";
import {
  CHALLENGE_SCOPES,
  PREREGISTERED_CLIENT_ID,
  PREREGISTERED_CLIENT_SECRET,
  SUPPORTED_SCOPES,
  type ReferenceServerConfig,
} from "./config.js";
import { OAuthStore, type RegisteredClient } from "./store.js";

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";

export interface OAuthContext {
  config: ReferenceServerConfig;
  store: OAuthStore;
  capture: () => CaptureSession;
}

export function createOAuthContext(config: ReferenceServerConfig, capture: () => CaptureSession): OAuthContext {
  const store = new OAuthStore();
  store.registerClient({
    clientId: PREREGISTERED_CLIENT_ID,
    clientSecret: PREREGISTERED_CLIENT_SECRET,
    redirectUris: [],
    tokenEndpointAuthMethod: "client_secret_post",
    source: "preregistered",
    clientName: "Preregistered reference client",
  });
  return { config, store, capture };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseFormOrJson(raw: string, contentType: string | undefined): Record<string, string> {
  if (!raw) return {};
  if (contentType?.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

const userAgentOf = (req: IncomingMessage): string | undefined => {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] : ua;
};

// ---------------------------------------------------------------------------
// Metadata (RFC 9728 + RFC 8414 / OIDC)
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(ctx: OAuthContext): Record<string, unknown> {
  return {
    resource: `${ctx.config.publicUrl}/mcp`,
    authorization_servers: [ctx.config.publicUrl],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "MCPJam OAuth reference MCP server",
  };
}

export function authorizationServerMetadata(ctx: OAuthContext): Record<string, unknown> {
  const origin = ctx.config.publicUrl;
  const grantTypes = ["authorization_code"];
  if (ctx.config.refreshTokens) grantTypes.push("refresh_token");
  if (ctx.config.xaaIssuer) grantTypes.push(JWT_BEARER_GRANT);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    ...(ctx.config.dcr ? { registration_endpoint: `${origin}/register` } : {}),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: grantTypes,
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...SUPPORTED_SCOPES],
    // CIMD (draft-ietf-oauth-client-id-metadata-document): URL client_ids accepted.
    client_id_metadata_document_supported: true,
    ...(ctx.config.xaaIssuer
      ? { identity_chaining_requested_token_types_supported: [ID_JAG_TOKEN_TYPE] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

export async function handleRegister(ctx: OAuthContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ctx.config.dcr) {
    ctx.capture().record({
      kind: "dcr_registration",
      method: "POST",
      path: "/register",
      status: 403,
      userAgent: userAgentOf(req),
      detail: { rejected: "dcr-disabled" },
    });
    sendJson(res, 403, { error: "access_denied", error_description: "DCR is disabled on this run (--no-dcr)" });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON" });
    return;
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0) {
    ctx.capture().record({
      kind: "dcr_registration",
      method: "POST",
      path: "/register",
      status: 400,
      userAgent: userAgentOf(req),
      detail: { rejected: "missing-redirect-uris" },
    });
    sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
    return;
  }

  const requestedAuthMethod =
    typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  const tokenEndpointAuthMethod =
    requestedAuthMethod === "client_secret_post" || requestedAuthMethod === "client_secret_basic"
      ? requestedAuthMethod
      : "none";

  const client = ctx.store.registerClient({
    redirectUris,
    tokenEndpointAuthMethod,
    clientSecret: tokenEndpointAuthMethod === "none" ? undefined : `secret_${crypto.randomUUID()}`,
    source: "dcr",
    clientName: typeof body.client_name === "string" ? body.client_name : undefined,
    clientUri: typeof body.client_uri === "string" ? body.client_uri : undefined,
    logoUri: typeof body.logo_uri === "string" ? body.logo_uri : undefined,
    grantTypes: Array.isArray(body.grant_types)
      ? body.grant_types.filter((g): g is string => typeof g === "string")
      : undefined,
  });

  ctx.capture().record({
    kind: "dcr_registration",
    method: "POST",
    path: "/register",
    status: 201,
    userAgent: userAgentOf(req),
    detail: {
      clientName: client.clientName,
      clientUri: client.clientUri,
      logoUri: client.logoUri,
      redirectUris,
      grantTypes: client.grantTypes,
      tokenEndpointAuthMethod,
      requestedScope: typeof body.scope === "string" ? body.scope : undefined,
    },
  });

  sendJson(
    res,
    201,
    {
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      grant_types: client.grantTypes ?? ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(client.clientName ? { client_name: client.clientName } : {}),
    },
    // RFC 7591: credential responses MUST NOT be cached.
    { "Cache-Control": "no-store" },
  );
}

// ---------------------------------------------------------------------------
// CIMD (client_id as HTTPS URL pointing at a metadata document)
// ---------------------------------------------------------------------------

/** SSRF guard for CIMD fetches: the AS fetches a caller-supplied URL by
 * design, so when this server is exposed publicly (tunnel), that fetch must
 * not be steerable at loopback/private/link-local targets (cloud metadata,
 * internal services). Loopback CIMD documents stay allowed while the server
 * itself runs on a loopback publicUrl — the local-dev testing path. */
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
    const [a, b] = octets;
    return (
      a === 0 || // unspecified
      a === 127 || // loopback
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) // link-local / cloud metadata
    );
  }
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // fe80::/10
  }
  if (lower.startsWith("::ffff:")) {
    return isPrivateAddress(lower.slice(7), 4); // IPv4-mapped
  }
  return false;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

async function assertCimdUrlAllowed(ctx: OAuthContext, url: URL): Promise<string | undefined> {
  const publicIsLocal = LOOPBACK_HOSTNAMES.has(new URL(ctx.config.publicUrl).hostname.toLowerCase());
  const targetIsLocal = LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());

  if (targetIsLocal) {
    return publicIsLocal
      ? undefined
      : "loopback CIMD URLs are not allowed while the server is published on a non-loopback --public-url";
  }
  if (url.protocol !== "https:") {
    return "CIMD client_id must be https (or http on localhost for local testing)";
  }
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.some((entry) => isPrivateAddress(entry.address, entry.family))) {
      return "CIMD host resolves to a private, loopback, or link-local address";
    }
  } catch {
    return "CIMD host did not resolve";
  }
  return undefined;
}

async function resolveCimdClient(ctx: OAuthContext, clientId: string): Promise<RegisteredClient | { error: string }> {
  const existing = ctx.store.clients.get(clientId);
  if (existing) return existing;

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { error: "client_id is neither registered nor a valid CIMD URL" };
  }
  const blocked = await assertCimdUrlAllowed(ctx, url);
  if (blocked) {
    ctx.capture().record({
      kind: "cimd_fetch",
      method: "GET",
      path: url.toString(),
      status: 403,
      detail: { clientId, rejected: blocked },
    });
    return { error: blocked };
  }

  let status = 0;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    status = response.status;
    if (!response.ok) {
      ctx.capture().record({
        kind: "cimd_fetch",
        method: "GET",
        path: url.toString(),
        status,
        detail: { clientId, rejected: "non-200" },
      });
      return { error: `CIMD document fetch returned ${status}` };
    }
    const doc = (await response.json()) as Record<string, unknown>;
    if (doc.client_id !== clientId) {
      ctx.capture().record({
        kind: "cimd_fetch",
        method: "GET",
        path: url.toString(),
        status,
        detail: { clientId, rejected: "client_id-mismatch" },
      });
      return { error: "CIMD document client_id does not match the requesting client_id" };
    }
    const redirectUris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    const client = ctx.store.registerClient({
      clientId,
      redirectUris,
      tokenEndpointAuthMethod: "none",
      source: "cimd",
      clientName: typeof doc.client_name === "string" ? doc.client_name : undefined,
      clientUri: typeof doc.client_uri === "string" ? doc.client_uri : undefined,
      logoUri: typeof doc.logo_uri === "string" ? doc.logo_uri : undefined,
    });
    ctx.capture().record({
      kind: "cimd_fetch",
      method: "GET",
      path: url.toString(),
      status,
      detail: { clientId, clientName: client.clientName, redirectUris },
    });
    return client;
  } catch (error) {
    ctx.capture().record({
      kind: "cimd_fetch",
      method: "GET",
      path: url.toString(),
      status: status || 599,
      detail: { clientId, rejected: error instanceof Error ? error.message : "fetch-failed" },
    });
    return { error: "CIMD document fetch failed" };
  }
}

// ---------------------------------------------------------------------------
// /authorize
// ---------------------------------------------------------------------------

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export async function handleAuthorize(ctx: OAuthContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state") ?? undefined;
  const codeChallenge = q.get("code_challenge") ?? undefined;
  const codeChallengeMethod = q.get("code_challenge_method") ?? undefined;
  const resource = q.get("resource") ?? undefined;
  const scopes = (q.get("scope") ?? "").split(/[\s+]+/).filter(Boolean);
  const responseType = q.get("response_type") ?? "";

  const detail = {
    clientId,
    redirectUri,
    state: Boolean(state),
    pkce: Boolean(codeChallenge),
    pkceMethod: codeChallengeMethod,
    resource,
    scopes,
    responseType,
  };

  const fail = (status: number, error: string, description: string) => {
    ctx.capture().record({
      kind: "authorize",
      method: "GET",
      path: "/authorize",
      status,
      userAgent: userAgentOf(req),
      detail: { ...detail, rejected: `${error}: ${description}` },
    });
    // Per RFC 6749: only redirect errors when redirect_uri is valid; here we
    // render them so the tester can read the reason in the client's browser.
    sendHtml(
      res,
      status,
      `<h1>Authorization error</h1><p><b>${escapeHtml(error)}</b>: ${escapeHtml(description)}</p>`,
    );
  };

  if (responseType !== "code") {
    fail(400, "unsupported_response_type", `response_type must be "code", got "${responseType}"`);
    return;
  }
  if (!redirectUri) {
    fail(400, "invalid_request", "redirect_uri is required");
    return;
  }

  const client = await resolveCimdClient(ctx, clientId);
  if ("error" in client) {
    fail(400, "invalid_client", client.error);
    return;
  }

  // Preregistered clients have no pinned redirect URIs (first use pins them);
  // DCR/CIMD clients must match their registered list exactly.
  if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) {
    fail(400, "invalid_request", `redirect_uri "${redirectUri}" is not registered for this client`);
    return;
  }
  if (client.source === "preregistered" && client.redirectUris.length === 0) {
    client.redirectUris = [redirectUri];
  }

  if (ctx.config.requirePkce && !codeChallenge) {
    fail(400, "invalid_request", "PKCE code_challenge is required (start with --allow-no-pkce to permit this client)");
    return;
  }
  if (codeChallenge && codeChallengeMethod !== "S256") {
    fail(400, "invalid_request", `code_challenge_method must be S256, got "${codeChallengeMethod ?? "none"}"`);
    return;
  }
  if (ctx.config.requireResource && !resource) {
    fail(400, "invalid_target", "resource parameter is required on this run (--require-resource)");
    return;
  }

  const grantedScopes = scopes.length
    ? scopes.filter((s) => (SUPPORTED_SCOPES as readonly string[]).includes(s))
    : [...SUPPORTED_SCOPES];

  const issue = () => {
    const code = ctx.store.issueCode({
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scopes: grantedScopes,
      resource,
      expiresAt: Date.now() + 5 * 60_000,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code.code);
    if (state) callback.searchParams.set("state", state);
    ctx.capture().record({
      kind: "authorize",
      method: "GET",
      path: "/authorize",
      status: 302,
      userAgent: userAgentOf(req),
      detail,
    });
    res.writeHead(302, { Location: callback.toString(), "Cache-Control": "no-store" });
    res.end();
  };

  if (!ctx.config.consentPage) {
    issue();
    return;
  }

  // Manual consent: stash the issue parameters behind a one-time id.
  const consentId = crypto.randomUUID();
  pendingConsents.set(consentId, issue);
  ctx.capture().record({
    kind: "authorize",
    method: "GET",
    path: "/authorize",
    status: 200,
    userAgent: userAgentOf(req),
    detail: { ...detail, consentShown: true },
  });
  sendHtml(
    res,
    200,
    `<!doctype html><html><body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
      <h1>MCPJam OAuth reference server</h1>
      <p><b>${escapeHtml(client.clientName ?? client.clientId)}</b> is requesting access with scopes:
      <code>${escapeHtml(grantedScopes.join(" ") || "(none)")}</code></p>
      <form method="post" action="/authorize/consent">
        <input type="hidden" name="consent_id" value="${consentId}" />
        <button type="submit" style="font-size:1.1rem;padding:.5rem 1.5rem">Approve</button>
      </form>
    </body></html>`,
  );
}

const pendingConsents = new Map<string, () => void>();

export async function handleConsent(ctx: OAuthContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseFormOrJson(await readBody(req), req.headers["content-type"]);
  const issue = pendingConsents.get(body.consent_id ?? "");
  if (!issue) {
    sendHtml(res, 400, "<h1>Unknown or expired consent</h1>");
    return;
  }
  pendingConsents.delete(body.consent_id);
  ctx.capture().record({ kind: "consent", method: "POST", path: "/authorize/consent", status: 302 });
  issue();
}

// ---------------------------------------------------------------------------
// /token
// ---------------------------------------------------------------------------

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ClientAuthResult {
  client?: RegisteredClient;
  method: "none" | "client_secret_post" | "client_secret_basic" | "other";
  error?: string;
}

function authenticateClient(ctx: OAuthContext, req: IncomingMessage, body: Record<string, string>): ClientAuthResult {
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    const client = ctx.store.clients.get(decodeURIComponent(id ?? ""));
    if (!client) return { method: "client_secret_basic", error: "unknown client_id" };
    if (client.clientSecret && client.clientSecret !== decodeURIComponent(secret ?? "")) {
      return { method: "client_secret_basic", error: "bad client_secret" };
    }
    return { client, method: "client_secret_basic" };
  }
  const clientId = body.client_id;
  if (!clientId) return { method: "other", error: "client_id missing" };
  const client = ctx.store.clients.get(clientId);
  if (!client) return { method: body.client_secret ? "client_secret_post" : "none", error: "unknown client_id" };
  if (body.client_secret) {
    if (client.clientSecret && client.clientSecret !== body.client_secret) {
      return { method: "client_secret_post", error: "bad client_secret" };
    }
    return { client, method: "client_secret_post" };
  }
  if (client.clientSecret && client.tokenEndpointAuthMethod !== "none") {
    return { client, method: "none", error: "client_secret required for this client" };
  }
  return { client, method: "none" };
}

export async function handleToken(ctx: OAuthContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseFormOrJson(await readBody(req), req.headers["content-type"]);
  const grantType = body.grant_type ?? "";
  const ua = userAgentOf(req);

  const tokenError = (status: number, error: string, description: string, kind: "token_authorization_code" | "token_refresh" | "token_jwt_bearer" | "token_error", detail: Record<string, unknown> = {}) => {
    ctx.capture().record({
      kind,
      method: "POST",
      path: "/token",
      status,
      userAgent: ua,
      detail: { ...detail, rejected: `${error}: ${description}` },
    });
    sendJson(res, status, { error, error_description: description });
  };

  if (grantType === "authorization_code") {
    const auth = authenticateClient(ctx, req, body);
    const detail: Record<string, unknown> = {
      authMethod: auth.method,
      resource: body.resource,
      redirectUri: body.redirect_uri,
      pkceVerifierPresent: Boolean(body.code_verifier),
    };
    if (auth.error || !auth.client) {
      tokenError(401, "invalid_client", auth.error ?? "client authentication failed", "token_authorization_code", detail);
      return;
    }
    const code = ctx.store.codes.get(body.code ?? "");
    if (!code || code.used || Date.now() > code.expiresAt) {
      tokenError(400, "invalid_grant", "authorization code is unknown, used, or expired", "token_authorization_code", detail);
      return;
    }
    if (code.clientId !== auth.client.clientId) {
      tokenError(400, "invalid_grant", "authorization code was issued to a different client", "token_authorization_code", detail);
      return;
    }
    if (body.redirect_uri && body.redirect_uri !== code.redirectUri) {
      tokenError(400, "invalid_grant", "redirect_uri does not match the authorization request", "token_authorization_code", detail);
      return;
    }
    if (code.codeChallenge) {
      if (!body.code_verifier || !verifyPkce(body.code_verifier, code.codeChallenge)) {
        tokenError(400, "invalid_grant", "PKCE code_verifier missing or does not match code_challenge", "token_authorization_code", detail);
        return;
      }
    }
    if (ctx.config.requireResource && !body.resource) {
      tokenError(400, "invalid_target", "resource parameter is required on this run (--require-resource)", "token_authorization_code", detail);
      return;
    }
    code.used = true;

    const access = ctx.store.issueAccessToken({
      clientId: auth.client.clientId,
      scopes: code.scopes,
      resource: body.resource ?? code.resource,
      expiresAt: Date.now() + ctx.config.accessTokenTtl * 1000,
      grant: "authorization_code",
    });
    const refresh = ctx.config.refreshTokens
      ? ctx.store.issueRefreshToken({
          clientId: auth.client.clientId,
          scopes: code.scopes,
          resource: body.resource ?? code.resource,
        })
      : undefined;

    ctx.capture().record({
      kind: "token_authorization_code",
      method: "POST",
      path: "/token",
      status: 200,
      userAgent: ua,
      detail,
    });
    sendJson(res, 200, {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: ctx.config.accessTokenTtl,
      scope: code.scopes.join(" "),
      ...(refresh ? { refresh_token: refresh.token } : {}),
    });
    return;
  }

  if (grantType === "refresh_token") {
    const auth = authenticateClient(ctx, req, body);
    const refresh = ctx.store.refreshTokens.get(body.refresh_token ?? "");
    const detail: Record<string, unknown> = {
      authMethod: auth.method,
      resource: body.resource,
      reusedRotatedToken: refresh?.rotated === true,
    };
    if (!refresh) {
      tokenError(400, "invalid_grant", "unknown refresh_token", "token_refresh", detail);
      return;
    }
    if (refresh.rotated) {
      tokenError(400, "invalid_grant", "refresh_token was rotated and is no longer valid", "token_refresh", detail);
      return;
    }
    if (auth.client && auth.client.clientId !== refresh.clientId) {
      tokenError(400, "invalid_grant", "refresh_token belongs to a different client", "token_refresh", detail);
      return;
    }
    refresh.rotated = true;
    const access = ctx.store.issueAccessToken({
      clientId: refresh.clientId,
      scopes: refresh.scopes,
      resource: body.resource ?? refresh.resource,
      expiresAt: Date.now() + ctx.config.accessTokenTtl * 1000,
      grant: "refresh_token",
    });
    const nextRefresh = ctx.store.issueRefreshToken({
      clientId: refresh.clientId,
      scopes: refresh.scopes,
      resource: refresh.resource,
    });
    ctx.capture().record({
      kind: "token_refresh",
      method: "POST",
      path: "/token",
      status: 200,
      userAgent: ua,
      detail,
    });
    sendJson(res, 200, {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: ctx.config.accessTokenTtl,
      scope: refresh.scopes.join(" "),
      refresh_token: nextRefresh.token,
    });
    return;
  }

  if (grantType === JWT_BEARER_GRANT) {
    if (!ctx.config.xaaIssuer) {
      tokenError(400, "unsupported_grant_type", "jwt-bearer (XAA/ID-JAG) is disabled; start with --xaa-issuer <url>", "token_jwt_bearer");
      return;
    }
    const assertion = body.assertion;
    if (!assertion) {
      tokenError(400, "invalid_request", "assertion is required", "token_jwt_bearer");
      return;
    }
    try {
      const jwks = createRemoteJWKSet(new URL(`${ctx.config.xaaIssuer}/.well-known/jwks.json`));
      const { payload } = await jwtVerify(assertion, jwks, { issuer: ctx.config.xaaIssuer });
      const access = ctx.store.issueAccessToken({
        clientId: typeof payload.client_id === "string" ? payload.client_id : "xaa-client",
        scopes: [...CHALLENGE_SCOPES],
        resource: typeof payload.resource === "string" ? payload.resource : undefined,
        expiresAt: Date.now() + ctx.config.accessTokenTtl * 1000,
        grant: "jwt-bearer",
      });
      ctx.capture().record({
        kind: "token_jwt_bearer",
        method: "POST",
        path: "/token",
        status: 200,
        userAgent: ua,
        detail: {
          issuer: payload.iss,
          audience: payload.aud,
          subject: typeof payload.sub === "string" ? payload.sub : undefined,
          resource: typeof payload.resource === "string" ? payload.resource : undefined,
        },
      });
      sendJson(res, 200, {
        access_token: access.token,
        token_type: "Bearer",
        expires_in: ctx.config.accessTokenTtl,
        scope: access.scopes.join(" "),
      });
    } catch (error) {
      tokenError(
        400,
        "invalid_grant",
        `ID-JAG verification failed: ${error instanceof Error ? error.message : "unknown"}`,
        "token_jwt_bearer",
      );
    }
    return;
  }

  tokenError(400, "unsupported_grant_type", `grant_type "${grantType}" is not supported`, "token_error", { grantType });
}
