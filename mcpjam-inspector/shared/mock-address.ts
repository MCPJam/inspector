/**
 * Where a mock server lives. Its saved row carries a placeholder address that
 * never resolves (the backend refuses that host on any other row), and a
 * client outside MCPJam reaches the mock at this Inspector's own route. Pure
 * strings, so the server and the exported eval code share one definition.
 */

export const MOCK_PLACEHOLDER_HOST = "mock.mcpjam.invalid";
export const MOCK_ROUTE_PREFIX = "/api/web/mock-mcp";

/** The mock id in a saved mock's placeholder address, or undefined for any other URL. */
export function mockIdFromPlaceholderUrl(url: string | URL): string | undefined {
  try {
    const parsed = new URL(String(url));
    if (parsed.hostname !== MOCK_PLACEHOLDER_HOST) return undefined;
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) || undefined;
  } catch {
    return undefined;
  }
}

/** The address of a mock's route on the Inspector at `baseUrl`. */
export function mockRouteAddress(baseUrl: string, mockId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${MOCK_ROUTE_PREFIX}/${encodeURIComponent(mockId)}`;
}

/** The feature flag the backend answers for every mock surface. */
export const MOCK_SERVERS_FLAG = "mock-servers-enabled";
