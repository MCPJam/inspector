import dns from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

export class OAuthProxyError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface OAuthProxyRequest {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  httpsOnly?: boolean;
  /** Redirect handling. httpsOnly always forces "manual" (cannot be
   * weakened); otherwise an explicit value is honored and omission preserves
   * the historical "follow". */
  redirect?: "follow" | "manual";
  /** Bound the fetch and response-body read. */
  timeoutMs?: number;
}

export interface OAuthProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

// SSRF IP classifier + host check moved to the browser-safe `oauth/ssrf-guard`
// so the machine executor path can reuse it; the Node-only DNS resolution below
// stays here. Re-exported to preserve the public `isDisallowedIpAddress` symbol.
import {
  isDisallowedIpAddress,
  isLoopbackOAuthUrl,
  isPrivateHost,
} from "./oauth/ssrf-guard.js";
export { isDisallowedIpAddress };

async function resolveAndValidateDns(hostname: string): Promise<string | null> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    return null;
  }

  const resolved: string[] = [];
  try {
    const ipv4 = await dns.resolve4(hostname);
    resolved.push(...ipv4);
  } catch {
    // no A records is fine
  }
  try {
    const ipv6 = await dns.resolve6(hostname);
    resolved.push(...ipv6);
  } catch {
    // no AAAA records is fine
  }

  for (const ip of resolved) {
    if (isPrivateHost(ip)) {
      throw new OAuthProxyError(
        400,
        "Hostname resolves to a private/reserved IP address",
      );
    }
  }

  return resolved[0] ?? null;
}

interface ValidatedUrl {
  url: URL;
}

function parseAndValidateUrl(
  url: string,
  httpsOnly = false,
): URL {
  if (!url) {
    throw new OAuthProxyError(400, "Missing url parameter");
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(url);
  } catch {
    throw new OAuthProxyError(400, "Invalid URL format");
  }

  if (
    targetUrl.protocol !== "https:" &&
    targetUrl.protocol !== "http:"
  ) {
    throw new OAuthProxyError(400, "Invalid protocol");
  }
  if (httpsOnly && targetUrl.protocol !== "https:") {
    throw new OAuthProxyError(
      400,
      "Only HTTPS targets are allowed in hosted mode",
    );
  }

  return targetUrl;
}

export async function validateUrl(
  url: string,
  httpsOnly = false,
): Promise<ValidatedUrl> {
  const targetUrl = parseAndValidateUrl(url, httpsOnly);

  // Local mode permits HTTP and explicit loopback OAuth servers; it must not
  // disable SSRF validation for every other host.
  const explicitLoopback = !httpsOnly && isLoopbackOAuthUrl(targetUrl.toString());
  if (isPrivateHost(targetUrl.hostname) && !explicitLoopback) {
    throw new OAuthProxyError(
      400,
      "Private/reserved IP addresses are not allowed",
    );
  }
  if (!explicitLoopback) {
    await resolveAndValidateDns(targetUrl.hostname);
  }

  return { url: targetUrl };
}

function buildFetchUrl(targetUrl: URL): string {
  return targetUrl.toString();
}

function requestTimeoutSignal(
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OAuthProxyError(400, "timeoutMs must be a positive number");
  }
  return AbortSignal.timeout(timeoutMs);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}

function buildRequestHeaders(
  customHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return {
    "User-Agent": "MCP-Inspector/1.0",
    ...customHeaders,
  };
}

function encodeRequestBody(
  method: string,
  body: unknown,
  contentType: string | undefined,
): BodyInit | undefined {
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
          resolve({ status, statusText, headers, body });
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

export async function executeOAuthProxy(
  req: OAuthProxyRequest,
): Promise<OAuthProxyResponse> {
  const { url: targetUrl } = await validateUrl(req.url, req.httpsOnly);
  const method = req.method ?? "GET";
  const customHeaders = req.headers;

  const requestHeaders = buildRequestHeaders(customHeaders);
  const contentType =
    customHeaders?.["Content-Type"] || customHeaders?.["content-type"];

  if (method === "POST" && req.body && !contentType) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(buildFetchUrl(targetUrl), {
    method,
    headers: requestHeaders,
    redirect: req.httpsOnly ? "manual" : req.redirect ?? "follow",
    body: encodeRequestBody(method, req.body, contentType),
    signal: requestTimeoutSignal(req.timeoutMs),
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await parseResponseBody(response),
  };
}

export async function executeDebugOAuthProxy(
  req: OAuthProxyRequest,
): Promise<OAuthProxyResponse> {
  const { url: targetUrl } = await validateUrl(req.url, req.httpsOnly);
  const method = req.method ?? "GET";
  const customHeaders = req.headers;

  const requestHeaders = buildRequestHeaders(customHeaders);
  const contentType =
    customHeaders?.["Content-Type"] || customHeaders?.["content-type"];

  if (method === "POST" && req.body && !contentType) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(buildFetchUrl(targetUrl), {
    method,
    headers: requestHeaders,
    redirect: req.httpsOnly ? "manual" : req.redirect ?? "follow",
    body: encodeRequestBody(method, req.body, contentType),
    signal: requestTimeoutSignal(req.timeoutMs),
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let responseBody: unknown = null;
  const contentTypeHeader = headers["content-type"] || "";

  if (contentTypeHeader.includes("text/event-stream")) {
    try {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const events: Array<{ event?: string; data?: unknown; id?: string }> = [];
      let currentEvent: Record<string, unknown> = {};
      const maxReadTime = 5000;
      const startTime = Date.now();

      if (reader) {
        try {
          while (Date.now() - startTime < maxReadTime) {
            const { done, value } = await Promise.race([
              reader.read(),
              new Promise<{ done: boolean; value: undefined }>((_, reject) =>
                setTimeout(() => reject(new Error("Read timeout")), 1000),
              ),
            ]);

            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

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
              } else if (line === "") {
                if (Object.keys(currentEvent).length > 0) {
                  events.push({ ...currentEvent });
                  currentEvent = {};
                  if (events.length >= 1) break;
                }
              }
            }

            if (events.length >= 1) break;
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel errors
          }
        }
      }

      responseBody = {
        transport: "sse",
        events,
        isOldTransport: events[0]?.event === "endpoint",
        endpoint: events[0]?.event === "endpoint" ? events[0].data : null,
        mcpResponse:
          events.find((event) => event.event === "message" || !event.event)
            ?.data || null,
        rawBuffer: buffer,
      };
    } catch (error) {
      responseBody = {
        error: "Failed to parse SSE stream",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    responseBody = await parseResponseBody(response);
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: responseBody,
  };
}

const MAX_OAUTH_METADATA_REDIRECTS = 5;
const MAX_OAUTH_METADATA_BYTES = 1024 * 1024;

interface PinnedAddress {
  address: string;
  family: number;
}

interface RawOAuthMetadataResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

function isLoopbackAddress(address: string): boolean {
  const host = address.includes(":") ? `[${address}]` : address;
  return isLoopbackOAuthUrl(`http://${host}`);
}

async function resolvePinnedAddresses(
  targetUrl: URL,
  allowLoopbackFlow: boolean,
): Promise<PinnedAddress[] | null> {
  const targetIsLoopback = isLoopbackOAuthUrl(targetUrl.toString());

  if (isPrivateHost(targetUrl.hostname)) {
    if (!(allowLoopbackFlow && targetIsLoopback)) {
      throw new OAuthProxyError(
        400,
        `OAuth metadata target is a private/reserved host (${targetUrl.hostname})`,
      );
    }
  }

  // Numeric IPs are already the exact socket destination, so there is no DNS
  // lookup to pin. The literal-host check above has classified them.
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(targetUrl.hostname) ||
    targetUrl.hostname.includes(":")
  ) {
    return null;
  }

  const addresses = await new Promise<PinnedAddress[]>((resolve, reject) => {
    dnsLookupCb(
      targetUrl.hostname,
      { all: true, verbatim: true },
      (error, resolved) => {
        if (error) {
          reject(
            new OAuthProxyError(
              400,
              `Could not resolve OAuth metadata host ${targetUrl.hostname}`,
            ),
          );
          return;
        }
        resolve(Array.isArray(resolved) ? resolved : [resolved]);
      },
    );
  });

  if (addresses.length === 0) {
    throw new OAuthProxyError(
      400,
      `Could not resolve OAuth metadata host ${targetUrl.hostname}`,
    );
  }

  for (const { address } of addresses) {
    if (targetIsLoopback) {
      if (!isLoopbackAddress(address)) {
        throw new OAuthProxyError(
          400,
          `Loopback OAuth metadata host resolved outside loopback (${address})`,
        );
      }
    } else if (isDisallowedIpAddress(address)) {
      throw new OAuthProxyError(
        400,
        `OAuth metadata host resolves to a private/reserved IP address (${address})`,
      );
    }
  }

  return addresses;
}

function createPinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options?.all) {
      return (
        callback as unknown as (
          err: NodeJS.ErrnoException | null,
          resolved: PinnedAddress[],
        ) => void
      )(null, addresses);
    }
    callback(null, addresses[0].address, addresses[0].family);
  };
}

async function requestPinnedOAuthMetadata(
  targetUrl: URL,
  allowLoopbackFlow: boolean,
  signal: AbortSignal | undefined,
): Promise<RawOAuthMetadataResponse> {
  const pinnedAddresses = await resolvePinnedAddresses(
    targetUrl,
    allowLoopbackFlow,
  );
  const transport = targetUrl.protocol === "https:" ? https : http;

  return await new Promise<RawOAuthMetadataResponse>((resolve, reject) => {
    const request = transport.request(
      targetUrl,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "MCP-Inspector/1.0",
        },
        ...(pinnedAddresses
          ? { lookup: createPinnedLookup(pinnedAddresses) }
          : {}),
        ...(targetUrl.protocol === "https:"
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
          response.resume();
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
                `OAuth metadata exceeds the ${MAX_OAUTH_METADATA_BYTES}-byte cap`,
              ),
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
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export async function fetchOAuthMetadata(
  url: string,
  httpsOnly = false,
  timeoutMs?: number,
): Promise<
  | {
      metadata: Record<string, unknown>;
      finalUrl: string;
      status?: undefined;
    }
  | { status: number; statusText: string }
> {
  const metadataUrl = parseAndValidateUrl(url, httpsOnly);
  const allowLoopbackFlow =
    !httpsOnly && isLoopbackOAuthUrl(metadataUrl.toString());
  const signal = requestTimeoutSignal(timeoutMs);
  let currentUrl = metadataUrl;
  let response: RawOAuthMetadataResponse | undefined;

  for (let redirectCount = 0; ; redirectCount += 1) {
    if (
      currentUrl.protocol !== "https:" &&
      currentUrl.protocol !== "http:"
    ) {
      throw new OAuthProxyError(
        400,
        "OAuth metadata redirect uses an invalid protocol",
      );
    }
    if (httpsOnly && currentUrl.protocol !== "https:") {
      throw new OAuthProxyError(
        400,
        "OAuth metadata redirect must use HTTPS in hosted mode",
      );
    }

    try {
      response = await requestPinnedOAuthMetadata(
        currentUrl,
        allowLoopbackFlow,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) {
        throw new OAuthProxyError(
          400,
          `OAuth metadata request timeout after ${timeoutMs}ms`,
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

    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      throw new OAuthProxyError(
        502,
        "OAuth metadata returned an invalid redirect URL",
      );
    }
    // The next iteration validates and pins the redirect destination before
    // opening its socket.
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
      statusText: `Upstream returned non-JSON content-type: ${contentType ?? "(none)"}`,
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
