import {
  getDefaultUserAgent,
  mcpjamUserAgent,
  setDefaultUserAgent,
} from "@mcpjam/sdk";
import { resolveAppVersion } from "./log-events.js";

/**
 * Put the app version in the User-Agent MCPJam sends to MCP and OAuth servers.
 * Without this the SDK reports its own version, which is not the one users see.
 */
export function applyInspectorUserAgent(): void {
  const version = resolveAppVersion();
  if (version) setDefaultUserAgent(mcpjamUserAgent(version));
}

/**
 * Plain `fetch` sends `node` as its User-Agent. This sends MCPJam's instead, so
 * local traffic matches hosted, unless the request already names one: the
 * user's Headers override, or an emulated OAuth client.
 *
 * `fetchFn` is looked up per call, so a stubbed global `fetch` still applies.
 */
export function withDefaultUserAgent(fetchFn?: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = (input, init) => {
    const dial = fetchFn ?? globalThis.fetch;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    if (headers.has("user-agent")) return dial(input, init);
    headers.set("user-agent", getDefaultUserAgent());
    return dial(input, { ...init, headers });
  };
  return wrapped;
}
