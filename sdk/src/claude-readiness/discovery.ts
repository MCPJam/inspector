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

/**
 * Read a response body, stopping at the cap.
 *
 * Returns `undefined` rather than a truncated string: a half-read JSON
 * document is not a smaller document, it is a parse error dressed as data.
 * Counts BYTES, because `String.length` counts UTF-16 code units and a
 * document of multi-byte characters would sail past a cap named in bytes.
 *
 * Falls back to `text()` when the body is not a stream (a mocked `fetchFn`
 * frequently returns a plain `Response`), and re-measures there.
 */
async function readBounded(response: Response): Promise<string | undefined> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return new TextEncoder().encode(text).length > MAX_METADATA_BYTES
      ? undefined
      : text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_METADATA_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

interface FetchedJson {
  status: number;
  headers: Headers;
  document?: Record<string, unknown>;
  error?: string;
}

/**
 * The JSON-RPC message carried by one SSE event, if it carries one.
 *
 * `data:` may be repeated within an event, and the payload is the lines joined
 * with newlines — which is exactly how a pretty-printed JSON body arrives.
 */
function parseSseEventData(event: string): Record<string, unknown> | undefined {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read an SSE response only as far as its first JSON-RPC message, then stop.
 *
 * Stopping is the point: the server is entitled to hold the stream open after
 * answering, so reading to `done` would hang until the probe's timeout and
 * report a healthy connector as unreachable. The byte cap still applies, so a
 * stream that never produces a parseable event cannot run away either.
 */
async function readSseJsonRpc(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") return undefined;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_METADATA_BYTES) return undefined;
      buffered += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; CRLF is as legal as LF.
      const events = buffered.split(/\r?\n\r?\n/);
      // The trailing segment is whatever has not been terminated yet.
      buffered = events.pop() ?? "";
      for (const event of events) {
        const document = parseSseEventData(event);
        if (document) return document;
      }
    }
    // A stream that closed without a final blank line still left one event.
    return parseSseEventData(buffered);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
  }
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
    // REFUSE BEFORE READING when the server tells us the size. `await
    // response.text()` materializes the whole body first, so a cap applied
    // afterwards limits what is PARSED and not what is read — a hostile or
    // misconfigured endpoint could exhaust memory before the guard ran. In a
    // hosted run the pinned transport enforces its own decompressed-byte
    // ceiling, but this function accepts any `fetchFn`, so the guarantee has
    // to hold here too.
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) {
      return {
        status: response.status,
        headers: response.headers,
        error: `metadata document declared ${declaredLength} bytes, over the ${MAX_METADATA_BYTES}-byte cap`,
      };
    }
    // AN SSE ANSWER IS A CONFORMING ANSWER. MCP's Streamable HTTP transport
    // lets a server reply to a POST with either `application/json` or
    // `text/event-stream`, and the unauthenticated probe advertises both — so
    // reading an SSE reply as JSON would fail twice: the frames do not parse,
    // making a working connector look like one that never answered, and the
    // stream is allowed to stay open, so the read would block until the
    // probe's own timeout fired rather than returning what already arrived.
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      return {
        status: response.status,
        headers: response.headers,
        document: await readSseJsonRpc(response),
      };
    }
    const text = await readBounded(response);
    if (text === undefined) {
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
  let rejectedPointer: string | undefined;
  if (challengePointer) {
    // THE POINTER IS ATTACKER-CONTROLLED. It arrives in a `WWW-Authenticate`
    // header from the server under test, and `new URL()` will happily accept
    // `http://169.254.169.254/…` or a `file:` URL. In a hosted run the pinned
    // transport would refuse it, but this module accepts any `fetchFn`, so the
    // pointer is validated here rather than trusted to the caller's transport.
    //
    // Same origin is not an arbitrary narrowing: RFC 9728 constructs the
    // metadata URL from the resource identifier itself, and requires the
    // document's `resource` to equal the request URL. A pointer to another
    // origin cannot satisfy that, so following it could only ever produce a
    // document we would then reject.
    const resolved = resolvePointer(challengePointer, options.enteredUrl);
    if (resolved) {
      attempts.push({ step: "www-authenticate", url: resolved });
    } else {
      rejectedPointer = challengePointer;
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
    return {
      discoveredVia: "not-found",
      fetchError: "connector URL is not parseable",
      rejectedPointer,
      reachedServer: false,
    };
  }

  // The refusal is a SEPARATE fact from whatever the fallback attempts
  // report, and it must not be overwritten by them: a server that published an
  // off-origin pointer AND has no well-known document has two problems, and a
  // report that mentions only the second sends the submitter to the wrong one.
  const rejectionNote = rejectedPointer
    ? `the challenge's resource_metadata pointer was refused (it must be an http(s) URL on the connector's own origin)`
    : undefined;
  let lastError: string | undefined;
  // Whether anything on that host answered AT ALL. A 404 counts: it is the
  // server saying "no document here", which is a finding. A transport failure
  // does not, and the difference is what keeps an unreachable host from being
  // graded as a connector that publishes no metadata.
  let reachedServer = false;
  for (const attempt of attempts) {
    const result = await fetchJson(attempt.url, options);
    if (result.status !== 0) reachedServer = true;
    if (result.status >= 200 && result.status < 300 && result.document) {
      // `rejectedPointer` rides along on SUCCESS too: the fallback worked, and
      // the server still published a pointer no conforming client can follow.
      return {
        discoveredVia: attempt.step,
        url: attempt.url,
        document: result.document,
        rejectedPointer,
        reachedServer: true,
      };
    }
    lastError = result.error ?? `${attempt.url} answered ${result.status}`;
  }
  return {
    discoveredVia: "not-found",
    fetchError: [rejectionNote, lastError].filter(Boolean).join("; ") || undefined,
    rejectedPointer,
    reachedServer,
  };
}

/**
 * Resolve a `resource_metadata` pointer, or refuse it.
 *
 * Refuses anything that is not http(s), and anything off the connector's own
 * origin. Returns `undefined` for a refusal so the caller can report it rather
 * than silently continuing to the well-known paths as if no pointer existed.
 */
function resolvePointer(pointer: string, enteredUrl: string): string | undefined {
  let resolved: URL;
  let base: URL;
  try {
    base = new URL(enteredUrl);
    resolved = new URL(pointer, enteredUrl);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
    return undefined;
  }
  if (resolved.origin !== base.origin) return undefined;
  return resolved.toString();
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
