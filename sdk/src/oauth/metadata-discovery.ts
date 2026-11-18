/**
 * OAuth metadata discovery for an MCP server: RFC 9728 Protected Resource
 * Metadata, then RFC 8414 / OpenID Connect metadata for the authorization
 * server it names. `probeMcpServer` runs this after a challenge; a caller that
 * already holds the challenge calls it directly and gets the same answer.
 *
 * The well-known URLs and their order come from `metadata-candidates.ts`,
 * which the readiness runners, the conformance suite, the browser auth flow
 * and the debug state machines also build from.
 *
 * Browser-safe.
 */

import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { buildResourceMetadataUrl } from "./state-machines/shared/urls.js";
import { parseBearerAuthenticateParameters } from "./state-machines/shared/challenges.js";
import {
  assertOutboundOAuthUrlAllowed,
  isLoopbackOAuthUrl,
} from "./ssrf-guard.js";
import { resolveRegistrationStrategies } from "./authorization-plan.js";
import { isSensitiveHeaderName } from "./state-machines/trace-redaction.js";
import type { OAuthProtocolVersion } from "./state-machines/types.js";
import {
  authorizationServerMetadataUrls,
  findMetadataDocument,
  mcpAuthorizationServerMetadataForms,
  type AuthorizationServerMetadataCandidate,
} from "./metadata-candidates.js";
import {
  normalizeHeaders,
  normalizeProtocolVersion,
  performRequest,
  type ProbeHttpAttempt,
} from "../probe-http.js";

export interface ProbeOAuthDetails {
  required: boolean;
  optional: boolean;
  wwwAuthenticate?: string;
  resourceMetadataUrl?: string;
  resourceMetadata?: Record<string, unknown>;
  authorizationServerMetadataUrl?: string;
  authorizationServerMetadata?: Record<string, unknown>;
  registrationStrategies: Array<"preregistered" | "dcr" | "cimd">;
  discoveryError?: string;
  /**
   * The status the challenge arrived on, when MCP does not allow it there.
   * Absent for a compliant 401 — set means the probe accepted a challenge the
   * spec says should not have been delivered this way, so callers reporting
   * conformance can say so rather than presenting the server as clean.
   */
  nonCompliantChallengeStatus?: number;
}

/**
 * Drop every credential-shaped header, not just `Authorization`.
 *
 * Discovery dials hosts the *target* names in its own `WWW-Authenticate`
 * challenge, so the user never chose them. Filtering a single header name left
 * `X-Api-Key` and friends — anything the user stored against the server — going
 * to a host of the target's choosing. Metadata endpoints are unauthenticated by
 * definition, so over-stripping here costs nothing and under-stripping egresses
 * a credential.
 */
function removeCredentialHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !isSensitiveHeaderName(key))
  );
}

/**
 * Refuse a metadata destination the probed server chose for us. Both the RFC
 * 9728 `resource_metadata` pointer and the authorization server it advertises
 * come from upstream, so without this a hostile challenge steers the probe —
 * which runs in MCPJam's hosted backend, reachable on a guest-allowed doctor
 * route — at cloud metadata or a service on the private network.
 *
 * Same origin as the configured server URL is always allowed: that is the
 * origin the caller already asked the probe to contact, so a loopback or LAN
 * MCP server keeps discovering its own metadata. Everything else goes through
 * the shared guard, with the loopback opt-in derived from the server URL so
 * local dev can host its authorization server on another loopback port while a
 * public server can never reach the user's.
 */
export function assertMetadataDestinationAllowed(
  candidate: string,
  serverUrl: string,
  allowPrivateNetwork = false
): void {
  try {
    const target = new URL(candidate);
    const server = new URL(serverUrl);
    // Compare scheme and host rather than `origin`. Every non-special scheme
    // reports the origin `"null"`, and `blob:https://host/…` reports the origin
    // of the URL it wraps with no host of its own — so an `origin` comparison
    // lets a `blob:` pointer at the configured server's origin skip the guard
    // entirely. Restricting the shortcut to the schemes the probe can actually
    // dial keeps it to what it is for: the origin the caller already named.
    if (
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.protocol === server.protocol &&
      target.host === server.host
    ) {
      return;
    }
  } catch {
    // Unparseable: leave the rejection to the guard, which reports it uniformly.
  }

  assertOutboundOAuthUrlAllowed(candidate, {
    allowLoopback: isLoopbackOAuthUrl(serverUrl),
    allowPrivateNetwork,
  });
}

export interface AuthorizationMetadataDiscoveryConfig {
  /** The MCP server URL: the protected resource. */
  url: string;
  /** Picks the well-known order for authorization-server metadata. */
  protocolVersion?: OAuthProtocolVersion;
  /**
   * Headers the caller sends the server. Credential-shaped ones are dropped
   * before any metadata request; see {@link removeCredentialHeaders}.
   */
  headers?: Record<string, string>;
  /** Per-request budget. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** See `ProbeMcpServerConfig.allowPrivateNetwork`. */
  allowPrivateNetwork?: boolean;
}

export interface AuthorizationMetadataDiscoveryOptions {
  /** The server's `WWW-Authenticate` challenge, when it sent one. */
  wwwAuthenticate?: string;
  /**
   * The server answered without a challenge. A failed lookup then means the
   * server does not use OAuth, not that its OAuth setup is broken.
   */
  optional: boolean;
  /** Every request is appended here as it is made. */
  attempts?: ProbeHttpAttempt[];
}

/**
 * Protected Resource Metadata (the challenge's `resource_metadata` pointer,
 * else the well-known URLs), then metadata for the first authorization server
 * it names, in the order `config.protocolVersion` prescribes.
 *
 * No credential header reaches a metadata host, every destination the server
 * chose passes {@link assertMetadataDestinationAllowed}, and each request has
 * `config.timeoutMs`.
 */
export async function discoverAuthorizationMetadata(
  config: AuthorizationMetadataDiscoveryConfig,
  {
    wwwAuthenticate: wwwAuthenticateHeader,
    optional,
    attempts = [],
  }: AuthorizationMetadataDiscoveryOptions
): Promise<ProbeOAuthDetails> {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const metadataHeaders = removeCredentialHeaders(
    normalizeHeaders(config.headers)
  );
  // Read the pointer off the Bearer challenge rather than the raw header. A
  // bare `resource_metadata="…"` match takes the value wherever it sits —
  // including inside another scheme's challenge, or inside a quoted realm that
  // only looks like one — which points discovery at a PRM URL the server never
  // advertised for Bearer.
  const resourceMetadataUrlFromHeader =
    parseBearerAuthenticateParameters(wwwAuthenticateHeader)
      .resource_metadata || undefined;
  const resourceMetadataUrl =
    resourceMetadataUrlFromHeader ?? buildResourceMetadataUrl(config.url);

  const resourceMetadataAttempt: ProbeHttpAttempt = {
    name: "resource_metadata",
    request: {
      method: "GET",
      url: resourceMetadataUrl,
      headers: metadataHeaders,
    },
    durationMs: 0,
  };

  try {
    // Guard before recording the attempt: a refused pointer produces no request,
    // so an attempt entry with no response would misreport what happened.
    if (resourceMetadataUrlFromHeader) {
      assertMetadataDestinationAllowed(
        resourceMetadataUrlFromHeader,
        config.url,
        config.allowPrivateNetwork
      );
    }
    attempts.push(resourceMetadataAttempt);

    const loggingFetch: typeof fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      const mergedHeaders = {
        ...metadataHeaders,
        ...normalizeHeaders(init.headers),
      };
      const attempt =
        resourceMetadataAttempt.request.url === url
          ? resourceMetadataAttempt
          : {
              name: "resource_metadata" as const,
              request: {
                method: init.method ?? "GET",
                url,
                headers: mergedHeaders,
              },
              durationMs: 0,
            };
      if (attempt !== resourceMetadataAttempt) {
        attempts.push(attempt);
      } else {
        resourceMetadataAttempt.request.headers = mergedHeaders;
        resourceMetadataAttempt.request.method = init.method ?? "GET";
      }

      const response = await performRequest(
        config.fetchFn ?? fetch,
        attempt,
        config.timeoutMs,
        (landingUrl) =>
          assertMetadataDestinationAllowed(
            landingUrl,
            config.url,
            config.allowPrivateNetwork
          )
      );

      return new Response(
        response.body === undefined ? null : JSON.stringify(response.body),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }
      );
    };

    const metadata = await discoverOAuthProtectedResourceMetadata(
      config.url,
      resourceMetadataUrlFromHeader
        ? { resourceMetadataUrl: resourceMetadataUrlFromHeader }
        : undefined,
      loggingFetch
    );

    const advertisedAuthServer = metadata.authorization_servers?.[0];
    const authorizationServerUrl = advertisedAuthServer ?? config.url;
    let guardError: string | undefined;
    let candidates: AuthorizationServerMetadataCandidate[] = [];

    try {
      // Second hop, same problem: the PRM document that named this origin came
      // from a pointer the server chose. Guard the origin once rather than each
      // candidate — they share it by construction — and only when the document
      // advertised one, so the `?? config.url` fallback never blocks a LAN or
      // loopback server discovering its own metadata. This also keeps a
      // malformed entry from aborting discovery inside `new URL()` below.
      if (advertisedAuthServer) {
        assertMetadataDestinationAllowed(
          advertisedAuthServer,
          config.url,
          config.allowPrivateNetwork
        );
      }
      candidates = authorizationServerMetadataUrls(
        authorizationServerUrl,
        mcpAuthorizationServerMetadataForms(protocolVersion)
      );
    } catch (error) {
      guardError = error instanceof Error ? error.message : String(error);
    }

    const lookup = await findMetadataDocument(candidates, async ({ url }) => {
      const authAttempt: ProbeHttpAttempt = {
        name: "authorization_server_metadata",
        request: {
          method: "GET",
          url,
          headers: metadataHeaders,
        },
        durationMs: 0,
      };
      attempts.push(authAttempt);

      try {
        const response = await performRequest(
          config.fetchFn ?? fetch,
          authAttempt,
          config.timeoutMs,
          (landingUrl) =>
            assertMetadataDestinationAllowed(
              landingUrl,
              config.url,
              config.allowPrivateNetwork
            )
        );

        if (
          response.status >= 200 &&
          response.status < 300 &&
          response.body &&
          typeof response.body === "object"
        ) {
          return { document: response.body as Record<string, unknown> };
        }

        return { error: `HTTP ${response.status} ${response.statusText}` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    const authorizationServerMetadata = lookup.found
      ? lookup.document
      : undefined;
    const lastAuthError = lookup.found
      ? undefined
      : (lookup.lastError ?? guardError);

    return {
      required: !optional,
      optional,
      wwwAuthenticate: wwwAuthenticateHeader,
      resourceMetadataUrl,
      resourceMetadata: metadata as Record<string, unknown>,
      authorizationServerMetadataUrl: lookup.found
        ? lookup.candidate.url
        : undefined,
      authorizationServerMetadata,
      registrationStrategies: resolveRegistrationStrategies(
        protocolVersion,
        authorizationServerMetadata
      ),
      ...(lastAuthError ? { discoveryError: lastAuthError } : {}),
    };
  } catch (error) {
    if (optional) {
      return {
        required: false,
        optional: false,
        resourceMetadataUrl,
        registrationStrategies: [],
      };
    }

    return {
      required: true,
      optional: false,
      wwwAuthenticate: wwwAuthenticateHeader,
      resourceMetadataUrl,
      registrationStrategies: ["preregistered"],
      discoveryError: error instanceof Error ? error.message : String(error),
    };
  }
}
