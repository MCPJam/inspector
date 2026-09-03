import { lookup as dnsLookupCb } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { IncomingMessage } from "node:http";

// Defined in its own module so `oauth/pinned-dns.ts` can throw it without an
// import cycle; re-exported here so the public symbol and every existing
// `instanceof` check are unchanged.
export { OAuthProxyError } from "./oauth-proxy-error.js";
import { OAuthProxyError } from "./oauth-proxy-error.js";

export interface OAuthProxyRequest {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  httpsOnly?: boolean;
  /**
   * Permit private destinations (loopback, RFC 1918, CGNAT, unique-local, and
   * any hostname resolving to one). The LOCAL inspector sets this; hosted
   * callers never do, and `httpsOnly` overrides it if both are set.
   * Link-local and cloud-metadata addresses stay refused either way.
   */
  allowPrivateNetwork?: boolean;
  /** Redirect handling. httpsOnly always forces "manual" (cannot be
   * weakened); otherwise an explicit value is honored and omission preserves
   * the historical "follow". */
  redirect?: "follow" | "manual";
  /** Bound DNS, connection setup, redirects, and the response-body read. */
  timeoutMs?: number;
  /** Caller-owned cancellation, composed with the timeout: whichever aborts
   * first ends the request, socket included. */
  signal?: AbortSignal;
}

export interface OAuthProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  finalUrl: string;
}

// SSRF IP classifier + host check moved to the browser-safe `oauth/ssrf-guard`
// so the machine executor path can reuse it; the Node-only DNS resolution below
// stays here. Re-exported to preserve the public `isDisallowedIpAddress` symbol.
import {
  isDisallowedIpAddress,
  isPrivateHost,
} from "./oauth/ssrf-guard.js";
// The DNS half — resolve once, classify, pin — lives in its own node-only
// module so the streaming transport in `oauth/pinned-stream-fetch.ts` shares
// this exact implementation rather than forking a second one.
import {
  createPinnedLookup,
  resolveEgressPolicy,
  resolvePinnedAddresses,
} from "./oauth/pinned-dns.js";
import type { EgressPolicy } from "./oauth/pinned-dns.js";
export { isDisallowedIpAddress };

interface ValidatedUrl {
  url: URL;
}

function parseAndValidateUrl(url: string, httpsOnly = false): URL {
  if (!url) {
    throw new OAuthProxyError(400, "Missing url parameter");
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(url);
  } catch {
    throw new OAuthProxyError(400, "Invalid URL format");
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new OAuthProxyError(400, "Invalid protocol");
  }
  if (targetUrl.username || targetUrl.password) {
    throw new OAuthProxyError(
      400,
      "OAuth target URL must not contain credentials",
    );
  }
  if (httpsOnly && targetUrl.protocol !== "https:") {
    throw new OAuthProxyError(
      400,
      "Only HTTPS targets are allowed in hosted mode",
    );
  }

  return targetUrl;
}

/**
 * Options for the destination checks. The boolean form is the historical
 * `httpsOnly` positional and stays supported so existing callers (including
 * consumers of the published package) need no change.
 */
export interface ValidateUrlOptions {
  httpsOnly?: boolean;
  allowPrivateNetwork?: boolean;
}

function toValidateOptions(
  options: boolean | ValidateUrlOptions | undefined,
): ValidateUrlOptions {
  if (typeof options === "boolean") return { httpsOnly: options };
  return options ?? {};
}

export async function validateUrl(
  url: string,
  options: boolean | ValidateUrlOptions = false,
): Promise<ValidatedUrl> {
  const { httpsOnly = false, allowPrivateNetwork } = toValidateOptions(options);
  const targetUrl = parseAndValidateUrl(url, httpsOnly);
  const policy = resolveEgressPolicy({
    httpsOnly,
    allowPrivateNetwork,
    startUrl: targetUrl.toString(),
  });
  await resolvePinnedAddresses(targetUrl, policy, undefined, "OAuth target");

  return { url: targetUrl };
}

function requestTimeoutSignal(
  timeoutMs: number | undefined,
  external?: AbortSignal,
): AbortSignal | undefined {
  if (timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new OAuthProxyError(400, "timeoutMs must be a positive number");
    }
  }
  const timeout =
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  if (timeout && external) return AbortSignal.any([timeout, external]);
  return timeout ?? external;
}

function buildRequestHeaders(
  customHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(customHeaders ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  // These are connection-specific or must be derived from the actual pinned
  // request. Do not let a proxy caller override them.
  for (const name of [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete headers[name];
  }

  headers["user-agent"] ??= "MCP-Inspector/1.0";
  // Raw http(s).request does not decompress automatically. Requesting identity
  // keeps response parsing deterministic and preserves fetch-like semantics.
  headers["accept-encoding"] = "identity";
  return headers;
}

function encodeRequestBody(
  method: string,
  body: unknown,
  contentType: string | undefined,
): string | undefined {
  if (method !== "POST" || body === undefined || body === null) {
    return undefined;
  }

  const isFormUrlEncoded = contentType?.includes(
    "application/x-www-form-urlencoded",
  );

  if (isFormUrlEncoded && typeof body === "object") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      params.append(key, String(value));
    }
    return params.toString();
  }

  if (typeof body === "string") {
    return body;
  }

  return JSON.stringify(body);
}

/**
 * SSRF-hardened GET of a caller-influenced public document (the CIMD client
 * metadata document). Unlike `validateUrl` + `fetch` — which resolve DNS twice
 * and leave a rebinding window — this resolves once, rejects any private/reserved
 * result (RFC 6890), and PINS that address into the connection via a custom
 * `lookup`, so the socket connects to the validated IP with no second resolution.
 * HTTPS-only, does not follow redirects, and caps the body (CIMD draft-02 §8.6).
 */
export async function fetchPinnedPublicDocument(
  urlString: string,
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<OAuthProxyResponse> {
  const url = new URL(urlString);
  if (url.protocol !== "https:") {
    throw new OAuthProxyError(
      400,
      "The client metadata document must be served over HTTPS",
    );
  }
  // Reject a literal private/reserved host before opening any connection.
  if (isPrivateHost(url.hostname)) {
    throw new OAuthProxyError(
      400,
      `The client metadata host is a private or reserved address (${url.hostname})`,
    );
  }
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 5 * 1024;
  const timeoutMs =
    opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;

  // Resolve once, validate every candidate, and pin the validated result into
  // the connection. The socket uses exactly these addresses — no re-resolution —
  // which is what actually closes the DNS-rebinding window.
  //
  // The callback shape must follow `options.all`: with autoSelectFamily (the
  // Node ≥20 default) the socket passes `all: true` and expects an ARRAY of
  // {address, family} entries; answering with a bare string there makes Node
  // throw ERR_INVALID_IP_ADDRESS ("Invalid IP address: undefined").
  const pinningLookup: LookupFunction = (hostname, options, callback) => {
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        return callback(
          new OAuthProxyError(400, `Could not resolve ${hostname}`),
          "",
          0,
        );
      }
      for (const a of list) {
        if (isDisallowedIpAddress(a.address)) {
          return callback(
            new OAuthProxyError(
              400,
              `${hostname} resolves to a private or reserved address (${a.address})`,
            ),
            "",
            0,
          );
        }
      }
      if (typeof options === "object" && options?.all) {
        return (
          callback as unknown as (
            err: NodeJS.ErrnoException | null,
            addresses: { address: string; family: number }[],
          ) => void
        )(null, list);
      }
      callback(null, list[0].address, list[0].family);
    });
  };

  // A TOTAL deadline covering connect + response read (not an idle-socket
  // timeout that incoming bytes reset): a slow-loris server cannot hold the flow
  // open indefinitely. Aborting destroys the request and ends the body read.
  const deadline = AbortSignal.timeout(timeoutMs);
  return await new Promise<OAuthProxyResponse>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { "User-Agent": "MCP-Inspector/1.0", ...(opts.headers ?? {}) },
        lookup: pinningLookup,
        servername: url.hostname,
        signal: deadline,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const statusText = res.statusMessage ?? "";
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value ?? "");
        }
        // Redirects are NOT followed — a 3xx is surfaced as-is (draft-02 forbids
        // the authorization server following redirects for CIMD).
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            request.destroy();
            reject(
              new OAuthProxyError(
                400,
                `The client metadata document exceeds the ${maxBytes}-byte cap`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // leave as text; the caller's media-type check reports the mismatch
          }
          resolve({
            status,
            statusText,
            headers,
            body,
            finalUrl: url.toString(),
          });
        });
        res.on("error", reject);
      },
    );
    request.on("error", (err) => {
      reject(
        deadline.aborted
          ? new OAuthProxyError(
              400,
              `The client metadata document request exceeded the ${timeoutMs}ms deadline`,
            )
          : err,
      );
    });
    request.end();
  });
}

const MAX_OAUTH_PROXY_REDIRECTS = 5;
const MAX_OAUTH_PROXY_BYTES = 1024 * 1024;
const DEBUG_SSE_MAX_READ_MS = 5000;
const DEBUG_SSE_IDLE_TIMEOUT_MS = 1000;

interface PreparedOAuthRequest {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

interface RawPinnedOAuthResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  finalUrl: string;
  stream?: IncomingMessage;
}

function normalizeResponseHeaders(
  response: IncomingMessage
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : String(value ?? "");
  }
  return headers;
}

function prepareOAuthRequest(req: OAuthProxyRequest): PreparedOAuthRequest {
  const method = (req.method ?? "GET").toUpperCase();
  const headers = buildRequestHeaders(req.headers);
  const contentType = headers["content-type"];
  if (
    method === "POST" &&
    req.body !== undefined &&
    req.body !== null &&
    !contentType
  ) {
    headers["content-type"] = "application/json";
  }

  const encodedBody = encodeRequestBody(
    method,
    req.body,
    headers["content-type"]
  );
  const body =
    encodedBody === undefined ? undefined : Buffer.from(encodedBody, "utf8");
  if (body) {
    headers["content-length"] = String(body.byteLength);
  }
  return { method, headers, body };
}

function isFetchRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function removeHeaders(
  headers: Record<string, string>,
  names: readonly string[]
): void {
  for (const name of names) {
    delete headers[name];
  }
}

function updateRequestForRedirect(
  request: PreparedOAuthRequest,
  status: number,
  currentUrl: URL,
  nextUrl: URL
): PreparedOAuthRequest {
  const next: PreparedOAuthRequest = {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
  };

  // Fetch rewrites POST to GET for 301/302, and every non-GET/HEAD method to
  // GET for 303. 307/308 preserve both method and body.
  if (
    ((status === 301 || status === 302) && next.method === "POST") ||
    (status === 303 && next.method !== "GET" && next.method !== "HEAD")
  ) {
    next.method = "GET";
    next.body = undefined;
    removeHeaders(next.headers, [
      "content-encoding",
      "content-language",
      "content-length",
      "content-location",
      "content-type",
    ]);
  }

  // Match Fetch's credential-boundary behavior. A redirect to another origin
  // must not receive bearer/basic credentials or cookies supplied to the
  // original authorization server.
  if (currentUrl.origin !== nextUrl.origin) {
    removeHeaders(next.headers, [
      "authorization",
      "cookie",
      "cookie2",
      "proxy-authorization",
    ]);
  }

  return next;
}

async function requestPinnedOAuthHop(
  targetUrl: URL,
  requestInit: PreparedOAuthRequest,
  policy: EgressPolicy,
  signal: AbortSignal | undefined,
  onResolved?: (targetIsPrivate: boolean) => void
): Promise<RawPinnedOAuthResponse> {
  const { addresses: pinnedAddresses, targetIsPrivate } =
    await resolvePinnedAddresses(
      targetUrl,
      policy,
      signal,
      "OAuth proxy target"
    );
  onResolved?.(targetIsPrivate);
  const transport = targetUrl.protocol === "https:" ? https : http;

  return await new Promise<RawPinnedOAuthResponse>((resolve, reject) => {
    const request = transport.request(
      targetUrl,
      {
        method: requestInit.method,
        headers: requestInit.headers,
        ...(pinnedAddresses
          ? { lookup: createPinnedLookup(pinnedAddresses) }
          : {}),
        ...(targetUrl.protocol === "https:" &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(targetUrl.hostname) &&
        !targetUrl.hostname.includes(":")
          ? { servername: targetUrl.hostname }
          : {}),
        signal,
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers: normalizeResponseHeaders(response),
          finalUrl: targetUrl.toString(),
          stream: response,
        });
      }
    );
    request.on("error", reject);
    if (requestInit.body) {
      request.write(requestInit.body);
    }
    request.end();
  });
}

async function executePinnedOAuthRequest(req: OAuthProxyRequest): Promise<{
  response: RawPinnedOAuthResponse;
  signal: AbortSignal | undefined;
}> {
  const initialUrl = parseAndValidateUrl(req.url, req.httpsOnly);
  const policy = resolveEgressPolicy({
    httpsOnly: req.httpsOnly,
    allowPrivateNetwork: req.allowPrivateNetwork,
    startUrl: initialUrl.toString(),
  });
  const redirectMode = req.httpsOnly ? "manual" : req.redirect ?? "follow";
  const signal = requestTimeoutSignal(req.timeoutMs, req.signal);
  let currentUrl = initialUrl;
  let requestInit = prepareOAuthRequest(req);
  // THE PRIVATE ALLOWANCE BELONGS TO THE CHAIN, and the chain's character is
  // decided by where its FIRST hop actually landed — not by how the hostname
  // looked, because a name that looks public and answers 127.0.0.1 is the case
  // this allowance exists to serve. So: hop 1 may go anywhere the policy
  // permits; a later hop may be private only if hop 1 was. Without this a
  // public authorization server could answer `302 Location: http://192.168…`
  // and have the local inspector fetch it.
  let hopPolicy = policy;
  const narrowAfterFirstHop = (targetIsPrivate: boolean) => {
    hopPolicy = targetIsPrivate
      ? hopPolicy
      : { ...hopPolicy, allowPrivateNetwork: false };
  };

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await requestPinnedOAuthHop(
        currentUrl,
        requestInit,
        hopPolicy,
        signal,
        redirectCount === 0 ? narrowAfterFirstHop : undefined
      );

      if (!isFetchRedirectStatus(response.status)) {
        return { response, signal };
      }

      // Redirect bodies are never useful to the proxy and can otherwise be an
      // unbounded resource sink. Preserve the status and headers for manual
      // mode, but close the stream immediately.
      response.stream?.destroy();
      response.stream = undefined;

      const location = response.headers.location;
      if (redirectMode === "manual" || !location) {
        return { response, signal };
      }
      if (redirectCount >= MAX_OAUTH_PROXY_REDIRECTS) {
        throw new OAuthProxyError(400, "Too many OAuth proxy redirects");
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new OAuthProxyError(
          502,
          "OAuth proxy returned an invalid redirect URL"
        );
      }
      // Validate scheme and hosted HTTPS policy now. DNS/private-network
      // validation happens in requestPinnedOAuthHop before the next socket.
      nextUrl = parseAndValidateUrl(nextUrl.toString(), req.httpsOnly);
      requestInit = updateRequestForRedirect(
        requestInit,
        response.status,
        currentUrl,
        nextUrl
      );
      currentUrl = nextUrl;
    }
  } catch (error) {
    if (signal?.aborted) {
      // The CALLER's abort is a cancellation, not an outage: surface it as the
      // AbortError they triggered so it is never classified as retryable.
      if (req.signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      throw new OAuthProxyError(
        400,
        `OAuth proxy request timeout after ${req.timeoutMs}ms`
      );
    }
    throw error;
  }
}

async function readBoundedResponseBody(
  response: IncomingMessage | undefined
): Promise<string> {
  if (!response) return "";

  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      response.removeListener("data", onData);
      response.removeListener("end", onEnd);
      response.removeListener("error", onError);
      response.removeListener("aborted", onAborted);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      response.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > MAX_OAUTH_PROXY_BYTES) {
        fail(
          new OAuthProxyError(
            400,
            `OAuth proxy response exceeds the ${MAX_OAUTH_PROXY_BYTES}-byte cap`
          )
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("OAuth proxy response was aborted"));

    response.on("data", onData);
    response.on("end", onEnd);
    response.on("error", onError);
    response.on("aborted", onAborted);
  });
}

function parseBufferedResponseBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function readDebugSseBody(
  response: IncomingMessage
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    let settled = false;
    let currentEvent: { event?: string; data?: unknown; id?: string } = {};
    const events: Array<{ event?: string; data?: unknown; id?: string }> = [];
    let idleTimer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      response.removeListener("data", onData);
      response.removeListener("end", onEnd);
      response.removeListener("error", onError);
      response.removeListener("aborted", onAborted);
    };
    const result = () => ({
      transport: "sse",
      events,
      isOldTransport: events[0]?.event === "endpoint",
      endpoint: events[0]?.event === "endpoint" ? events[0].data : null,
      mcpResponse:
        events.find((event) => event.event === "message" || !event.event)
          ?.data || null,
      rawBuffer: buffer,
    });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      response.destroy();
      if (error) reject(error);
      else resolve(result());
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(new Error("Read timeout")),
        DEBUG_SSE_IDLE_TIMEOUT_MS
      );
    };
    const processLines = () => {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent.event = line.substring(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.substring(5).trim();
          try {
            currentEvent.data = JSON.parse(data);
          } catch {
            currentEvent.data = data;
          }
        } else if (line.startsWith("id:")) {
          currentEvent.id = line.substring(3).trim();
        } else if (line === "" && Object.keys(currentEvent).length > 0) {
          events.push(currentEvent);
          currentEvent = {};
          finish();
          return;
        }
      }
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_OAUTH_PROXY_BYTES) {
        finish(
          new OAuthProxyError(
            400,
            `OAuth proxy response exceeds the ${MAX_OAUTH_PROXY_BYTES}-byte cap`
          )
        );
        return;
      }
      buffer += decoder.decode(bytes, { stream: true });
      resetIdleTimer();
      processLines();
    };
    const onEnd = () => {
      buffer += decoder.decode();
      processLines();
      if (!settled) finish();
    };
    const onError = (error: Error) => finish(error);
    const onAborted = () =>
      finish(new Error("OAuth proxy response was aborted"));
    const maxTimer = setTimeout(() => finish(), DEBUG_SSE_MAX_READ_MS);

    response.on("data", onData);
    response.on("end", onEnd);
    response.on("error", onError);
    response.on("aborted", onAborted);
    resetIdleTimer();
  });
}

export async function executeOAuthProxy(
  req: OAuthProxyRequest
): Promise<OAuthProxyResponse> {
  const { response, signal } = await executePinnedOAuthRequest(req);
  try {
    const body = await readBoundedResponseBody(response.stream);
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: parseBufferedResponseBody(body),
      finalUrl: response.finalUrl,
    };
  } catch (error) {
    if (signal?.aborted) {
      // The CALLER's abort is a cancellation, not an outage: surface it as the
      // AbortError they triggered so it is never classified as retryable.
      if (req.signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      throw new OAuthProxyError(
        400,
        `OAuth proxy request timeout after ${req.timeoutMs}ms`
      );
    }
    throw error;
  }
}

export async function executeDebugOAuthProxy(
  req: OAuthProxyRequest
): Promise<OAuthProxyResponse> {
  const { response, signal } = await executePinnedOAuthRequest(req);
  let responseBody: unknown = null;

  try {
    if (
      response.stream &&
      response.headers["content-type"]?.includes("text/event-stream")
    ) {
      try {
        responseBody = await readDebugSseBody(response.stream);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        responseBody = {
          error: "Failed to parse SSE stream",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      responseBody = parseBufferedResponseBody(
        await readBoundedResponseBody(response.stream)
      );
    }
  } catch (error) {
    if (signal?.aborted) {
      // The CALLER's abort is a cancellation, not an outage: surface it as the
      // AbortError they triggered so it is never classified as retryable.
      if (req.signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      throw new OAuthProxyError(
        400,
        `OAuth proxy request timeout after ${req.timeoutMs}ms`
      );
    }
    throw error;
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: responseBody,
    finalUrl: response.finalUrl,
  };
}

const MAX_OAUTH_METADATA_REDIRECTS = 5;
const MAX_OAUTH_METADATA_BYTES = 1024 * 1024;

interface RawOAuthMetadataResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

async function requestPinnedOAuthMetadata(
  targetUrl: URL,
  policy: EgressPolicy,
  signal: AbortSignal | undefined,
  onResolved?: (targetIsPrivate: boolean) => void
): Promise<RawOAuthMetadataResponse> {
  const { addresses: pinnedAddresses, targetIsPrivate } =
    await resolvePinnedAddresses(targetUrl, policy, signal);
  onResolved?.(targetIsPrivate);
  const transport = targetUrl.protocol === "https:" ? https : http;

  return await new Promise<RawOAuthMetadataResponse>((resolve, reject) => {
    const request = transport.request(
      targetUrl,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": "MCP-Inspector/1.0",
        },
        ...(pinnedAddresses
          ? { lookup: createPinnedLookup(pinnedAddresses) }
          : {}),
        ...(targetUrl.protocol === "https:" &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(targetUrl.hostname) &&
        !targetUrl.hostname.includes(":")
          ? { servername: targetUrl.hostname }
          : {}),
        signal,
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value ?? "");
        }

        const status = response.statusCode ?? 0;
        const statusText = response.statusMessage ?? "";
        if (status >= 300 && status < 400) {
          response.destroy();
          resolve({ status, statusText, headers, body: "" });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_OAUTH_METADATA_BYTES) {
            request.destroy();
            reject(
              new OAuthProxyError(
                400,
                `OAuth metadata exceeds the ${MAX_OAUTH_METADATA_BYTES}-byte cap`
              )
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          resolve({
            status,
            statusText,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end();
  });
}

export async function fetchOAuthMetadata(
  url: string,
  options: boolean | ValidateUrlOptions = false,
  timeoutMs?: number
): Promise<
  | {
      metadata: Record<string, unknown>;
      finalUrl: string;
      status?: undefined;
    }
  | { status: number; statusText: string }
> {
  const { httpsOnly = false, allowPrivateNetwork } = toValidateOptions(options);
  const metadataUrl = parseAndValidateUrl(url, httpsOnly);
  const policy = resolveEgressPolicy({
    httpsOnly,
    allowPrivateNetwork,
    startUrl: metadataUrl.toString(),
  });
  const signal = requestTimeoutSignal(timeoutMs);
  let currentUrl = metadataUrl;
  let response: RawOAuthMetadataResponse | undefined;
  // THE PRIVATE ALLOWANCE BELONGS TO THE CHAIN, and the chain's character is
  // decided by where its FIRST hop actually landed — not by how the hostname
  // looked, because a name that looks public and answers 127.0.0.1 is the case
  // this allowance exists to serve. So: hop 1 may go anywhere the policy
  // permits; a later hop may be private only if hop 1 was. Without this a
  // public authorization server could answer `302 Location: http://192.168…`
  // and have the local inspector fetch it.
  let hopPolicy = policy;
  const narrowAfterFirstHop = (targetIsPrivate: boolean) => {
    hopPolicy = targetIsPrivate
      ? hopPolicy
      : { ...hopPolicy, allowPrivateNetwork: false };
  };

  for (let redirectCount = 0; ; redirectCount += 1) {
    if (currentUrl.protocol !== "https:" && currentUrl.protocol !== "http:") {
      throw new OAuthProxyError(
        400,
        "OAuth metadata redirect uses an invalid protocol"
      );
    }
    if (httpsOnly && currentUrl.protocol !== "https:") {
      throw new OAuthProxyError(
        400,
        "OAuth metadata redirect must use HTTPS in hosted mode"
      );
    }

    try {
      response = await requestPinnedOAuthMetadata(
        currentUrl,
        hopPolicy,
        signal,
        redirectCount === 0 ? narrowAfterFirstHop : undefined
      );
    } catch (error) {
      if (signal?.aborted) {
        throw new OAuthProxyError(
          400,
          `OAuth metadata request timeout after ${timeoutMs}ms`
        );
      }
      throw error;
    }

    if (response.status < 300 || response.status >= 400) {
      break;
    }

    const location = response.headers.location;
    if (!location) {
      break;
    }
    if (redirectCount >= MAX_OAUTH_METADATA_REDIRECTS) {
      throw new OAuthProxyError(400, "Too many OAuth metadata redirects");
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new OAuthProxyError(
        502,
        "OAuth metadata returned an invalid redirect URL"
      );
    }
    // Validate scheme, hosted HTTPS policy, and embedded credentials now —
    // same policy as the generic proxy loop. DNS/private-network validation
    // happens in requestPinnedOAuthMetadata before the next socket.
    currentUrl = parseAndValidateUrl(nextUrl.toString(), httpsOnly);
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      status: response.status,
      statusText: response.statusText,
    };
  }

  const contentType = response.headers["content-type"];
  if (!contentType?.includes("application/json")) {
    return {
      status: 502,
      statusText: `Upstream returned non-JSON content-type: ${
        contentType ?? "(none)"
      }`,
    };
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return {
      status: 502,
      statusText: "Upstream returned invalid JSON body",
    };
  }

  return {
    metadata,
    // Every redirect hop above was validated and connected through its pinned
    // address set before this effective URL could be reached.
    finalUrl: currentUrl.toString(),
  };
}
