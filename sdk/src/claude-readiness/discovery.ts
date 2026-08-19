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
import type {
  ClaudeAuthEvidence,
  ClaudePrmDiscoveryStep,
} from "./checks/auth.js";
import type {
  ClaudeEndpointEvidence,
  ClaudeRedirectHop,
} from "./checks/endpoint.js";

export interface ClaudeDiscoveryOptions {
  /** The connector URL exactly as the user entered it. Never canonicalized. */
  enteredUrl: string;
  /**
   * The transport. REQUIRED — in a hosted run this must be the DNS-pinned one,
   * and a default would make the unguarded case the easy one to reach.
   */
  fetchFn: typeof fetch;
  /** Per-request budget. The caller owns the run-level deadline. */
  timeoutMs?: number;
  /** Redirect hops to walk while tracing the endpoint. */
  maxRedirects?: number;
  /** Headers the connector needs, e.g. a static credential under test. */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

/** Body caps for documents we only ever parse as small JSON. */
const MAX_METADATA_BYTES = 512 * 1024;

interface FetchedJson {
  status: number;
  headers: Headers;
  document?: Record<string, unknown>;
  error?: string;
}

async function fetchJson(
  url: string,
  options: ClaudeDiscoveryOptions,
  init?: RequestInit,
): Promise<FetchedJson> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("readiness discovery timed out")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await options.fetchFn(url, {
      ...init,
      headers: { accept: "application/json", ...options.headers, ...init?.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) {
      return {
        status: response.status,
        headers: response.headers,
        error: `metadata document exceeded ${MAX_METADATA_BYTES} bytes`,
      };
    }
    let document: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = text ? JSON.parse(text) : undefined;
      document =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
    } catch {
      document = undefined;
    }
    return { status: response.status, headers: response.headers, document };
  } catch (error) {
    return {
      status: 0,
      headers: new Headers(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the connector URL's redirect chain by hand.
 *
 * The transport follows redirects internally and reports only where it landed;
 * the endpoint checks need each HOP, because a chain that downgrades in the
 * middle and recovers is invisible from the destination alone.
 */
export async function traceConnectorRedirects(
  options: ClaudeDiscoveryOptions,
): Promise<ClaudeEndpointEvidence> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const chain: ClaudeRedirectHop[] = [];
  let current = options.enteredUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("readiness redirect trace timed out")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await options.fetchFn(current, {
        method: "HEAD",
        redirect: "manual",
        headers: options.headers,
        signal: controller.signal,
      });
    } catch {
      // A refused or unreachable hop ends the trace. It is not itself a
      // redirect finding — the connectivity failure surfaces elsewhere — and
      // reporting a partial chain is better than reporting none.
      return { enteredUrl: options.enteredUrl, redirectChain: chain };
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get("location") ?? undefined;
    chain.push({ url: current, status: response.status, location });
    if (!location || response.status < 300 || response.status >= 400) {
      return { enteredUrl: options.enteredUrl, redirectChain: chain };
    }
    try {
      current = new URL(location, current).toString();
    } catch {
      return { enteredUrl: options.enteredUrl, redirectChain: chain };
    }
  }

  return {
    enteredUrl: options.enteredUrl,
    redirectChain: chain,
    redirectLimitHit: true,
  };
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
  const result = await fetchJson(options.enteredUrl, options, {
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
    (result.document?.result !== undefined || result.document?.error !== undefined);

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
 * RFC 9728 discovery, in the order a client is required to try.
 *
 * The order is the requirement, not an optimisation: a server that publishes
 * PRM only at the ROOT well-known path, while serving the connector at a
 * sub-path, is discoverable by a client that tries the root and invisible to
 * one that stops at the path-suffixed form. Recording WHICH step answered is
 * what lets the report tell a submitter their metadata is reachable only by
 * luck.
 */
async function discoverProtectedResourceMetadata(
  options: ClaudeDiscoveryOptions,
  challengePointer: string | undefined,
): Promise<ClaudeAuthEvidence["prm"]> {
  const attempts: Array<{ step: ClaudePrmDiscoveryStep; url: string }> = [];
  if (challengePointer) {
    try {
      attempts.push({
        step: "www-authenticate",
        url: new URL(challengePointer, options.enteredUrl).toString(),
      });
    } catch {
      // A malformed pointer is itself a finding, raised by the challenge
      // check; here it simply does not produce an attempt.
    }
  }
  try {
    const base = new URL(options.enteredUrl);
    const path = base.pathname.replace(/\/$/, "");
    attempts.push({
      step: "well-known-path-suffixed",
      url: `${base.origin}/.well-known/oauth-protected-resource${path}`,
    });
    attempts.push({
      step: "well-known-root",
      url: `${base.origin}/.well-known/oauth-protected-resource`,
    });
  } catch {
    return { discoveredVia: "not-found", fetchError: "connector URL is not parseable" };
  }

  let lastError: string | undefined;
  for (const attempt of attempts) {
    const result = await fetchJson(attempt.url, options);
    if (result.status >= 200 && result.status < 300 && result.document) {
      return {
        discoveredVia: attempt.step,
        url: attempt.url,
        document: result.document,
      };
    }
    lastError = result.error ?? `${attempt.url} answered ${result.status}`;
  }
  return { discoveredVia: "not-found", fetchError: lastError };
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
    return { issuer, reachable: false, fetchError: "issuer is not a valid URL" };
  }

  const path = base.pathname.replace(/\/$/, "");
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${path}`,
    `${base.origin}/.well-known/openid-configuration${path}`,
    `${base.origin}${path}/.well-known/openid-configuration`,
  ];

  let lastError: string | undefined;
  for (const url of candidates) {
    const result = await fetchJson(url, options);
    if (result.status >= 200 && result.status < 300 && result.document) {
      return { issuer, metadataUrl: url, reachable: true, document: result.document };
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
  extras: Pick<ClaudeAuthEvidence, "declaredAuthMode" | "accessTokenAudience"> = {},
): Promise<ClaudeAuthEvidence> {
  const unauthenticated = await probeUnauthenticated(options);
  const challengePointer = parseBearerAuthenticateParameters(
    unauthenticated?.wwwAuthenticate,
  ).resource_metadata;

  const prm = await discoverProtectedResourceMetadata(options, challengePointer);
  const authorizationServers = Array.isArray(prm?.document?.authorization_servers)
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
