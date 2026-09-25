import { AsyncLocalStorage } from "node:async_hooks";

// Only the four hosted check routes enter this scope. Other MCP work keeps its
// existing transport lifecycle and timeouts.
export const serverCheckScope = new AsyncLocalStorage<AbortSignal>();

export function withServerCheckSignal(baseFetch: typeof fetch): typeof fetch {
  const scope = serverCheckScope.getStore();
  if (!scope) return baseFetch;
  return (input, init) => {
    scope.throwIfAborted();
    const original =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return baseFetch(input, {
      ...init,
      signal: original ? AbortSignal.any([scope, original]) : scope,
    });
  };
}
