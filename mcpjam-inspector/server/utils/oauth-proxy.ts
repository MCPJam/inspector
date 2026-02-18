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
}

export interface OAuthProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

function validateUrl(url: string): URL {
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

  return targetUrl;
}

export async function executeOAuthProxy(
  req: OAuthProxyRequest,
): Promise<OAuthProxyResponse> {
  const targetUrl = validateUrl(req.url);
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

export async function fetchOAuthMetadata(
  url: string,
): Promise<{ metadata: Record<string, unknown>; status?: undefined } | { status: number; statusText: string }> {
  const metadataUrl = validateUrl(url);

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
