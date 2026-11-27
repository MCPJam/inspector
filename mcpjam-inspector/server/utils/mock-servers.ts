/**
 * How a saved mock is dialed. The saved row carries a placeholder address that
 * resolves nowhere (the backend refuses that host on any other row), so every
 * dialer of a saved server swaps it for the mock route's address and presents
 * the caller's own bearer, which the route checks with the backend on each
 * request.
 */
import type { MCPServerConfig } from "@mcpjam/sdk";
import { mockIdFromPlaceholderUrl } from "../../shared/mock-address.js";
import { mockServerAddress } from "../services/mock/address.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

/** True when `url` is a mock's placeholder address. */
export function isMockAddress(url: string | undefined): boolean {
  return url !== undefined && mockIdFromPlaceholderUrl(url) !== undefined;
}

/**
 * `config` (built for any HTTP server) pointed at the mock route, carrying
 * `bearerToken`. Anything else is returned as it is.
 */
export function pointAtMockRoute<T extends MCPServerConfig>(
  config: T,
  bearerToken: string | undefined,
): T {
  const mockId = "url" in config ? mockIdFromPlaceholderUrl(String(config.url)) : undefined;
  if (mockId === undefined) return config;
  const address = mockServerAddress(mockId);
  if (!address) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "This MCPJam deployment has no public address, so it cannot serve mock servers. Set the public URL, or open the mock from the hosted app.",
    );
  }
  const headers: Record<string, string> = {};
  new Headers(config.requestInit?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return {
    ...config,
    url: address,
    requestInit: { ...config.requestInit, headers },
    // The route speaks Streamable HTTP only.
    preferSSE: false,
    disableSseFallback: true,
  };
}
