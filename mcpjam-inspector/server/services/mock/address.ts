/**
 * The address a client outside MCPJam dials to reach a mock: this
 * Inspector's own public base URL plus the mock route. `get_mock_server`
 * returns it with an API-key hint.
 */
import { mockRouteAddress } from "../../../shared/mock-address.js";
import { HOSTED_MODE, LOCAL_SERVER_ADDR } from "../../config.js";
import { configuredInspectorPublicUrl } from "../../utils/inspector-public-url.js";

/**
 * The origin a client reaches this Inspector at: the configured public URL
 * (hosted, or `npx` behind a tunnel), else the local server's own origin.
 * Never read from a request, so a caller cannot choose the address it is told.
 */
export function mockServerBaseUrl(): string {
  const configured = configuredInspectorPublicUrl();
  if (configured) return configured.replace(/\/+$/, "");
  return HOSTED_MODE ? "" : LOCAL_SERVER_ADDR;
}

/** The mock's address, or null on a hosted deployment that configures no public URL. */
export function mockServerAddress(
  mockId: string,
  baseUrl: string = mockServerBaseUrl(),
): string | null {
  return baseUrl ? mockRouteAddress(baseUrl, mockId) : null;
}
