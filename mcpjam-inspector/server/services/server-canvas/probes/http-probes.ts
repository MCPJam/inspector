/**
 * The `http-transport` and `authorization` probes: one unauthenticated
 * `probeMcpServer` run through the connection-request egress guard
 * (`probeThroughEgressGuard`), mapped to the contract's value keys.
 *
 * No credential is sent: no token, no stored headers, no cookies. The probe
 * sees what an anonymous client sees, which is the point: the 401 challenge,
 * the protected resource metadata and the authorization server metadata are
 * public. Hosted, every hop dials the pinned transport and private targets are
 * refused. Locally, a loopback or LAN server is probed as it is for connect,
 * and its metadata may point at private addresses; a public server's may not
 * (`private-target.ts`). When a server that answered points its authorization
 * metadata at an address the guard refuses, the transport facts stay and the
 * authorization summary is partial; only a refused server URL fails both.
 */
import {
  parseBearerAuthenticateParameters,
  type ProbeMcpServerResult,
  type ProbeSummary,
} from "@mcpjam/sdk";
import { isLoopbackOAuthUrl } from "@mcpjam/sdk/oauth/node";
import { HOSTED_MODE } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import {
  probeThroughEgressGuard,
  type RunDiscoveryPreflightDependencies,
} from "../../server-connection-discovery.js";
import {
  isRecord,
  probeSummary,
  storableUrl,
  stringList,
  unranProbe,
  type ProbeValues,
} from "./shared.js";

/** Per request; the guard's own deadline bounds the whole probe. */
export const HTTP_PROBE_TIMEOUT_MS = 10_000;

export interface HttpProbeSummaries {
  httpTransport: ProbeSummary<"http-transport">;
  authorization: ProbeSummary<"authorization">;
}

const NO_ANSWER = "The server did not answer the unauthenticated probe.";
const REFUSED = "MCPJam may not reach this server address from here.";
export const METADATA_REFUSED =
  "MCPJam did not read authorization metadata at a private network address. Serve the metadata from a public address to check it here.";

function responseMode(contentType: string | undefined): string | null {
  if (!contentType) return null;
  if (contentType.includes("text/event-stream")) return "text/event-stream";
  if (contentType.includes("application/json")) return "application/json";
  return null;
}

function sessionIdIssued(probe: ProbeMcpServerResult): boolean | undefined {
  if (probe.transport.selected !== "streamable-http") return undefined;
  const attempt = probe.transport.attempts.find(
    (entry) =>
      entry.name === "streamable_initialize" &&
      entry.response !== undefined &&
      entry.response.status >= 200 &&
      entry.response.status < 300,
  );
  if (!attempt?.response) return undefined;
  return Object.keys(attempt.response.headers).some(
    (name) => name.toLowerCase() === "mcp-session-id",
  );
}

export function httpTransportSummary(
  probe: ProbeMcpServerResult,
  at: number,
): ProbeSummary<"http-transport"> {
  if (probe.status === "error") {
    return probeSummary("http-transport", {
      status: "failed",
      coverage: "not-captured",
      at,
      detail: NO_ANSWER,
      values: { status: "error" },
    });
  }
  const selected = probe.transport.selected;
  const values: ProbeValues<"http-transport"> = {
    status: probe.status,
    selectedTransport: selected ?? null,
    protocolVersion: probe.initialize?.protocolVersion ?? null,
  };
  if (selected === "streamable-http") values.streamableHttp = true;
  if (selected === "sse") {
    values.streamableHttp = false;
    values.legacySse = true;
  }
  if (selected !== undefined) {
    values.responseContentType = responseMode(probe.initialize?.contentType);
  }
  const issued = sessionIdIssued(probe);
  if (issued !== undefined) values.sessionIdIssued = issued;
  return probeSummary("http-transport", {
    status: "ok",
    // Only a server that answered initialize shows its transport; one that
    // asked for OAuth first leaves the rest unknown.
    coverage: probe.status === "ready" ? "complete" : "partial",
    at,
    values,
  });
}

function asMetadataKind(url: string | undefined): "oauth" | "oidc" | null {
  if (!url) return null;
  return url.includes("openid-configuration") ? "oidc" : "oauth";
}

export function authorizationSummary(
  probe: ProbeMcpServerResult,
  at: number,
): ProbeSummary<"authorization"> {
  if (probe.status === "error") {
    return probeSummary("authorization", {
      status: "failed",
      coverage: "not-captured",
      at,
      detail: NO_ANSWER,
    });
  }
  const { oauth } = probe;
  const values: ProbeValues<"authorization"> = {
    oauthRequired: oauth.required,
    oauthOptional: oauth.optional,
    nonCompliantChallengeStatus: oauth.nonCompliantChallengeStatus ?? null,
    registrationStrategies: oauth.registrationStrategies,
  };
  if (oauth.required) {
    values.challengeHasResourceMetadata = Boolean(
      parseBearerAuthenticateParameters(oauth.wwwAuthenticate).resource_metadata,
    );
  }
  const usesOAuth = oauth.required || oauth.optional;
  if (usesOAuth) {
    const prm = oauth.resourceMetadata;
    values.prmFound = isRecord(prm);
    if (isRecord(prm)) {
      values.prmResource = storableUrl(prm.resource);
      values.prmAuthorizationServers = stringList(prm.authorization_servers)
        .map(storableUrl)
        .filter((url): url is string => url !== null);
      values.prmScopesSupported = stringList(prm.scopes_supported);
    }
    const as = oauth.authorizationServerMetadata;
    values.asMetadataFound = isRecord(as);
    values.asMetadataKind = isRecord(as)
      ? asMetadataKind(oauth.authorizationServerMetadataUrl)
      : null;
    if (isRecord(as)) {
      values.issuer = storableUrl(as.issuer);
      values.grantTypesSupported = stringList(as.grant_types_supported);
      values.tokenEndpointAuthMethods = stringList(
        as.token_endpoint_auth_methods_supported,
      );
      values.codeChallengeMethods = stringList(
        as.code_challenge_methods_supported,
      );
      values.responseTypesSupported = stringList(as.response_types_supported);
      values.registrationEndpoint = typeof as.registration_endpoint === "string";
      values.cimdSupported = as.client_id_metadata_document_supported === true;
      values.authorizationGrantProfiles = stringList(
        as.authorization_grant_profiles_supported,
      );
    }
  }
  return probeSummary("authorization", {
    status: "ok",
    coverage:
      usesOAuth && oauth.discoveryError !== undefined ? "partial" : "complete",
    at,
    values,
  });
}

/**
 * Runs the unauthenticated probe once and maps it to both summaries. Never
 * throws: a refused or unreachable server is two `failed` summaries.
 */
export async function runHttpProbes(
  input: {
    serverUrl: string;
    now: () => number;
    /** The server itself is on a private network (`serverOnPrivateNetwork`). */
    privateTarget: boolean;
  },
  dependencies: Pick<RunDiscoveryPreflightDependencies, "fetchFn" | "probeServer"> = {},
): Promise<HttpProbeSummaries> {
  let guarded: Awaited<ReturnType<typeof probeThroughEgressGuard>>;
  try {
    guarded = await probeThroughEgressGuard(
      {
        serverUrl: input.serverUrl,
        // Locally a loopback server is the product; hosted, never.
        allowLoopback: !HOSTED_MODE && isLoopbackOAuthUrl(input.serverUrl),
        allowPrivateNetwork: input.privateTarget,
        timeoutMs: HTTP_PROBE_TIMEOUT_MS,
      },
      dependencies,
    );
  } catch (error) {
    // The name only: a message can carry the server URL and its query.
    logger.debug("[server-canvas] HTTP probe threw", {
      error: error instanceof Error ? error.name : typeof error,
    });
    guarded = { kind: "unreachable", detail: NO_ANSWER };
  }
  const at = input.now();
  if (guarded.kind === "refused" && guarded.answeredProbe) {
    // The server answered; the guard refused a hop its metadata led to.
    return {
      httpTransport: httpTransportSummary(guarded.answeredProbe, at),
      authorization: {
        ...authorizationSummary(guarded.answeredProbe, at),
        coverage: "partial",
        detail: METADATA_REFUSED,
      },
    };
  }
  if (guarded.kind !== "probed") {
    const detail = guarded.kind === "refused" ? REFUSED : NO_ANSWER;
    return {
      httpTransport: unranProbe("http-transport", "failed", at, detail),
      authorization: unranProbe("authorization", "failed", at, detail),
    };
  }
  return {
    httpTransport: httpTransportSummary(guarded.probe, at),
    authorization: authorizationSummary(guarded.probe, at),
  };
}
