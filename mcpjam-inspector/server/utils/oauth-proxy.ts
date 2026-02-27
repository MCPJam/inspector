import type { ContentfulStatusCode } from "hono/utils/http-status";

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

function validateUrl(url: string, httpsOnly = false): URL {
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
  } else if (
    targetUrl.protocol !== "https:" &&
    targetUrl.protocol !== "http:"
  ) {
    throw new OAuthProxyError(400, "Invalid protocol");
  }

  return targetUrl;
}

export async function executeOAuthProxy(
  req: OAuthProxyRequest,
): Promise<OAuthProxyResponse> {
  const targetUrl = validateUrl(req.url, req.httpsOnly);
  const method = req.method ?? "GET";
  const customHeaders = req.headers;

  const requestHeaders: Record<string, string> = {
    "User-Agent": "MCP-Inspector/1.0",
    ...customHeaders,
  };

  const contentType =
    customHeaders?.["Content-Type"] || customHeaders?.["content-type"];
  const isFormUrlEncoded = contentType?.includes(
    "application/x-www-form-urlencoded",
  );

  if (method === "POST" && req.body && !contentType) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const fetchOptions: RequestInit = {
    method,
    headers: requestHeaders,
  };

  if (method === "POST" && req.body) {
    if (isFormUrlEncoded && typeof req.body === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(
        req.body as Record<string, unknown>,
      )) {
        params.append(key, String(value));
      }
      fetchOptions.body = params.toString();
    } else if (typeof req.body === "string") {
      fetchOptions.body = req.body;
    } else {
      fetchOptions.body = JSON.stringify(req.body);
    }
  }

  const response = await fetch(targetUrl.toString(), fetchOptions);

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    try {
      responseBody = await response.text();
    } catch {
      responseBody = null;
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: responseBody,
  };
}

/**
 * Debug proxy for OAuth flow visualization.
 * Like executeOAuthProxy but also handles SSE streams and detects old HTTP+SSE transport.
 * Used by the OAuth Debugger tab.
 */
export async function executeDebugOAuthProxy(
  req: OAuthProxyRequest,
): Promise<OAuthProxyResponse> {
  const targetUrl = validateUrl(req.url, req.httpsOnly);
  const method = req.method ?? "GET";
  const customHeaders = req.headers;

  const requestHeaders: Record<string, string> = {
    "User-Agent": "MCP-Inspector/1.0",
    ...customHeaders,
  };

  const contentType =
    customHeaders?.["Content-Type"] || customHeaders?.["content-type"];
  const isFormUrlEncoded = contentType?.includes(
    "application/x-www-form-urlencoded",
  );

  if (method === "POST" && req.body && !contentType) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const fetchOptions: RequestInit = {
    method,
    headers: requestHeaders,
  };

  if (method === "POST" && req.body) {
    if (isFormUrlEncoded && typeof req.body === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(
        req.body as Record<string, unknown>,
      )) {
        params.append(key, String(value));
      }
      fetchOptions.body = params.toString();
    } else if (typeof req.body === "string") {
      fetchOptions.body = req.body;
    } else {
      fetchOptions.body = JSON.stringify(req.body);
    }
  }

  const response = await fetch(targetUrl.toString(), fetchOptions);

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let responseBody: unknown = null;
  const contentTypeHeader = headers["content-type"] || "";

  // Handle SSE (Server-Sent Events) response
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
          events.find((e) => e.event === "message" || !e.event)?.data || null,
        rawBuffer: buffer,
      };
    } catch (error) {
      responseBody = {
        error: "Failed to parse SSE stream",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    try {
      responseBody = await response.json();
    } catch {
      try {
        responseBody = await response.text();
      } catch {
        responseBody = null;
      }
    }
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
  const metadataUrl = validateUrl(url, httpsOnly);

  const response = await fetch(metadataUrl.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "MCP-Inspector/1.0",
    },
  });

  if (!response.ok) {
    return {
      status: response.status as ContentfulStatusCode,
      statusText: response.statusText,
    };
  }

  const metadata = (await response.json()) as Record<string, unknown>;
  return { metadata };
}
