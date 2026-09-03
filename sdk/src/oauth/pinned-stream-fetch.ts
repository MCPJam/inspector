/**
 * A DNS-pinned `fetch` that can STREAM — the transport the real MCP connection
 * rides on.
 *
 * WHY A SECOND ONE. `executeOAuthProxy` already resolves once, refuses private
 * answers, and pins the address into the socket, and the inspector's
 * `createPinnedFetch` wraps it in a `fetch` shape. But that path BUFFERS: it
 * reads the whole body into memory before answering, so it can never carry
 * `text/event-stream`. That is why the guarded fetch threaded into the
 * conformance suites reached only the raw probes, and why the one real MCP
 * connection each suite opens still followed redirects unchecked — the gap the
 * suite's own comment documented and could not close.
 *
 * This module closes it. Same two-step guarantee as the buffering path, taken
 * from the same {@link resolvePinnedAddresses}/{@link createPinnedLookup}
 * implementation, but the response body is handed back as a live
 * `ReadableStream`, so an SSE stream stays open and an MCP client cannot tell
 * it is not talking to `globalThis.fetch`.
 *
 * WHAT IT ENFORCES, all of it per hop:
 *
 *  - **Scheme.** https, unless the CHAIN started at loopback and this hop is
 *    loopback too. A public target may not steer a hop at the user's own
 *    machine.
 *  - **Address.** Resolve once, classify under RFC 6890, pin. Every redirect
 *    hop repeats this in full — a `302` to `169.254.169.254` is refused at the
 *    hop that names it, not after it has been dialled.
 *  - **Redirect ceiling.** Bounded; the chain fails rather than looping.
 *  - **Credentials.** Dropped when the origin changes, exactly as Fetch does,
 *    so a redirect off-origin cannot carry an access token with it.
 *  - **Time.** A chain deadline covers DNS, connect and headers across every
 *    hop. It deliberately does NOT cover an established body stream — an SSE
 *    stream is long-lived by design — which is what {@link
 *    PinnedStreamingFetchOptions.bodyIdleTimeoutMs} is for: a stalled stream
 *    dies, a healthy one does not.
 *  - **Size.** A cumulative cap on body bytes AFTER decompression, so a
 *    compressed bomb is measured at its real size.
 *
 * Node-only. Do not import from browser or worker entry points.
 */

import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { OAuthProxyError } from "../oauth-proxy-error.js";
import { isLoopbackOAuthUrl, isPrivateHost } from "./ssrf-guard.js";
import {
  createPinnedLookup,
  resolveEgressPolicy,
  resolvePinnedAddresses,
} from "./pinned-dns.js";
import type { EgressPolicy } from "./pinned-dns.js";

export interface PinnedStreamingFetchOptions {
  /**
   * Local-dev opt-in for a loopback TARGET. It never relaxes anything else,
   * and it belongs to the chain: a chain that started public can never arrive
   * at loopback, however many redirects it takes to try.
   */
  allowLoopback?: boolean;
  /**
   * Permit private destinations for the whole chain: loopback, RFC 1918,
   * CGNAT, unique-local, and any hostname resolving to one. This is what the
   * LOCAL inspector sets, where reaching a developer's own network is the
   * product. It supersedes {@link allowLoopback} (loopback is a subset), and
   * it never permits a link-local or cloud-metadata destination.
   *
   * Like the loopback opt-in it is a property of the CHAIN: the allowance is
   * decided by where the chain started, so a public target cannot redirect its
   * way onto the caller's LAN.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Budget for DNS + connect + response headers, summed across every hop of
   * the redirect chain. An established body stream is outside it — see the
   * module docblock. Default 30s.
   */
  chainTimeoutMs?: number;
  /**
   * Kill a body stream that has produced no bytes for this long. This is the
   * bound that applies to a long-lived SSE stream; a total deadline would
   * close healthy ones. Default 0 (no idle bound).
   */
  bodyIdleTimeoutMs?: number;
  /**
   * Cumulative cap on decompressed body bytes for one fetch. Exceeding it
   * destroys the socket and errors the stream. Default 32 MiB; 0 disables.
   */
  maxResponseBytes?: number;
  /** Redirect hops allowed before the chain is refused. Default 5. */
  maxRedirects?: number;
  /** Used in refusal messages, e.g. `"MCP server"`. */
  targetLabel?: string;
}

const DEFAULT_CHAIN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * Matches `fetch` itself, and therefore `createGuardedFetch`'s
 * `MAX_GUARDED_REDIRECTS`, which is what hosted conformance dialled through
 * before this transport existed. A lower ceiling here would not have been a
 * security improvement — every hop is validated either way — it would only
 * have failed chains that legitimately worked, and enterprise OAuth chains
 * (apex → www → CDN → tenant routing) do reach six and seven hops.
 */
const DEFAULT_MAX_REDIRECTS = 20;

/** Credentials, in the sense Fetch means: dropped when the origin changes. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
];

/** Statuses whose `Response` must be constructed with a null body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function stripCredentials(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !CREDENTIAL_HEADERS.includes(name.toLowerCase()),
    ),
  );
}

/**
 * Fetch's "request-body-header name" list, which is what a method rewrite has
 * to drop along with the body.
 *
 * All five, not the obvious three: `content-language` and `content-location`
 * describe a body that no longer exists once 301/302/303 rewrote the request
 * to GET, and leaving them on sends a GET that still claims to carry one.
 * `oauth-proxy.ts`'s `updateRequestForRedirect` strips the same five — the two
 * transports must not disagree about what a redirect does to a request.
 */
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
];

function stripBodyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !BODY_HEADERS.includes(name.toLowerCase()),
    ),
  );
}

/** The host alone — never the path or query, which can carry a token. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an unparseable URL";
  }
}

function headersToRecord(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Record<string, string> {
  const record: Record<string, string> = {};
  const raw = init?.headers ?? (input as Request)?.headers;
  if (raw) {
    new Headers(raw as HeadersInit).forEach((value, key) => {
      record[key] = value;
    });
  }
  return record;
}

/**
 * The request body, as bytes.
 *
 * MCP posts JSON strings, so string and byte forms are all that is supported.
 * A streaming request body would need a duplex socket write and is refused
 * loudly rather than silently sent empty.
 */
function encodeBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  throw new OAuthProxyError(
    400,
    "The pinned streaming transport supports only string or byte request bodies.",
  );
}

function normalizeResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // `set-cookie` is the only header Node hands back as an array, and
      // `Headers.append` is what preserves each one as its own field.
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

/**
 * Undo the transfer encoding the server applied, so the byte cap below counts
 * what the caller will actually receive rather than its compressed shadow.
 */
function decodeStream(response: IncomingMessage): NodeJS.ReadableStream {
  const encoding = (response.headers["content-encoding"] ?? "")
    .toString()
    .trim()
    .toLowerCase();
  const decompressor =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
  if (!decompressor) return response;

  // `pipe` DOES NOT FORWARD ERRORS. Node's own documentation says so, and the
  // consequence here is specific and bad: `toGuardedWebStream` listens to the
  // decompressor alone, so a socket failure or a caller abort after the
  // headers were in would error the source, reach nothing, and leave
  // `Response.body` pending forever — a hang rather than a rejection.
  //
  // Destroying the decompressor WITH the reason is what turns that into an
  // error event the guarded stream can surface.
  const fail = (error: Error) => decompressor.destroy(error);
  response.on("error", fail);
  response.on("aborted", () =>
    fail(new OAuthProxyError(499, "The connection was aborted.")),
  );
  return response.pipe(decompressor);
}

interface HopResult {
  response: IncomingMessage;
  url: string;
}

/**
 * One hop: validate the scheme, resolve-and-pin the address, and open the
 * socket. Resolves as soon as the response HEADERS are in — the body is left
 * streaming, which is the whole point of this module.
 */
async function openPinnedHop(
  targetUrl: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  policy: EgressPolicy,
  signal: AbortSignal,
  targetLabel: string,
): Promise<HopResult> {
  const pinnedAddresses = await resolvePinnedAddresses(
    targetUrl,
    policy,
    signal,
    targetLabel,
  );
  const transport = targetUrl.protocol === "https:" ? https : http;

  return await new Promise<HopResult>((resolve, reject) => {
    const request = transport.request(
      targetUrl,
      {
        method,
        headers,
        ...(pinnedAddresses
          ? { lookup: createPinnedLookup(pinnedAddresses) }
          : {}),
        // SNI must still name the host, not the pinned literal, or TLS fails
        // against every virtual host on a shared address.
        ...(targetUrl.protocol === "https:" &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(targetUrl.hostname) &&
        !targetUrl.hostname.includes(":")
          ? { servername: targetUrl.hostname }
          : {}),
        signal,
      },
      (response) => resolve({ response, url: targetUrl.toString() }),
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

/**
 * Wrap the decoded body in a `ReadableStream`, enforcing the byte cap and the
 * idle bound as the bytes flow.
 *
 * `destroyUpstream` exists because the cap has to kill the SOCKET, not just
 * the reader: leaving the connection draining a hostile response defeats the
 * point of capping it.
 */
function toGuardedWebStream(
  source: NodeJS.ReadableStream,
  destroyUpstream: () => void,
  maxResponseBytes: number,
  bodyIdleTimeoutMs: number,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  let received = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let settled = false;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  /**
   * The body stream outlives the function that returned the `Response`, and it
   * is the last thing holding the caller's abort listener. Releasing it here —
   * once, on whichever of end/error/cancel arrives first — is what stops a
   * transport-lifetime signal accumulating one listener per request.
   */
  const settle = () => {
    if (settled) return;
    settled = true;
    clearIdle();
    onSettled();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const armIdle = () => {
        if (bodyIdleTimeoutMs <= 0) return;
        clearIdle();
        idleTimer = setTimeout(() => {
          destroyUpstream();
          settle();
          controller.error(
            new OAuthProxyError(
              504,
              `The response stream produced no data for ${bodyIdleTimeoutMs}ms.`,
            ),
          );
        }, bodyIdleTimeoutMs);
        // A pending idle timer must never be the reason the process stays
        // alive; the stream's own lifetime decides that.
        idleTimer.unref?.();
      };

      source.on("data", (chunk: Buffer | string) => {
        // Destroying a socket is asynchronous, so a chunk already in flight
        // can arrive after the stream settled — after a reader cancelled, or
        // after the cap errored it. Enqueuing onto a closed controller throws
        // `ERR_INVALID_STATE` out of an event handler, where nothing can catch
        // it, so the verdict that already stands wins and the chunk is dropped.
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.byteLength;
        if (maxResponseBytes > 0 && received > maxResponseBytes) {
          destroyUpstream();
          settle();
          controller.error(
            new OAuthProxyError(
              400,
              `The response exceeds the ${maxResponseBytes}-byte cap.`,
            ),
          );
          return;
        }
        controller.enqueue(new Uint8Array(buffer));
        // BACKPRESSURE. `source.on("data")` puts the socket in flowing mode,
        // so without this the bridge enqueues as fast as the network delivers
        // and the queue — not the consumer — decides how much is held. A
        // reader that is slow, or that checks `status` and never reads the
        // body at all, would buffer the entire response in memory: up to the
        // byte cap, and without limit when the cap is disabled. Pausing when
        // the reader has no capacity and resuming from `pull` hands that
        // decision back to the consumer, which is what makes the cap a
        // ceiling rather than a target.
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
        armIdle();
      });
      source.on("end", () => {
        settle();
        try {
          controller.close();
        } catch {
          // Already errored by the cap or the idle bound; nothing to close.
        }
      });
      source.on("error", (error: Error) => {
        // The SOCKET first. A decoder failure — a truncated gzip member, a
        // corrupt brotli frame — errors the decompressor but leaves the
        // response, and therefore the pinned connection, open. Erroring only
        // the reader would leak it for the lifetime of the process.
        destroyUpstream();
        // `settle` clears the idle timer and releases the caller's abort
        // listener; both have to happen on this path too.
        settle();
        try {
          controller.error(error);
        } catch {
          // Already errored; the first verdict is the one that stands.
        }
      });
      armIdle();
    },
    pull() {
      // The reader drained the queue and wants more.
      source.resume();
    },
    cancel() {
      settle();
      destroyUpstream();
    },
  });
}

/**
 * Build a streaming, DNS-pinned `fetch`.
 *
 * The result is drop-in for the subset of `fetch` an MCP transport uses: a URL,
 * a method, headers, a byte/string body, an `AbortSignal`, and a streaming
 * response. It does not implement `credentials`, `cache`, or a streaming
 * request body, and a caller who needs those should not be using it.
 */
export function createPinnedStreamingFetch(
  options: PinnedStreamingFetchOptions = {},
): typeof fetch {
  const chainTimeoutMs = options.chainTimeoutMs ?? DEFAULT_CHAIN_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? 0;
  const targetLabel = options.targetLabel ?? "Target";

  const pinnedStreamingFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const startUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const callerSignal =
      init?.signal ?? (input as Request)?.signal ?? undefined;
    callerSignal?.throwIfAborted();

    // A `Request` body is a one-shot stream, and a redirect chain may have to
    // replay it. Copying every other field and leaving the body behind would
    // send an empty POST and report whatever the server made of THAT as the
    // target's behavior — a wrong answer dressed as a real one.
    const fromRequest =
      typeof input !== "string" && !(input instanceof URL)
        ? (input as Request)
        : undefined;
    if (fromRequest?.body && init?.body === undefined) {
      throw new OAuthProxyError(
        400,
        "A Request with a body cannot be dialled through the pinned transport; pass the body via the init argument so it can be replayed across a redirect.",
      );
    }

    // REDIRECT MODE IS THE CALLER'S. The OAuth suite inspects 3xx responses as
    // evidence, so following one on its behalf would destroy the very thing it
    // is grading; `"error"` means a redirect IS the failure, and silently
    // treating it as `"follow"` would do the one thing the caller ruled out.
    const redirectMode: RequestRedirect =
      init?.redirect ?? fromRequest?.redirect ?? "follow";

    // LOOPBACK IS A PROPERTY OF THE CHAIN, decided by where it started. With
    // the opt-in set but derived per hop, a PUBLIC target could answer
    // `302 Location: http://127.0.0.1:11434/…` and have that hop dialled:
    // attacker-chosen path, plaintext, on the user's own machine.
    const allowPrivateNetwork = options.allowPrivateNetwork === true;
    if (
      !allowPrivateNetwork &&
      options.allowLoopback !== true &&
      isLoopbackOAuthUrl(startUrl)
    ) {
      throw new OAuthProxyError(
        400,
        `Refusing a connection to loopback address "${safeHost(startUrl)}".`,
      );
    }
    const chainAllowsLoopback =
      options.allowLoopback === true && isLoopbackOAuthUrl(startUrl);
    // The private allowance is likewise the chain's: a chain that started
    // public may not redirect onto the caller's LAN even in local mode.
    const chainAllowsPrivate =
      allowPrivateNetwork && isPrivateHost(new URL(startUrl).hostname);

    // ONE deadline for the whole chain's DNS/connect/header phases. Handing
    // each hop the full budget would let a five-hop chain outlive five of them.
    // It is cleared once headers are in, so an SSE body is not on the clock.
    const chainController = new AbortController();
    const chainDeadline =
      chainTimeoutMs > 0
        ? setTimeout(
            () =>
              chainController.abort(
                new OAuthProxyError(
                  504,
                  `${targetLabel} did not answer within ${chainTimeoutMs}ms.`,
                ),
              ),
            chainTimeoutMs,
          )
        : undefined;
    chainDeadline?.unref?.();

    // The socket must die on EITHER the caller's abort or the chain deadline,
    // and must keep dying on the caller's abort after the deadline is cleared —
    // so this signal outlives the header phase and owns the body stream too.
    const socketController = new AbortController();
    const abortSocket = (reason: unknown) => socketController.abort(reason);
    const onChainAbort = () => abortSocket(chainController.signal.reason);
    const onCallerAbort = () => abortSocket(callerSignal?.reason);
    chainController.signal.addEventListener("abort", onChainAbort, {
      once: true,
    });
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const releaseChainDeadline = () => {
      if (chainDeadline) clearTimeout(chainDeadline);
      chainController.signal.removeEventListener("abort", onChainAbort);
    };
    /**
     * The caller's listener has to come off on EVERY terminal path, not only
     * the error ones. An MCP transport hands the same connection-lifetime
     * signal to every request it makes, so a listener left behind per request
     * is a listener leak on a long-lived connection: Node warns at eleven and
     * the retained closures grow for as long as the connection lives.
     *
     * It cannot be released when this function returns, though — the returned
     * `Response` still has a live body, and the caller's abort must keep
     * reaching the socket for as long as that body can be read. So a streaming
     * response hands this to the body stream to call when it settles, and only
     * the paths with no body left to read call it directly.
     */
    const releaseCallerAbort = () => {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };

    let currentUrl = startUrl;
    let currentMethod = (init?.method ?? (input as Request)?.method ?? "GET")
      .toUpperCase();
    let currentHeaders = headersToRecord(input, init);
    let currentBody: Buffer | undefined;
    try {
      currentBody = encodeBody(init?.body as BodyInit | null | undefined);
    } catch (error) {
      releaseChainDeadline();
      releaseCallerAbort();
      throw error;
    }

    // Ask for bytes we can measure. `fetch` decompresses transparently and so
    // do we (`decodeStream`), but announcing identity keeps the common case a
    // straight copy instead of a zlib pipe.
    if (
      !Object.keys(currentHeaders).some(
        (name) => name.toLowerCase() === "accept-encoding",
      )
    ) {
      currentHeaders["accept-encoding"] = "identity";
    }

    try {
      for (let hop = 0; ; hop += 1) {
        if (hop > maxRedirects) {
          throw new OAuthProxyError(
            400,
            `Too many redirects (more than ${maxRedirects}).`,
          );
        }

        const parsed = new URL(currentUrl);
        const hopIsLoopback = isLoopbackOAuthUrl(currentUrl);
        const hopIsPrivate = isPrivateHost(parsed.hostname);
        // Plaintext is a property of the DESTINATION, not of the mode: a
        // private hop on a private chain may be http, exactly as a loopback
        // hop on a loopback chain may. A public host still must serve https.
        const hopMayBePlaintext =
          (chainAllowsLoopback && hopIsLoopback) ||
          (chainAllowsPrivate && hopIsPrivate);
        if (parsed.protocol !== "https:" && !hopMayBePlaintext) {
          throw new OAuthProxyError(
            400,
            // Name the fix. This refusal is about the SCHEME, and a message
            // that only says "refused" gets read as an address problem by
            // whoever has to act on it.
            `Refusing a plaintext connection to "${safeHost(currentUrl)}": the target must be served over https.`,
          );
        }

        const { response } = await openPinnedHop(
          parsed,
          currentMethod,
          currentHeaders,
          currentBody,
          resolveEgressPolicy({
            allowPrivateNetwork: chainAllowsPrivate,
            startUrl,
          }),
          socketController.signal,
          targetLabel,
        );

        const status = response.statusCode ?? 0;
        const location = response.headers["location"];
        if (
          redirectMode === "error" &&
          isRedirectStatus(status) &&
          typeof location === "string"
        ) {
          response.resume();
          throw new OAuthProxyError(
            400,
            "The server returned a redirect and the caller asked for none.",
          );
        }
        if (
          redirectMode === "follow" &&
          isRedirectStatus(status) &&
          typeof location === "string"
        ) {
          // Nothing downstream will read this hop's body; free the socket
          // rather than leaving it draining a response we discarded.
          response.resume();

          let nextUrl: URL;
          try {
            nextUrl = new URL(location, currentUrl);
          } catch {
            throw new OAuthProxyError(
              400,
              "The server returned an invalid redirect location.",
            );
          }

          // Fetch's method rewrite, exactly: 301/302 rewrite POST alone, 303
          // rewrites everything except GET and HEAD, 307/308 rewrite nothing.
          if (
            ((status === 301 || status === 302) && currentMethod === "POST") ||
            (status === 303 &&
              currentMethod !== "GET" &&
              currentMethod !== "HEAD")
          ) {
            currentMethod = "GET";
            currentBody = undefined;
            currentHeaders = stripBodyHeaders(currentHeaders);
          }

          currentHeaders = sameOrigin(currentUrl, nextUrl.toString())
            ? currentHeaders
            : stripCredentials(currentHeaders);
          currentUrl = nextUrl.toString();
          continue;
        }

        // Headers are in and this hop is terminal: the chain deadline has done
        // its job, and an SSE body must not be on its clock.
        releaseChainDeadline();

        const responseHeaders = normalizeResponseHeaders(response);
        if (NULL_BODY_STATUSES.has(status)) {
          response.resume();
          // No body means nothing will settle later, so this path owns the
          // release itself.
          releaseCallerAbort();
          return finalizeResponse(
            new Response(null, {
              status,
              statusText: response.statusMessage ?? "",
              headers: responseHeaders,
            }),
            currentUrl,
          );
        }

        const decoded = decodeStream(response);
        // The decoded view is downstream of the socket; destroying the socket
        // is what actually stops the transfer.
        const body = toGuardedWebStream(
          decoded,
          () => response.destroy(),
          maxResponseBytes,
          bodyIdleTimeoutMs,
          releaseCallerAbort,
        );
        // `content-encoding`/`content-length` described bytes that no longer
        // exist once `decodeStream` has undone them; leaving them would make
        // a consumer that trusts the header mis-read the body.
        if (responseHeaders.has("content-encoding")) {
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }

        return finalizeResponse(
          new Response(body, {
            status,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders,
          }),
          currentUrl,
        );
      }
    } catch (error) {
      releaseChainDeadline();
      releaseCallerAbort();
      // An abort raised by our own deadline reaches here as whatever `undici`
      // or `node:http` chose to throw; the reason we set is the honest one.
      const reason = socketController.signal.reason;
      if (socketController.signal.aborted && reason instanceof OAuthProxyError) {
        throw reason;
      }
      throw error;
    }
    // NOTE: no `finally` that unhooks `onCallerAbort`. The caller's abort must
    // keep reaching the socket for as long as the body stream lives, which is
    // after this function has already returned its `Response` — which is why
    // `releaseCallerAbort` is handed to that stream rather than called here.
  };

  return pinnedStreamingFetch as typeof fetch;
}

/**
 * `Response.url` is read-only and the constructor will not set it, but callers
 * (and error messages) legitimately want the URL the chain ENDED at rather than
 * the one it started from — that is the whole difference a redirect makes.
 */
function finalizeResponse(response: Response, finalUrl: string): Response {
  Object.defineProperty(response, "url", {
    value: finalUrl,
    configurable: true,
  });
  return response;
}
