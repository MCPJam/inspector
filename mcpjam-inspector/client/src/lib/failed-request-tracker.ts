// Safari reports a dropped request as just "Load failed" (Chrome: "Failed to
// fetch"), usually with no stack, so an error report can't say WHICH request
// died. This remembers the last failed request so PostHog can attach it to
// the exception (see `sanitizeAnalyticsProperties` in PosthogUtils.ts).
//
// It never changes the error itself: libraries such as `is-network-error`
// match these messages exactly, and several screens show `err.message` to
// users.

export interface FailedRequest {
  method: string;
  /** Same-origin: the path. Cross-origin: the origin only. Never a query. */
  target: string;
  at: number;
}

let lastFailedRequest: FailedRequest | null = null;

export function getLastFailedRequest(): FailedRequest | null {
  return lastFailedRequest;
}

/** Returns a function that restores the original `fetch` (for tests). */
export function installFailedRequestTracker(): () => void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return () => {};
  }

  const originalFetch = window.fetch;
  window.fetch = function trackedFetch(input, init) {
    return originalFetch(input, init).catch((error: unknown) => {
      // fetch rejects with a TypeError only when the request never got a
      // response (network drop, CORS, blocker). Aborts are DOMExceptions.
      if (error instanceof TypeError) {
        lastFailedRequest = {
          method: requestMethod(input, init),
          target: requestTarget(input),
          at: Date.now(),
        };
      }
      throw error;
    });
  };

  return () => {
    window.fetch = originalFetch;
    lastFailedRequest = null;
  };
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const fromRequest =
    typeof Request !== "undefined" && input instanceof Request
      ? input.method
      : undefined;
  return (init?.method ?? fromRequest ?? "GET").toUpperCase();
}

function requestTarget(input: RequestInfo | URL): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  try {
    const url = new URL(raw, window.location.href);
    // Cross-origin URLs are user-supplied (MCP servers, OAuth endpoints) and
    // their paths can carry secrets, so only our own paths are kept.
    return url.origin === window.location.origin ? url.pathname : url.origin;
  } catch {
    return "unknown";
  }
}
