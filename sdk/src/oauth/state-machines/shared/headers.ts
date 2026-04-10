export function mergeHeaders(
  customHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  const keysByLowercase = new Map<string, string>();

  const applyHeaders = (headers: Record<string, string> | undefined) => {
    if (!headers) return;

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      const previousKey = keysByLowercase.get(lowerKey);

      if (previousKey && previousKey !== key) {
        delete merged[previousKey];
      }

      keysByLowercase.set(lowerKey, key);
      merged[key] = value;
    }
  };

  applyHeaders(customHeaders);
  applyHeaders(requestHeaders);

  return merged;
}

export function mergeHeadersForAuthServer(
  customHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> = {},
): Record<string, string> {
  const merged = mergeHeaders(customHeaders, requestHeaders);

  for (const key of Object.keys(merged)) {
    if (key.toLowerCase() === "authorization") {
      delete merged[key];
    }
  }

  return merged;
}

export function mergeHeadersForResourceMetadataRequest(
  serverUrl: string,
  requestUrl: string,
  customHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> = {},
): Record<string, string> {
  try {
    const serverOrigin = new URL(serverUrl).origin;
    const requestOrigin = new URL(requestUrl, serverUrl).origin;

    return requestOrigin === serverOrigin
      ? mergeHeaders(customHeaders, requestHeaders)
      : mergeHeadersForAuthServer(customHeaders, requestHeaders);
  } catch {
    return mergeHeadersForAuthServer(customHeaders, requestHeaders);
  }
}

export function normalizeHeaders(
  headers?: HeadersInit | Record<string, string>,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)]),
    );
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

export function normalizeResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}
