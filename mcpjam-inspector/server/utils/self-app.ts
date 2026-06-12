/**
 * Self-dispatch seam for in-process calls to the server's own HTTP surface.
 *
 * `createHonoApp` registers the app's `fetch` here so route-layer factories
 * (the mcpjam workspace built-in tools' `PlatformApiClient`) can call the
 * server's own `/api/v1` without a network hop — the synthesized Request
 * runs the full middleware chain (body limit, bearer auth, guest rejection)
 * exactly as an external API caller would.
 *
 * Last app registered wins. The production entries build exactly one app;
 * unit tests that need the client inject their own `fetch` instead of
 * relying on this seam.
 */
export type SelfFetch = (request: Request) => Response | Promise<Response>;

let selfFetch: SelfFetch | null = null;

export function registerSelfFetch(fn: SelfFetch): void {
  selfFetch = fn;
}

export function getSelfFetch(): SelfFetch | null {
  return selfFetch;
}
