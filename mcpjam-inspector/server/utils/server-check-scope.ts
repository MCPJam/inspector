import { AsyncLocalStorage } from "node:async_hooks";

// Only the five hosted check routes enter this scope: doctor and validate on
// /api/web and /api/v1, and the web canvas refresh. Other MCP work keeps its
// existing transport lifecycle and timeouts.
export const serverCheckScope = new AsyncLocalStorage<AbortSignal>();

export function withServerCheckSignal(baseFetch: typeof fetch): typeof fetch {
  const scope = serverCheckScope.getStore();
  if (!scope) return baseFetch;
  return async (input, init) => {
    scope.throwIfAborted();
    const original =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return baseFetch(input, {
      ...init,
      signal: original ? AbortSignal.any([scope, original]) : scope,
    });
  };
}
