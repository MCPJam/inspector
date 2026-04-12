import dns from "node:dns/promises";

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
}

export interface OAuthProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::"
  ) {
    return true;
  }

  if (
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  ) {
    return true;
  }

  if (host.startsWith("172.")) {
    const second = parseInt(host.split(".")[1] ?? "", 10);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }

  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd")) {
      return true;
    }

    if (/^fe[89ab][0-9a-f]/i.test(host)) {
      return true;
    }
  }

  return false;
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
    redirect: req.httpsOnly ? "manual" : "follow",
    body: encodeRequestBody(method, req.body, contentType),
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
    redirect: req.httpsOnly ? "manual" : "follow",
    body: encodeRequestBody(method, req.body, contentType),
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
