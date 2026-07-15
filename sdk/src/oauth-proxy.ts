import dns from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
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

function isDisallowedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((o) => parseInt(o, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true; // malformed → reject
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // 224/4 multicast
  if (a >= 240) return true; // 240/4 reserved (incl. 255.255.255.255)
  return false;
}

/** Expand any IPv6 text form to exactly 8 hextets, folding a trailing dotted
 * IPv4 tail into two hextets. Returns null for anything unparseable. */
function ipv6ToHextets(input: string): number[] | null {
  let s = input.trim().toLowerCase().split("%")[0];
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // Fold a trailing dotted IPv4 (…::a.b.c.d, incl. ::ffff:a.b.c.d) to hextets.
  const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map((x) =>
      parseInt(x, 10),
    );
    if (o.some((n) => n < 0 || n > 255)) return null;
    s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${(
      (o[2] << 8) |
      o[3]
    ).toString(16)}`;
  }
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const halves = s.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const left = parseGroups(halves[0]);
    const right = parseGroups(halves[1]);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    return [...left, ...Array(missing).fill(0), ...right];
  }
  const only = parseGroups(s);
  return only && only.length === 8 ? only : null;
}

function isDisallowedEmbeddedIpv4(h6: number, h7: number): boolean {
  return isDisallowedIpv4(
    `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`,
  );
}

function isDisallowedIpv6(input: string): boolean {
  const h = ipv6ToHextets(input);
  if (!h) return true; // unparseable → reject
  const topZero = h.slice(0, 6).every((x) => x === 0);
  if (topZero && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: , ::1
  const b0 = h[0] >> 8;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (b0 === 0xff) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 docs
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64
  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96): the
  // embedded IPv4 decides — this closes the ::ffff:7f00:1 hex-literal bypass.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) {
    if (h[5] === 0xffff || h[5] === 0)
      return isDisallowedEmbeddedIpv4(h[6], h[7]);
  }
  return false;
}

/**
 * RFC 6890 special-use / non-public-unicast check for a numeric IP (IPv4, IPv6,
 * or IPv4-mapped IPv6 in any text form). Returns true for addresses an outbound
 * SSRF-sensitive fetch must refuse. A bare hostname (not an IP literal) returns
 * false — the caller resolves it first.
 */
export function isDisallowedIpAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return isDisallowedIpv4(addr);
  if (addr.includes(":")) return isDisallowedIpv6(addr);
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isDisallowedIpAddress(host);
}

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

export async function validateUrl(
  url: string,
  httpsOnly = false,
): Promise<ValidatedUrl> {
  if (!url) {
    throw new OAuthProxyError(400, "Missing url parameter");
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(url);
  } catch {
    throw new OAuthProxyError(400, "Invalid URL format");
  }

  if (httpsOnly) {
    if (targetUrl.protocol !== "https:") {
      throw new OAuthProxyError(
        400,
        "Only HTTPS targets are allowed in hosted mode",
      );
    }
    if (isPrivateHost(targetUrl.hostname)) {
      throw new OAuthProxyError(
        400,
        "Private/reserved IP addresses are not allowed",
      );
    }
    await resolveAndValidateDns(targetUrl.hostname);
  } else if (
    targetUrl.protocol !== "https:" &&
    targetUrl.protocol !== "http:"
  ) {
    throw new OAuthProxyError(400, "Invalid protocol");
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

  // Resolve once, validate every candidate, and pin the chosen IP into the
  // connection. The socket uses exactly this address — no re-resolution — which
  // is what actually closes the DNS-rebinding window.
  const pinningLookup: LookupFunction = (hostname, _options, callback) => {
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

export async function fetchOAuthMetadata(
  url: string,
  httpsOnly = false,
  timeoutMs?: number,
): Promise<
  | { metadata: Record<string, unknown>; status?: undefined }
  | { status: number; statusText: string }
> {
  const { url: metadataUrl } = await validateUrl(url, httpsOnly);

  const response = await fetch(buildFetchUrl(metadataUrl), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "MCP-Inspector/1.0",
    },
    redirect: httpsOnly ? "manual" : "follow",
    signal: requestTimeoutSignal(timeoutMs),
  });

  if (!response.ok) {
    return {
      status: response.status,
      statusText: response.statusText,
    };
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return {
      status: 502,
      statusText: `Upstream returned non-JSON content-type: ${contentType ?? "(none)"}`,
    };
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.json()) as Record<string, unknown>;
  } catch {
    return {
      status: 502,
      statusText: "Upstream returned invalid JSON body",
    };
  }

  return { metadata };
}
