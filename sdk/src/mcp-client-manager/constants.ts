/**
 * Default values and constants for MCPClientManager
 */

import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";

/** Default client version to report to servers */
export const DEFAULT_CLIENT_VERSION = "1.0.0";

/** Default request timeout (from MCP SDK) */
export const DEFAULT_TIMEOUT = DEFAULT_REQUEST_TIMEOUT_MSEC;

/** Timeout for initial HTTP transport attempt before falling back to SSE */
export const HTTP_CONNECT_TIMEOUT = 3000;
