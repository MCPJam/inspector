/**
 * Evidence gathering: the only part of readiness that touches the network.
 *
 * WHY IT IS SEPARATE. Every check module in `checks/` is a pure function over
 * evidence, which makes each one testable against a fixture and — more
 * importantly — makes it structurally impossible for a check to dial a target
 * on its own. In a hosted run the ONLY transport allowed out is the pinned one,
 * and "the checks cannot reach the network" is a much stronger guarantee than
 * "the checks are careful about it".
 *
 * WHAT IT DOES. Metadata only: an unauthenticated probe, RFC 9728 Protected
 * Resource Metadata discovery in the documented order, and one authorization
 * server metadata document. Nothing here registers a client, spends a grant,
 * or writes anything. Side-effecting probes live behind the intrusive opt-in
 * and are not in this module.
 *
 * `fetchFn` is required rather than defaulted to the global fetch. A default
 * would make "forgot to pass the guard" the silent case, and the silent case
 * is the one that reaches `169.254.169.254`.
 */

import { parseBearerAuthenticateParameters } from "../oauth/state-machines/shared/challenges.js";
import type { ClaudeAuthEvidence } from "./checks/auth.js";
import type { ClaudeEndpointEvidence } from "./checks/endpoint.js";
import {
  discoverProtectedResourceMetadata as discoverPrm,
  fetchDiscoveryJson,
  traceRedirects,
  type DirectoryDiscoveryOptions,
} from "../directory-readiness/discovery.js";

export interface ClaudeDiscoveryOptions extends DirectoryDiscoveryOptions {}

/**
 * Walk the connector URL's redirect chain by hand.
 *
 * The transport follows redirects internally and reports only where it landed;
 * the endpoint checks need each HOP, because a chain that downgrades in the
 * middle and recovers is invisible from the destination alone.
 *
 * The walk itself is publisher-neutral and lives in
 * `directory-readiness/discovery.ts`; this keeps the name Claude's callers use.
 */
export async function traceConnectorRedirects(
  options: ClaudeDiscoveryOptions,
): Promise<ClaudeEndpointEvidence> {
  return traceRedirects(options);
}

/**
 * The unauthenticated probe: a JSON-RPC `initialize` with no credentials.
 *
 * `initialize` rather than a bare GET because it is the request Claude
 * actually makes first, so the response is the one Claude actually sees. It
 * creates no resources and consumes nothing beyond a session the server is
 * free to discard.
 */
async function probeUnauthenticated(
  options: ClaudeDiscoveryOptions,
): Promise<ClaudeAuthEvidence["unauthenticated"]> {
  const result = await fetchDiscoveryJson(options.enteredUrl, options, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcpjam-claude-readiness", version: "1" },
      },
    }),
  });

  if (result.status === 0) return undefined;

  // "Served without credentials" means the server answered the MCP request,
  // not merely that it answered with a 200 — an HTML error page is a 200 too.
  const servedWithoutCredentials =
    result.status >= 200 &&
    result.status < 300 &&
    (result.document?.result !== undefined ||
      result.document?.error !== undefined);

  return {
    status: result.status,
    wwwAuthenticate: result.headers.get("www-authenticate") ?? undefined,
    // The probe IS an attempted protected operation: `initialize` is the call
    // Claude makes to use the connector, so a challenge riding on a successful
    // one is the mixed signal the check is about.
    representsProtectedOperation: true,
    servedWithoutCredentials,
  };
}

/**
 * Find the Protected Resource Metadata document.
 *
 * Delegates to the shared implementation: the discovery ORDER (challenge
 * pointer, then path-suffixed well-known, then root) and the same-origin
 * refusal of an attacker-controlled `resource_metadata` pointer are
 * requirements of RFC 9728, not of Anthropic's policy, so a Claude-only copy
 * would be a second place for them to drift.
 */
async function discoverProtectedResourceMetadata(
  options: ClaudeDiscoveryOptions,
  challengePointer: string | undefined,
): Promise<ClaudeAuthEvidence["prm"]> {
  return discoverPrm(options, challengePointer);
}

/**
 * Metadata for `authorization_servers[0]` and nothing else.
 *
 * Probing every entry would grade a client that falls back. Claude does not,
 * so a runner that looked past entry zero would report a connector as healthy
 * that Claude cannot use.
 */
async function fetchFirstAuthorizationServer(
  options: ClaudeDiscoveryOptions,
  issuer: string | undefined,
): Promise<ClaudeAuthEvidence["firstAuthorizationServer"]> {
  if (!issuer) return undefined;

  let base: URL;
  try {
    base = new URL(issuer);
  } catch {
    return {
      issuer,
      reachable: false,
      fetchError: "issuer is not a valid URL",
    };
  }

  const path = base.pathname.replace(/\/$/, "");
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${path}`,
    `${base.origin}/.well-known/openid-configuration${path}`,
    `${base.origin}${path}/.well-known/openid-configuration`,
  ];

  let lastError: string | undefined;
  for (const url of candidates) {
    const result = await fetchDiscoveryJson(url, options);
    if (result.status >= 200 && result.status < 300 && result.document) {
      return {
        issuer,
        metadataUrl: url,
        reachable: true,
        document: result.document,
      };
    }
    lastError = result.error ?? `${url} answered ${result.status}`;
  }
  return { issuer, reachable: false, fetchError: lastError };
}

/**
 * Gather everything the non-invasive auth checks need, in one pass.
 *
 * Ordering is causal rather than parallel: the challenge names the metadata
 * document, and the metadata document names the authorization server. Firing
 * these concurrently would mean guessing the well-known paths even when the
 * server told us where to look.
 */
export async function discoverClaudeAuthEvidence(
  options: ClaudeDiscoveryOptions,
  // `resourceIndicatorsSent` rides in as an EXTRA rather than being discovered:
  // discovery never drives an authorization, so the only party that can have
  // seen those requests is the caller that made them.
  extras: Pick<
    ClaudeAuthEvidence,
    | "declaredAuthMode"
    | "accessTokenAudience"
    | "resourceIndicatorsSent"
    | "insufficientScopeChallenge"
  > = {},
): Promise<ClaudeAuthEvidence> {
  const unauthenticated = await probeUnauthenticated(options);
  const challengePointer = parseBearerAuthenticateParameters(
    unauthenticated?.wwwAuthenticate,
  ).resource_metadata;

  const prm = await discoverProtectedResourceMetadata(
    options,
    challengePointer,
  );
  const authorizationServers = Array.isArray(
    prm?.document?.authorization_servers,
  )
    ? (prm.document.authorization_servers as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const firstAuthorizationServer = await fetchFirstAuthorizationServer(
    options,
    authorizationServers[0],
  );

  return {
    enteredUrl: options.enteredUrl,
    unauthenticated,
    prm,
    firstAuthorizationServer,
    ...extras,
  };
}
