// Headless Cross-App Access (ID-JAG) flow driver. It self-issues an ID-JAG,
// verifies that the configured issuer actually publishes the signing key,
// redeems the assertion, and probes the protected MCP resource.
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
} from "../oauth-proxy.js";
import {
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT,
} from "../oauth/client-identity.js";
import {
  getXAAIdpJwks,
  getXAAIssuerUrl,
  initXAAIdpKeyPair,
} from "./mint/keypair.js";
import { issueNegativeIdJag, verifyXaaJwt } from "./mint/signer.js";
import {
  buildJwtBearerRequest,
  type XaaTokenEndpointAuthMethod,
} from "./mint/jwt-bearer.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  type NegativeTestMode,
} from "./constants.js";
import {
  buildAuthorizationServerMetadataCandidates,
  buildIssuerPublicationCandidates,
  buildProtectedResourceMetadataCandidates,
  canonicalizeMcpResource,
} from "./discovery.js";
import {
  buildMcpInitializeRequest,
  evaluateMcpInitializeResponse,
  mcpInitializeExtensionEvidence,
  type XaaCapabilityEvidence,
} from "./mcp-init.js";

const ID_JAG_TYP = "oauth-id-jag+jwt";

export type { XaaCapabilityEvidence };

export interface XaaFlowConfig {
  /** Target MCP server URL (the protected resource). */
  serverUrl: string;
  /** Explicit authorization-server issuer; skips resource discovery. */
  authzServerIssuer?: string;
  /** Explicit token endpoint; skips authorization-server discovery. */
  tokenEndpoint?: string;
  /** Base URL whose `/xaa` issuer metadata and JWKS are publicly reachable. */
  issuerBaseUrl: string;
  subject: string;
  email?: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod;
  negativeTestMode?: NegativeTestMode;
  /** Per outbound request timeout in milliseconds. */
  timeoutMs?: number;
  /** Reject non-HTTPS / private targets. Default false for local development. */
  httpsOnly?: boolean;
  onProgress?: (message: string) => void;
}

export interface XaaFlowStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface XaaRedemptionResult {
  status: number;
  tokenIssued: boolean;
  error?: string;
  body?: unknown;
}

export interface XaaFlowResult {
  completed: boolean;
  issuer: string;
  authzServerIssuer?: string;
  tokenEndpoint?: string;
  authorizationServerCapabilities?: {
    idJagProfile: XaaCapabilityEvidence;
    jwtBearerGrant: XaaCapabilityEvidence;
    tokenEndpointAuthMethods?: string[];
    selectedTokenEndpointAuthMethod: XaaTokenEndpointAuthMethod;
  };
  idJag?: {
    token: string;
    claims: Record<string, unknown>;
    verified: boolean;
    verifyError?: string;
  };
  redemption?: XaaRedemptionResult;
  negativeProbe?: {
    mode: Exclude<NegativeTestMode, "valid">;
    baselineAccepted: boolean;
    baselineStatus: number;
    baselineError?: string;
    outcome: "rejected" | "accepted" | "inconclusive";
  };
  mcp?: {
    status: number;
    ok: boolean;
    error?: string;
    xaaExtension: XaaCapabilityEvidence;
  };
  steps: XaaFlowStep[];
  error?: string;
}

interface DiscoveredAuthorizationServer {
  issuer: string;
  tokenEndpoint: string;
  metadata: Record<string, unknown>;
}

interface RedeemedAssertion {
  result: XaaRedemptionResult;
  accessToken?: string;
}

type PublishedJwk = JsonWebKey & { kid?: string };

async function discoverAsTokenEndpoint(
  candidateIssuer: string,
  httpsOnly: boolean,
  timeoutMs: number | undefined
): Promise<DiscoveredAuthorizationServer | undefined> {
  for (const url of buildAuthorizationServerMetadataCandidates(
    candidateIssuer,
  )) {
    const response = await fetchOAuthMetadata(url, httpsOnly, timeoutMs);
    if ("status" in response) continue;

    const issuer = response.metadata.issuer;
    const tokenEndpoint = response.metadata.token_endpoint;
    if (
      typeof issuer === "string" &&
      issuer.replace(/\/+$/, "") === candidateIssuer.replace(/\/+$/, "") &&
      typeof tokenEndpoint === "string"
    ) {
      return { issuer, tokenEndpoint, metadata: response.metadata };
    }
  }
  return undefined;
}

function listEvidence(value: unknown, expected: string): XaaCapabilityEvidence {
  if (value === undefined || value === null) return "unknown";
  return Array.isArray(value) && value.includes(expected)
    ? "advertised"
    : "not_advertised";
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function selectTokenEndpointAuthMethod(
  explicit: XaaTokenEndpointAuthMethod | undefined,
  clientSecret: string | undefined,
  advertised: string[] | undefined
): XaaTokenEndpointAuthMethod {
  if (explicit) return explicit;
  if (!clientSecret) return "none";
  if (advertised?.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  if (advertised?.includes("client_secret_post")) {
    return "client_secret_post";
  }
  if (advertised?.includes("none")) return "none";
  // Metadata is optional; preserve the previous behavior when it is absent.
  return "client_secret_post";
}

function publicJwkMatches(local: JsonWebKey, published: JsonWebKey): boolean {
  if (local.kty !== published.kty) return false;
  if (local.kty === "RSA") {
    return local.n === published.n && local.e === published.e;
  }
  return (
    local.crv === published.crv &&
    local.x === published.x &&
    local.y === published.y
  );
}

async function verifyIssuerPublication(
  issuer: string,
  httpsOnly: boolean,
  timeoutMs: number | undefined
): Promise<{ ok: boolean; detail: string }> {
  let metadata: Record<string, unknown> | undefined;
  for (const url of buildIssuerPublicationCandidates(issuer)) {
    const response = await fetchOAuthMetadata(url, httpsOnly, timeoutMs);
    if (!("status" in response) && response.metadata.issuer === issuer) {
      metadata = response.metadata;
      break;
    }
  }

  if (!metadata) {
    return {
      ok: false,
      detail: `No OpenID configuration with issuer ${issuer} was reachable`,
    };
  }

  const jwksUri = metadata.jwks_uri;
  if (typeof jwksUri !== "string") {
    return { ok: false, detail: "Issuer metadata does not contain jwks_uri" };
  }

  const response = await executeOAuthProxy({
    url: jwksUri,
    headers: { Accept: "application/json" },
    httpsOnly,
    timeoutMs,
  });
  const rawKeys =
    response.status >= 200 &&
    response.status < 300 &&
    response.body &&
    typeof response.body === "object" &&
    Array.isArray((response.body as { keys?: unknown }).keys)
      ? (response.body as { keys: PublishedJwk[] }).keys ?? []
      : [];
  const keys = rawKeys.filter(
    (key): key is PublishedJwk => Boolean(key) && typeof key === "object"
  );
  const localKey = getXAAIdpJwks().keys[0];
  const matchingKey = keys.find(
    (key) => key.kid === localKey.kid && publicJwkMatches(localKey, key)
  );
  if (!matchingKey) {
    return {
      ok: false,
      detail: `Published JWKS ${jwksUri} does not contain the local signing key ${localKey.kid}`,
    };
  }
  return { ok: true, detail: `${jwksUri} (${localKey.kid})` };
}

async function redeemAssertion(args: {
  assertion: string;
  tokenEndpoint: string;
  tokenEndpointAuthMethod: XaaTokenEndpointAuthMethod;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  resource: string;
  httpsOnly: boolean;
  timeoutMs?: number;
}): Promise<RedeemedAssertion> {
  const request = buildJwtBearerRequest({
    assertion: args.assertion,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    scope: args.scope,
    resource: args.resource,
    tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
  });
  const response = await executeOAuthProxy({
    url: args.tokenEndpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...request.headers,
    },
    body: request.body,
    httpsOnly: args.httpsOnly,
    timeoutMs: args.timeoutMs,
  });
  const body =
    response.body && typeof response.body === "object"
      ? (response.body as Record<string, unknown>)
      : undefined;
  const accessToken = body?.access_token;
  const tokenIssued =
    response.status >= 200 &&
    response.status < 300 &&
    typeof accessToken === "string";
  const errorDescription = body?.error_description;
  const oauthError = body?.error;
  const error = !tokenIssued
    ? (typeof errorDescription === "string" ? errorDescription : undefined) ||
      (typeof oauthError === "string" ? oauthError : undefined) ||
      `Authorization server returned ${response.status}`
    : undefined;
  return {
    result: {
      status: response.status,
      tokenIssued,
      ...(error ? { error } : {}),
      body: response.body,
    },
    ...(typeof accessToken === "string" ? { accessToken } : {}),
  };
}

export async function runXaaFlow(
  config: XaaFlowConfig
): Promise<XaaFlowResult> {
  const httpsOnly = config.httpsOnly ?? false;
  const progress = (message: string) => config.onProgress?.(message);
  const steps: XaaFlowStep[] = [];
  const record = (step: string, ok: boolean, detail?: string) => {
    steps.push({ step, ok, detail });
    return ok;
  };
  const resource = canonicalizeMcpResource(config.serverUrl);

  try {
    let candidateIssuers: string[];
    if (config.authzServerIssuer) {
      candidateIssuers = [config.authzServerIssuer];
    } else {
      progress("Discovering protected-resource metadata (RFC 9728)…");
      let servers: string[] = [];
      for (const url of buildProtectedResourceMetadataCandidates(
        config.serverUrl
      )) {
        const response = await fetchOAuthMetadata(
          url,
          httpsOnly,
          config.timeoutMs
        );
        if ("status" in response) continue;

        const resourceMatches =
          typeof response.metadata.resource === "string" &&
          canonicalizeMcpResource(response.metadata.resource) === resource;
        const advertised = response.metadata.authorization_servers;
        if (resourceMatches && Array.isArray(advertised)) {
          servers = advertised.filter(
            (entry): entry is string => typeof entry === "string"
          );
          if (servers.length > 0) break;
        }
      }
      if (servers.length === 0) {
        record("discover_resource_metadata", false, "no authorization_servers");
        return {
          completed: false,
          issuer: getXAAIssuerUrl(config.issuerBaseUrl),
          steps,
          error:
            "Could not discover the authorization server from the MCP server's protected-resource metadata. Pass the issuer explicitly.",
        };
      }
      candidateIssuers = servers;
      record("discover_resource_metadata", true, servers.join(", "));
    }

    let authzServerIssuer: string;
    let tokenEndpoint = config.tokenEndpoint;
    let authzMetadata: Record<string, unknown> | undefined;
    if (tokenEndpoint) {
      authzServerIssuer = candidateIssuers[0];
    } else {
      progress("Discovering authorization-server metadata (RFC 8414)…");
      let resolved: DiscoveredAuthorizationServer | undefined;
      for (const candidate of candidateIssuers) {
        resolved = await discoverAsTokenEndpoint(
          candidate,
          httpsOnly,
          config.timeoutMs
        );
        if (resolved) break;
      }
      if (!resolved) {
        record("discover_authz_metadata", false, "no token_endpoint");
        return {
          completed: false,
          issuer: getXAAIssuerUrl(config.issuerBaseUrl),
          authzServerIssuer: candidateIssuers[0],
          steps,
          error:
            "Could not discover the authorization server's token endpoint. Pass --token-endpoint explicitly.",
        };
      }
      authzServerIssuer = resolved.issuer;
      tokenEndpoint = resolved.tokenEndpoint;
      authzMetadata = resolved.metadata;
      record("discover_authz_metadata", true, tokenEndpoint);
    }

    const advertisedAuthMethods = stringList(
      authzMetadata?.token_endpoint_auth_methods_supported
    );
    const selectedTokenEndpointAuthMethod = selectTokenEndpointAuthMethod(
      config.tokenEndpointAuthMethod,
      config.clientSecret,
      advertisedAuthMethods
    );
    const authorizationServerCapabilities = {
      idJagProfile: listEvidence(
        authzMetadata?.authorization_grant_profiles_supported,
        ID_JAG_GRANT_PROFILE
      ),
      jwtBearerGrant: listEvidence(
        authzMetadata?.grant_types_supported,
        JWT_BEARER_GRANT
      ),
      ...(advertisedAuthMethods
        ? { tokenEndpointAuthMethods: advertisedAuthMethods }
        : {}),
      selectedTokenEndpointAuthMethod,
    };
    record(
      "authorization_server_id_jag_profile",
      authorizationServerCapabilities.idJagProfile !== "not_advertised",
      authorizationServerCapabilities.idJagProfile
    );
    record(
      "authorization_server_jwt_bearer_grant",
      authorizationServerCapabilities.jwtBearerGrant !== "not_advertised",
      authorizationServerCapabilities.jwtBearerGrant
    );
    record(
      "select_token_endpoint_auth_method",
      true,
      selectedTokenEndpointAuthMethod
    );

    progress("Verifying the configured issuer metadata and JWKS…");
    initXAAIdpKeyPair();
    const issuer = getXAAIssuerUrl(config.issuerBaseUrl);
    const issuerPublication = await verifyIssuerPublication(
      issuer,
      httpsOnly,
      config.timeoutMs
    );
    record(
      "verify_issuer_publication",
      issuerPublication.ok,
      issuerPublication.detail
    );
    if (!issuerPublication.ok) {
      return {
        completed: false,
        issuer,
        authzServerIssuer,
        tokenEndpoint,
        authorizationServerCapabilities,
        steps,
        error:
          "The configured issuer does not publish the local signing key; the authorization server cannot validate this ID-JAG.",
      };
    }

    const mode = config.negativeTestMode ?? DEFAULT_NEGATIVE_TEST_MODE;
    const issueParams = {
      issuer,
      subject: config.subject,
      audience: authzServerIssuer,
      resource,
      clientId: config.clientId,
      scope: config.scope,
      email: config.email,
    };
    progress("Minting the ID-JAG…");
    const minted = issueNegativeIdJag(issueParams, mode);
    record(
      "mint_id_jag",
      true,
      mode === "valid" ? "valid" : `negative:${mode}`
    );

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
      verified ? "verified" : verifyError
    );
    const idJag = {
      token: minted.token,
      claims: minted.payload,
      verified,
      ...(verifyError ? { verifyError } : {}),
    };
    const redemptionArgs = {
      tokenEndpoint,
      tokenEndpointAuthMethod: selectedTokenEndpointAuthMethod,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: config.scope,
      resource,
      httpsOnly,
      timeoutMs: config.timeoutMs,
    };

    if (mode !== "valid") {
      progress("Establishing a valid ID-JAG redemption baseline…");
      const baseline = await redeemAssertion({
        ...redemptionArgs,
        assertion: issueNegativeIdJag(issueParams, "valid").token,
      });
      record(
        "redeem_valid_baseline",
        baseline.result.tokenIssued,
        baseline.result.tokenIssued
          ? "access token issued"
          : baseline.result.error
      );
      if (!baseline.result.tokenIssued) {
        return {
          completed: false,
          issuer,
          authzServerIssuer,
          tokenEndpoint,
          authorizationServerCapabilities,
          idJag,
          negativeProbe: {
            mode,
            baselineAccepted: false,
            baselineStatus: baseline.result.status,
            ...(baseline.result.error
              ? { baselineError: baseline.result.error }
              : {}),
            outcome: "inconclusive",
          },
          steps,
          error:
            "The valid baseline was not accepted, so the negative probe cannot be scored.",
        };
      }

      progress("Redeeming the deliberately invalid ID-JAG…");
      const probe = await redeemAssertion({
        ...redemptionArgs,
        assertion: minted.token,
      });
      const outcome = probe.result.tokenIssued
        ? "accepted"
        : probe.result.status >= 400 && probe.result.status < 500
        ? "rejected"
        : "inconclusive";
      record(
        "redeem_negative_id_jag",
        outcome === "rejected",
        outcome === "rejected"
          ? `rejected with status ${probe.result.status}`
          : outcome === "accepted"
          ? "authorization server issued an access token"
          : probe.result.error
      );
      return {
        completed: outcome === "rejected",
        issuer,
        authzServerIssuer,
        tokenEndpoint,
        authorizationServerCapabilities,
        idJag,
        redemption: probe.result,
        negativeProbe: {
          mode,
          baselineAccepted: true,
          baselineStatus: baseline.result.status,
          outcome,
        },
        steps,
        ...(outcome === "accepted"
          ? {
              error:
                "The authorization server accepted the deliberately invalid ID-JAG.",
            }
          : outcome === "inconclusive"
          ? {
              error:
                "The negative probe did not produce a conclusive 4xx rejection.",
            }
          : {}),
      };
    }

    progress("Redeeming the ID-JAG at the authorization server…");
    const redeemed = await redeemAssertion({
      ...redemptionArgs,
      assertion: minted.token,
    });
    record(
      "redeem_id_jag",
      redeemed.result.tokenIssued,
      redeemed.result.tokenIssued
        ? "access token issued"
        : redeemed.result.error
    );
    if (!redeemed.result.tokenIssued || !redeemed.accessToken) {
      return {
        completed: false,
        issuer,
        authzServerIssuer,
        tokenEndpoint,
        authorizationServerCapabilities,
        idJag,
        redemption: redeemed.result,
        steps,
      };
    }

    progress("Calling the MCP server with the access token…");
    const mcpResult = await callAuthenticatedMcp(
      config.serverUrl,
      redeemed.accessToken,
      httpsOnly,
      config.timeoutMs
    );
    record(
      "authenticated_mcp_request",
      mcpResult.ok,
      mcpResult.error
        ? `status ${mcpResult.status}: ${mcpResult.error}`
        : `status ${mcpResult.status}`
    );
    record(
      "mcp_xaa_extension",
      mcpResult.xaaExtension !== "not_advertised",
      mcpResult.xaaExtension
    );

    return {
      completed: mcpResult.ok,
      issuer,
      authzServerIssuer,
      tokenEndpoint,
      authorizationServerCapabilities,
      idJag,
      redemption: redeemed.result,
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
  timeoutMs: number | undefined
): Promise<{
  status: number;
  ok: boolean;
  error?: string;
  xaaExtension: XaaCapabilityEvidence;
}> {
  const request = buildMcpInitializeRequest(accessToken);
  const response = await executeDebugOAuthProxy({
    url: serverUrl,
    method: "POST",
    headers: request.headers,
    body: request.body,
    httpsOnly,
    timeoutMs,
  });
  const error = evaluateMcpInitializeResponse(response.body);
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300 && !error,
    ...(error ? { error } : {}),
    xaaExtension: mcpInitializeExtensionEvidence(response.body),
  };
}
