/**
 * The publisher-neutral half of readiness discovery.
 *
 * WHAT LIVES HERE. Everything about GETTING evidence off the wire that does not
 * depend on whose directory is being graded: reading a response without letting
 * it run away, understanding an SSE reply to a JSON-RPC POST, walking a redirect
 * chain hop by hop, and finding a Protected Resource Metadata document. None of
 * it knows a single requirement of any directory.
 *
 * WHY IT IS SHARED. Each of these has a failure mode that is invisible until it
 * bites, and every one was found once already:
 *
 *   - a body cap applied AFTER `response.text()` limits what is parsed, not
 *     what is read, so a hostile endpoint exhausts memory before the guard runs;
 *   - an SSE reply to a JSON-RPC POST is CONFORMING, and reading it as JSON both
 *     fails to parse and blocks until the timeout, reporting a healthy server as
 *     unreachable;
 *   - a transport that follows redirects itself reports only where it landed, so
 *     a chain that downgrades in the middle and recovers is invisible;
 *   - a `resource_metadata` pointer is ATTACKER-CONTROLLED and `new URL()` will
 *     happily accept `http://169.254.169.254/…`.
 *
 * A second copy of this would eventually get one of them wrong, and the wrong
 * version would look fine.
 *
 * `fetchFn` IS REQUIRED, with no default, in every entry point here. In a hosted
 * run it must be the DNS-pinned transport, and a default would make the
 * unguarded case the easy one to reach.
 *
 * Node/browser agnostic: `fetch`, `AbortController`, `TextDecoder` only.
 */

export interface DirectoryDiscoveryOptions {
  /** The target URL exactly as the user entered it. Never canonicalized. */
  enteredUrl: string;
  /**
   * The transport. REQUIRED — see the module docblock.
   */
  fetchFn: typeof fetch;
  /** Per-request budget. The caller owns the run-level deadline. */
  timeoutMs?: number;
  /** Redirect hops to walk while tracing the endpoint. */
  maxRedirects?: number;
  /** Headers the target needs, e.g. a static credential under test. */
  headers?: Record<string, string>;
  /**
   * The caller's cancellation, composed with each request's own timeout.
   *
   * WITHOUT THIS, cancelling a run stops the NEXT request and not the one in
   * flight — and a readiness run's requests are seconds long against somebody
   * else's server, which is precisely the traffic a cancellation is meant to
   * stop. A hosted run learns its lease is gone on a heartbeat and has to be
   * able to abort what it is already doing, not merely decline to start
   * another.
   */
  signal?: AbortSignal;
}

export const DIRECTORY_DISCOVERY_DEFAULTS = {
  timeoutMs: 15_000,
  maxRedirects: 5,
  /** Body cap for documents we only ever parse as small JSON. */
  maxMetadataBytes: 512 * 1024,
} as const;

/**
 * Read a response body, stopping at the cap.
 *
 * Returns `undefined` rather than a truncated string: a half-read JSON document
 * is not a smaller document, it is a parse error dressed as data. Counts BYTES,
 * because `String.length` counts UTF-16 code units and a document of multi-byte
 * characters would sail past a cap named in bytes.
 *
 * Falls back to `text()` when the body is not a stream (a mocked `fetchFn`
 * frequently returns a plain `Response`), and re-measures there.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number = DIRECTORY_DISCOVERY_DEFAULTS.maxMetadataBytes,
): Promise<string | undefined> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return new TextEncoder().encode(text).length > maxBytes ? undefined : text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) return undefined;
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
  }
}

/**
 * The JSON-RPC message carried by one SSE event, if it carries one.
 *
 * `data:` may be repeated within an event, and the payload is the lines joined
 * with newlines — which is exactly how a pretty-printed JSON body arrives.
 */
export function parseSseEventData(
  event: string,
): Record<string, unknown> | undefined {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
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
 * report a healthy server as unreachable. The byte cap still applies, so a
 * stream that never produces a parseable event cannot run away either.
 */
export async function readSseJsonRpc(
  response: Response,
  maxBytes: number = DIRECTORY_DISCOVERY_DEFAULTS.maxMetadataBytes,
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
      if (received > maxBytes) return undefined;
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

/**
 * Abort a per-request controller when the caller's signal fires.
 *
 * `AbortSignal.any` would be shorter and is deliberately not used: this module
 * runs in the browser too, and the helper predates that API's availability in
 * every runtime this ships to. The returned detach is not optional — a
 * long-lived caller signal accumulates one listener per request without it,
 * and a readiness run makes dozens.
 */
function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export interface FetchedDiscoveryJson {
  status: number;
  headers: Headers;
  document?: Record<string, unknown>;
  error?: string;
}

export async function fetchDiscoveryJson(
  url: string,
  options: DirectoryDiscoveryOptions,
  init?: RequestInit,
): Promise<FetchedDiscoveryJson> {
  const maxBytes = DIRECTORY_DISCOVERY_DEFAULTS.maxMetadataBytes;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("readiness discovery timed out")),
    options.timeoutMs ?? DIRECTORY_DISCOVERY_DEFAULTS.timeoutMs,
  );
  const detachCaller = linkAbortSignal(options.signal, controller);
  try {
    const response = await options.fetchFn(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...options.headers,
        ...init?.headers,
      },
      signal: controller.signal,
    });
    // REFUSE BEFORE READING when the server tells us the size. `await
    // response.text()` materializes the whole body first, so a cap applied
    // afterwards limits what is PARSED and not what is read — a hostile or
    // misconfigured endpoint could exhaust memory before the guard ran. In a
    // hosted run the pinned transport enforces its own decompressed-byte
    // ceiling, but this function accepts any `fetchFn`, so the guarantee has to
    // hold here too.
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return {
        status: response.status,
        headers: response.headers,
        error: `metadata document declared ${declaredLength} bytes, over the ${maxBytes}-byte cap`,
      };
    }
    // AN SSE ANSWER IS A CONFORMING ANSWER. MCP's Streamable HTTP transport lets
    // a server reply to a POST with either `application/json` or
    // `text/event-stream`, and an unauthenticated probe advertises both — so
    // reading an SSE reply as JSON would fail twice: the frames do not parse,
    // making a working server look like one that never answered, and the stream
    // is allowed to stay open, so the read would block until the probe's own
    // timeout fired rather than returning what already arrived.
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (contentType.includes("text/event-stream")) {
      return {
        status: response.status,
        headers: response.headers,
        document: await readSseJsonRpc(response, maxBytes),
      };
    }
    const text = await readBoundedText(response, maxBytes);
    if (text === undefined) {
      return {
        status: response.status,
        headers: response.headers,
        error: `metadata document exceeded ${maxBytes} bytes`,
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
    detachCaller();
  }
}

export interface DirectoryRedirectHop {
  url: string;
  status: number;
  location?: string;
}

export interface DirectoryRedirectTrace {
  enteredUrl: string;
  redirectChain: DirectoryRedirectHop[];
  redirectLimitHit?: boolean;
}

/**
 * Walk the target URL's redirect chain by hand.
 *
 * The transport follows redirects internally and reports only where it landed;
 * the endpoint checks need each HOP, because a chain that downgrades in the
 * middle and recovers is invisible from the destination alone.
 */
export async function traceRedirects(
  options: DirectoryDiscoveryOptions,
): Promise<DirectoryRedirectTrace> {
  const maxRedirects =
    options.maxRedirects ?? DIRECTORY_DISCOVERY_DEFAULTS.maxRedirects;
  const chain: DirectoryRedirectHop[] = [];
  let current = options.enteredUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("readiness redirect trace timed out")),
      options.timeoutMs ?? DIRECTORY_DISCOVERY_DEFAULTS.timeoutMs,
    );
    const detachCaller = linkAbortSignal(options.signal, controller);
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
      detachCaller();
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
 * Resolve a `resource_metadata` pointer, or refuse it.
 *
 * THE POINTER IS ATTACKER-CONTROLLED. It arrives in a `WWW-Authenticate` header
 * from the server under test, and `new URL()` will happily accept
 * `http://169.254.169.254/…` or a `file:` URL. In a hosted run the pinned
 * transport would refuse it, but these functions accept any `fetchFn`, so the
 * pointer is validated here rather than trusted to the caller's transport.
 *
 * Same origin is not an arbitrary narrowing: RFC 9728 constructs the metadata
 * URL from the resource identifier itself, and requires the document's
 * `resource` to equal the request URL. A pointer to another origin cannot
 * satisfy that, so following it could only ever produce a document we would
 * then reject.
 *
 * Returns `undefined` for a refusal so the caller can REPORT it rather than
 * silently continuing to the well-known paths as if no pointer existed.
 */
export function resolveSameOriginPointer(
  pointer: string,
  enteredUrl: string,
): string | undefined {
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

export type PrmDiscoveryStep =
  | "www-authenticate"
  | "well-known-path-suffixed"
  | "well-known-root"
  | "not-found";

export interface PrmDiscoveryResult {
  discoveredVia: PrmDiscoveryStep;
  url?: string;
  document?: Record<string, unknown>;
  fetchError?: string;
  /**
   * A `resource_metadata` pointer discovery refused to dial — off-origin, or
   * not http(s). Recorded rather than dropped: the server published a pointer
   * no conforming client can follow, and silence would look like the server
   * never published one.
   */
  rejectedPointer?: string;
}

/**
 * Find the Protected Resource Metadata document, trying the challenge pointer,
 * then the path-suffixed well-known URL, then the root one.
 *
 * The order is the requirement, not an optimisation: a server that publishes
 * PRM only at the ROOT well-known path, while serving the endpoint at a
 * sub-path, is discoverable by a client that tries the root and invisible to
 * one that stops at the path-suffixed form. Recording WHICH step answered is
 * what lets the report tell a submitter their metadata is reachable only by
 * luck.
 */
export async function discoverProtectedResourceMetadata(
  options: DirectoryDiscoveryOptions,
  challengePointer: string | undefined,
): Promise<PrmDiscoveryResult> {
  const attempts: Array<{ step: PrmDiscoveryStep; url: string }> = [];
  let rejectedPointer: string | undefined;
  if (challengePointer) {
    const resolved = resolveSameOriginPointer(
      challengePointer,
      options.enteredUrl,
    );
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
      fetchError: "target URL is not parseable",
      rejectedPointer,
    };
  }

  // The refusal is a SEPARATE fact from whatever the fallback attempts report,
  // and it must not be overwritten by them: a server that published an
  // off-origin pointer AND has no well-known document has two problems, and a
  // report that mentions only the second sends the submitter to the wrong one.
  const rejectionNote = rejectedPointer
    ? `the challenge's resource_metadata pointer was refused (it must be an http(s) URL on the target's own origin)`
    : undefined;
  let lastError: string | undefined;
  for (const attempt of attempts) {
    const result = await fetchDiscoveryJson(attempt.url, options);
    if (result.status >= 200 && result.status < 300 && result.document) {
      // `rejectedPointer` rides along on SUCCESS too: the fallback worked, and
      // the server still published a pointer no conforming client can follow.
      return {
        discoveredVia: attempt.step,
        url: attempt.url,
        document: result.document,
        rejectedPointer,
      };
    }
    lastError = result.error ?? `${attempt.url} answered ${result.status}`;
  }
  return {
    discoveredVia: "not-found",
    fetchError:
      [rejectionNote, lastError].filter(Boolean).join("; ") || undefined,
    rejectedPointer,
  };
}
