import {
  SdkHttpError,
  SdkErrorCode,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/client";

function isToolCall(body: RequestInit["body"]): boolean {
  if (typeof body !== "string") return false;
  try {
    return JSON.parse(body)?.method === "tools/call";
  } catch {
    return false;
  }
}

/** Preserve HTTP diagnostics before the transport discards response headers. */
export function wrapFetchForHttpErrors(
  fetchFn: typeof fetch,
  hasAuthProvider: boolean
): typeof fetch {
  return (async (input, init) => {
    const response = await fetchFn(input, init);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      method.toUpperCase() !== "POST" ||
      !isToolCall(init?.body) ||
      response.ok ||
      // HTTP 400 can carry a JSON-RPC error the transport needs to dispatch.
      response.status === 400 ||
      // The transport must handle authentication and scope retries itself.
      // It raises InsufficientScopeError for step-up even without a provider.
      (response.status === 403 &&
        extractWWWAuthenticateParams(response).error ===
          "insufficient_scope") ||
      (hasAuthProvider && (response.status === 401 || response.status === 403))
    ) {
      return response;
    }

    const text = await response.text().catch(() => null);
    const statusLine = [response.status, response.statusText]
      .filter(Boolean)
      .join(" ");
    const challenge = response.headers.get("www-authenticate");
    // Keep the wire value (seconds or HTTP date) for the caller's cooldown
    // policy. Do not retain unrelated headers or decide whether to replay here.
    const retryAfter = response.headers.get("retry-after");
    const body = text === null ? "(unreadable body)" : text || "(empty body)";
    throw new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      `Error POSTing to endpoint (HTTP ${statusLine}): ${body}${
        challenge ? `\nWWW-Authenticate: ${challenge}` : ""
      }`,
      {
        status: response.status,
        statusText: response.statusText,
        text,
        ...(retryAfter !== null ? { retryAfter } : {}),
      }
    );
  }) as typeof fetch;
}
