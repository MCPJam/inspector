// Headless Cross-App Access (ID-JAG) flow driver. Mirrors the inspector's XAA
// debugger, minus the UI: it self-issues an ID-JAG with the in-process mint,
// then redeems it at the target authorization server (RFC 7523 jwt-bearer) and
// calls the MCP server with the resulting access token — reporting whatever
// happens at each step.
//
// Reachability note: the ID-JAG's `iss`/JWKS is served by THIS host, so a cloud
// authorization server can only validate it when the issuer origin is reachable
// (an enterprise/self-hosted AS on the network, or a tunnelled origin). Against
// an unreachable issuer, redemption fails at the AS — which is itself the
// finding this tool reports.
import {
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
} from "../oauth-proxy.js";
import { initXAAIdpKeyPair, getXAAIssuerUrl } from "./mint/keypair.js";
import { issueNegativeIdJag, verifyXaaJwt } from "./mint/signer.js";
import { buildJwtBearerBody } from "./mint/jwt-bearer.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  type NegativeTestMode,
} from "./constants.js";

const ID_JAG_TYP = "oauth-id-jag+jwt";

export interface XaaFlowConfig {
  /** Target MCP server URL (the protected resource). */
  serverUrl: string;
  /**
   * Target authorization-server issuer. When set, protected-resource metadata
   * (RFC 9728) discovery is skipped and this is used directly as the ID-JAG
   * `aud` and the base for token-endpoint discovery.
   */
  authzServerIssuer?: string;
  /** Skip AS-metadata discovery and redeem here directly. */
  tokenEndpoint?: string;
  /**
   * Origin the local mock IdP issues from (and that the AS must fetch JWKS
   * from). The signed `iss` is `getXAAIssuerUrl(issuerBaseUrl)` (appends
   * `/xaa`), reported verbatim.
   */
  issuerBaseUrl: string;
  /** Simulated end-user identity. */
  subject: string;
  email?: string;
  /** OAuth client the ID-JAG is issued for; also presented at redemption. */
  clientId: string;
  clientSecret?: string;
  scope?: string;
  /** Deliberately break the ID-JAG to probe the AS's validation. */
  negativeTestMode?: NegativeTestMode;
  /** Reject non-HTTPS / private targets. Default false (local dev targets). */
  httpsOnly?: boolean;
  onProgress?: (message: string) => void;
}

export interface XaaFlowStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface XaaFlowResult {
  completed: boolean;
  issuer: string;
  authzServerIssuer?: string;
  tokenEndpoint?: string;
  idJag?: {
    token: string;
    claims: Record<string, unknown>;
    /** Local verification against the just-signed key (false for negative modes
     * that break the signature/issuer/type). */
    verified: boolean;
    verifyError?: string;
  };
  redemption?: {
    status: number;
    tokenIssued: boolean;
    error?: string;
    body?: unknown;
  };
  mcp?: { status: number; ok: boolean; error?: string };
  steps: XaaFlowStep[];
  error?: string;
}

function canonicalResource(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    // Preserve the path exactly (including a trailing slash) and the query —
    // both can distinguish resources, and the `resource` we mint/redeem for
    // must match the URL the access token is ultimately used against. URL()
    // still normalizes the origin (lowercase host, default port removal).
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return serverUrl;
  }
}

function wellKnownCandidates(issuer: string, name: string): string[] {
  const trimmed = issuer.replace(/\/+$/, "");
  let origin = trimmed;
  let path = "";
  try {
    const u = new URL(trimmed);
    origin = u.origin;
    path = u.pathname.replace(/\/+$/, "");
  } catch {
    /* keep trimmed as origin */
  }
  if (!path) {
    return [`${origin}/.well-known/${name}`];
  }
  // Path issuer/resource: RFC 8414 path-insertion, the OIDC path-appended form
  // (`issuer + /.well-known/...`, which OIDC-only servers require), and the
  // origin-root form (where RFC 9728 PRM is commonly served). Ordering probes
  // the most specific first; for AS metadata a wrong-tenant root document is
  // rejected downstream by the `metadata.issuer` match check.
  return [
    `${origin}/.well-known/${name}${path}`,
    `${trimmed}/.well-known/${name}`,
    `${origin}/.well-known/${name}`,
  ];
}

export async function runXaaFlow(
  config: XaaFlowConfig,
): Promise<XaaFlowResult> {
  const httpsOnly = config.httpsOnly ?? false;
  const progress = (m: string) => config.onProgress?.(m);
  const steps: XaaFlowStep[] = [];
  const record = (step: string, ok: boolean, detail?: string) => {
    steps.push({ step, ok, detail });
    return ok;
  };

  const resource = canonicalResource(config.serverUrl);

  try {
    // 1. Resolve the target authorization server.
    let authzServerIssuer = config.authzServerIssuer;
    if (!authzServerIssuer) {
      progress("Discovering protected-resource metadata (RFC 9728)…");
      let found: string | undefined;
      for (const url of wellKnownCandidates(
        config.serverUrl,
        "oauth-protected-resource",
      )) {
        const meta = await fetchOAuthMetadata(url, httpsOnly);
        if (!("status" in meta)) {
          // RFC 9728: the metadata's `resource` MUST identify the protected
          // resource we fetched it for. Reject a mismatched document so a
          // compromised/misconfigured well-known can't redirect us to another
          // AS. Skip-and-continue: a later candidate may still be valid, and an
          // explicit --authz-server-issuer bypasses discovery entirely.
          const metaResource = meta.metadata.resource;
          const resourceMatches =
            typeof metaResource === "string" &&
            canonicalResource(metaResource) === resource;
          const servers = meta.metadata.authorization_servers;
          if (
            resourceMatches &&
            Array.isArray(servers) &&
            typeof servers[0] === "string"
          ) {
            found = servers[0];
            break;
          }
        }
      }
      if (!found) {
        record("discover_resource_metadata", false, "no authorization_servers");
        return {
          completed: false,
          issuer: getXAAIssuerUrl(config.issuerBaseUrl),
          steps,
          error:
            "Could not discover the authorization server from the MCP server's protected-resource metadata. Pass the issuer explicitly.",
        };
      }
      authzServerIssuer = found;
      record("discover_resource_metadata", true, authzServerIssuer);
    }

    // 2. Resolve the token endpoint.
    let tokenEndpoint = config.tokenEndpoint;
    if (!tokenEndpoint) {
      progress("Discovering authorization-server metadata (RFC 8414)…");
      for (const name of [
        "oauth-authorization-server",
        "openid-configuration",
      ]) {
        for (const url of wellKnownCandidates(authzServerIssuer, name)) {
          const meta = await fetchOAuthMetadata(url, httpsOnly);
          if (!("status" in meta)) {
            // RFC 8414 §3.3: the metadata's `issuer` MUST match the one we asked
            // for. Reject a mismatched document so it can't redirect the signed
            // assertion (and any client_secret) to another issuer's endpoint.
            const metaIssuer = meta.metadata.issuer;
            const issuerMatches =
              typeof metaIssuer === "string" &&
              metaIssuer.replace(/\/+$/, "") ===
                authzServerIssuer.replace(/\/+$/, "");
            const te = meta.metadata.token_endpoint;
            if (issuerMatches && typeof te === "string") {
              tokenEndpoint = te;
              break;
            }
          }
        }
        if (tokenEndpoint) break;
      }
      if (!tokenEndpoint) {
        record("discover_authz_metadata", false, "no token_endpoint");
        return {
          completed: false,
          issuer: getXAAIssuerUrl(config.issuerBaseUrl),
          authzServerIssuer,
          steps,
          error:
            "Could not discover the authorization server's token endpoint. Pass --token-endpoint explicitly.",
        };
      }
      record("discover_authz_metadata", true, tokenEndpoint);
    }

    // 3. Mint the ID-JAG in-process (self-issued). The driver IS the IdP and
    // already holds the identity, so it mints the grant directly rather than
    // round-tripping an id-token through a token-exchange.
    progress("Minting the ID-JAG…");
    initXAAIdpKeyPair();
    const issuer = getXAAIssuerUrl(config.issuerBaseUrl);
    const mode = config.negativeTestMode ?? DEFAULT_NEGATIVE_TEST_MODE;
    const minted = issueNegativeIdJag(
      {
        issuer,
        subject: config.subject,
        audience: authzServerIssuer,
        resource,
        clientId: config.clientId,
        scope: config.scope,
        email: config.email,
      },
      mode,
    );
    record("mint_id_jag", true, mode === "valid" ? "valid" : `negative:${mode}`);

    // 4. Verify/inspect locally. Negative modes are EXPECTED to fail here.
    let verified = false;
    let verifyError: string | undefined;
    try {
      verifyXaaJwt(minted.token, { issuer, typ: ID_JAG_TYP });
      verified = true;
    } catch (error) {
      verifyError = error instanceof Error ? error.message : String(error);
    }
    record(
      "inspect_id_jag",
      mode === "valid" ? verified : true,
      verified ? "verified" : verifyError,
    );

    const idJag = {
      token: minted.token,
      claims: minted.payload,
      verified,
      verifyError,
    };

    // 5. Redeem at the target AS (RFC 7523 jwt-bearer).
    progress("Redeeming the ID-JAG at the authorization server…");
    const body = buildJwtBearerBody({
      assertion: minted.token,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: config.scope,
      resource,
    });
    const redeemResponse = await executeOAuthProxy({
      url: tokenEndpoint,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      httpsOnly,
    });
    const redeemBody = redeemResponse.body as Record<string, unknown> | null;
    const accessToken =
      redeemBody && typeof redeemBody === "object"
        ? (redeemBody as { access_token?: unknown }).access_token
        : undefined;
    const tokenIssued =
      redeemResponse.status >= 200 &&
      redeemResponse.status < 300 &&
      typeof accessToken === "string";
    const redemptionError = !tokenIssued
      ? (redeemBody as { error_description?: string; error?: string })
          ?.error_description ||
        (redeemBody as { error?: string })?.error ||
        `Authorization server returned ${redeemResponse.status}`
      : undefined;
    record(
      "redeem_id_jag",
      tokenIssued,
      tokenIssued ? "access token issued" : redemptionError,
    );
    const redemption = {
      status: redeemResponse.status,
      tokenIssued,
      error: redemptionError,
      body: redeemResponse.body,
    };

    if (!tokenIssued) {
      return {
        completed: false,
        issuer,
        authzServerIssuer,
        tokenEndpoint,
        idJag,
        redemption,
        steps,
      };
    }

    // 6. Call the MCP server with the access token (SSE-aware via the debug
    // proxy, since streamable-HTTP `initialize` may reply as text/event-stream).
    progress("Calling the MCP server with the access token…");
    const mcpResult = await callAuthenticatedMcp(
      config.serverUrl,
      accessToken as string,
      httpsOnly,
    );
    record(
      "authenticated_mcp_request",
      mcpResult.ok,
      mcpResult.error
        ? `status ${mcpResult.status}: ${mcpResult.error}`
        : `status ${mcpResult.status}`,
    );

    return {
      completed: mcpResult.ok,
      issuer,
      authzServerIssuer,
      tokenEndpoint,
      idJag,
      redemption,
      mcp: mcpResult,
      steps,
    };
  } catch (error) {
    return {
      completed: false,
      issuer: getXAAIssuerUrl(config.issuerBaseUrl),
      steps,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function callAuthenticatedMcp(
  serverUrl: string,
  accessToken: string,
  httpsOnly: boolean,
): Promise<{ status: number; ok: boolean; error?: string }> {
  const response = await executeDebugOAuthProxy({
    url: serverUrl,
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: {
      jsonrpc: "2.0",
      id: "mcpjam-xaa-cli",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "MCPJam XAA CLI", version: "1.0.0" },
      },
    },
    httpsOnly,
  });
  // Transport status alone lies: a 2xx can carry a JSON-RPC error, no JSON-RPC
  // payload at all, or a non-MCP body. The call succeeds only when the server
  // returns a proper JSON-RPC `initialize` result.
  const transportOk = response.status >= 200 && response.status < 300;
  const error = evaluateMcpInitResponse(response.body);
  return {
    status: response.status,
    ok: transportOk && !error,
    ...(error ? { error } : {}),
  };
}

// Returns a failure reason, or undefined when `body` is a valid JSON-RPC
// `initialize` result.
function evaluateMcpInitResponse(body: unknown): string | undefined {
  // A top-level string `error` is a proxy-level failure — most notably the SSE
  // parse-failure envelope executeDebugOAuthProxy returns ({ error: "Failed to
  // parse SSE stream" }, no `transport` field) when the stream times out before
  // the first event.
  if (body && typeof body === "object") {
    const topError = (body as { error?: unknown }).error;
    if (typeof topError === "string" && topError.length > 0) {
      return topError;
    }
  }
  const payload = jsonRpcPayload(body);
  const rpcError = jsonRpcErrorFrom(payload);
  if (rpcError) {
    return rpcError;
  }
  // Require a positive result — an empty SSE envelope (no `message` event) or a
  // 2xx non-MCP body has neither error nor result and must not read as success.
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { result?: unknown }).result === undefined
  ) {
    return "MCP server did not return a JSON-RPC initialize result";
  }
  return undefined;
}

// executeDebugOAuthProxy wraps a text/event-stream reply in an SSE envelope with
// the JSON-RPC payload under `mcpResponse`; a plain JSON body IS the payload.
function jsonRpcPayload(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }
  const record = body as Record<string, unknown>;
  return record.transport === "sse" ? record.mcpResponse : body;
}

function jsonRpcErrorFrom(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  const parts: string[] = [];
  if (typeof code === "number") {
    parts.push(String(code));
  }
  if (typeof message === "string" && message.length > 0) {
    parts.push(message);
  }
  return parts.length > 0 ? parts.join(": ") : "JSON-RPC error";
}
