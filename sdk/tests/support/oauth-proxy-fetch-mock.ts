import type {
  OAuthProxyRequest,
  OAuthProxyResponse,
} from "../../src/oauth-proxy.js";

function encodeBody(
  req: OAuthProxyRequest,
  method: string
): string | undefined {
  if (method !== "POST" || req.body === undefined || req.body === null) {
    return undefined;
  }

  const headers = req.headers ?? {};
  const contentType = headers["Content-Type"] ?? headers["content-type"] ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") &&
    typeof req.body === "object"
  ) {
    return new URLSearchParams(
      Object.entries(req.body as Record<string, unknown>).map(
        ([key, value]) => [key, String(value)]
      )
    ).toString();
  }
  return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
}

function parseSseBody(text: string): Record<string, unknown> {
  const events: Array<{ event?: string; data?: unknown; id?: string }> = [];
  let current: { event?: string; data?: unknown; id?: string } = {};

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      current.event = line.substring(6).trim();
    } else if (line.startsWith("data:")) {
      const data = line.substring(5).trim();
      try {
        current.data = JSON.parse(data);
      } catch {
        current.data = data;
      }
    } else if (line.startsWith("id:")) {
      current.id = line.substring(3).trim();
    } else if (line === "" && Object.keys(current).length > 0) {
      events.push(current);
      current = {};
    }
  }

  return {
    transport: "sse",
    events,
    isOldTransport: events[0]?.event === "endpoint",
    endpoint: events[0]?.event === "endpoint" ? events[0].data : null,
    mcpResponse:
      events.find((event) => event.event === "message" || !event.event)?.data ??
      null,
    rawBuffer: "",
  };
}

/**
 * In-memory transport seam for XAA flow tests. Production pinning behavior is
 * covered by oauth-proxy.test.ts; these suites focus on state-machine behavior.
 */
export async function executeOAuthProxyViaFetch(
  req: OAuthProxyRequest
): Promise<OAuthProxyResponse> {
  const method = (req.method ?? "GET").toUpperCase();
  const response = await global.fetch(req.url, {
    method,
    headers: req.headers,
    body: encodeBody(req, method),
    redirect: req.httpsOnly ? "manual" : req.redirect ?? "follow",
    signal:
      req.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(req.timeoutMs),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const text = await response.text();
  let body: unknown = null;
  if (headers["content-type"]?.includes("text/event-stream")) {
    body = parseSseBody(text);
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    finalUrl: response.url || req.url,
  };
}
