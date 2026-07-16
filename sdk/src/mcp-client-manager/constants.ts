/**
 * Default values and constants for MCPClientManager
 */

import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/client";

/** Default client version to report to servers */
export const DEFAULT_CLIENT_VERSION = "1.0.0";

/** Default request timeout (from MCP SDK) */
export const DEFAULT_TIMEOUT = DEFAULT_REQUEST_TIMEOUT_MSEC;

/** Timeout for initial HTTP transport attempt before falling back to SSE */
export const HTTP_CONNECT_TIMEOUT = 3000;

/**
 * Default extra time budget granted to a `tools/call` while elicitations are
 * pending for that server (see `MCPClientManagerOptions.elicitationTimeoutExtensionMs`).
 * Human-scale: a person has to read a dialog and answer it.
 */
export const DEFAULT_ELICITATION_TIMEOUT_EXTENSION_MS = 10 * 60 * 1000;
