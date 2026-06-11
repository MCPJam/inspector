/**
 * Error catalog: one entry per known error class. The single source of
 * truth for friendly title, one-line explanation, likely causes, next
 * steps, and the docs anchor every renderer deep-links to.
 *
 * Slugs are stable strings. Once published in the docs anchor URL they
 * should not change — adding a new slug is fine; renaming an existing
 * one is a docs-breaking change.
 */

export type ErrorCatalogEntry = {
  slug: string; // e.g. "jsonrpc/connection_closed"
  title: string;
  oneLine: string;
  likelyCauses: string[];
  nextSteps: string[];
  /**
   * Path on the docs site (`docs.mcpjam.com`) that this entry deep-links
   * to. Anchor matches a `<h3>` in `/troubleshooting/error-codes`.
   */
  docsAnchor: string;
  severity: "info" | "warning" | "error";
};

const DOCS_BASE = "/troubleshooting/error-codes";

function entry(
  slug: string,
  title: string,
  oneLine: string,
  likelyCauses: string[],
  nextSteps: string[],
  anchor: string,
  severity: ErrorCatalogEntry["severity"] = "error",
): ErrorCatalogEntry {
  return {
    slug,
    title,
    oneLine,
    likelyCauses,
    nextSteps,
    docsAnchor: `${DOCS_BASE}#${anchor}`,
    severity,
  };
}

export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  // --- JSON-RPC (spec) ---
  "jsonrpc/parse_error": entry(
    "jsonrpc/parse_error",
    "Parse error (-32700)",
    "The server returned a payload the client could not parse as JSON-RPC.",
    [
      "Server emitted invalid JSON on the response channel.",
      "A proxy or middleware mangled the response body.",
      "Server emitted log output on stdout instead of stderr (STDIO transport).",
    ],
    [
      "Check the server's stdout/stderr for unintended log output.",
      "Use the inspector's Traffic Log to inspect the raw response.",
    ],
    "parse-error",
  ),
  "jsonrpc/invalid_request": entry(
    "jsonrpc/invalid_request",
    "Invalid request (-32600)",
    "The server rejected the payload as not a well-formed JSON-RPC request.",
    [
      "Client sent a request shape the server's MCP runtime does not accept.",
      "Outdated server SDK that disagrees with the protocol version advertised.",
    ],
    [
      "Verify the negotiated MCP protocol version.",
      "Update the server's MCP SDK.",
    ],
    "invalid-request",
  ),
  "jsonrpc/method_not_found": entry(
    "jsonrpc/method_not_found",
    "Method not found (-32601)",
    "The server does not implement the JSON-RPC method that was called.",
    [
      "The server hasn't implemented the requested MCP method.",
      "Client and server are on incompatible MCP protocol versions.",
      "The capability you expected was not advertised in `initialize`.",
    ],
    [
      "Check the server's advertised capabilities in the connection info.",
      "Confirm the protocol version negotiated at `initialize`.",
    ],
    "method-not-found",
  ),
  "jsonrpc/invalid_params": entry(
    "jsonrpc/invalid_params",
    "Invalid params (-32602)",
    "The server rejected the request parameters.",
    [
      "Required field is missing from the call.",
      "Field type does not match the tool's input schema.",
      "Server-side validator is stricter than the published schema.",
    ],
    [
      "Re-check the tool's input schema in the Tools tab.",
      "Compare your call payload against the schema in the inspector.",
    ],
    "invalid-params",
  ),
  "jsonrpc/internal_error": entry(
    "jsonrpc/internal_error",
    "Internal error (-32603)",
    "The server hit an unexpected error while handling the request.",
    [
      "Unhandled exception inside the server's tool/resource/prompt handler.",
      "Downstream dependency (database, API) failed during the call.",
    ],
    [
      "Check the server's logs around the time of the error.",
      "Retry the request once the server is healthy.",
    ],
    "internal-error",
  ),
  "jsonrpc/connection_closed": entry(
    "jsonrpc/connection_closed",
    "Connection closed (-32000)",
    "The underlying transport closed before the response could be delivered.",
    [
      "STDIO server process exited or crashed mid-request.",
      "HTTP server dropped the streaming connection.",
      "Network blip between the inspector and the server.",
    ],
    [
      "Restart the server and reconnect.",
      "Check the server logs for a crash or exit message.",
    ],
    "connection-closed",
  ),
  "jsonrpc/request_timeout": entry(
    "jsonrpc/request_timeout",
    "Request timed out (-32001)",
    "The server did not respond within the configured request timeout.",
    [
      "Server is overloaded or stuck on the operation.",
      "Long-running tool call exceeds the inspector's per-request timeout.",
      "Network latency between client and server.",
    ],
    [
      "Increase the per-server request timeout in the Servers tab.",
      "Use MCP `tasks/*` for operations that legitimately run long.",
    ],
    "request-timeout",
  ),
  "jsonrpc/header_mismatch": entry(
    "jsonrpc/header_mismatch",
    "Protocol header mismatch (-32001)",
    "The server returned an `MCP-Protocol-Version` header that does not match what the client negotiated.",
    [
      "Server is enforcing a different protocol version than the one negotiated at `initialize`.",
      "A proxy stripped or rewrote the `MCP-Protocol-Version` header.",
    ],
    [
      "Verify the server's protocol-version pinning in the connection settings.",
      "If you set an explicit protocol version per server, ensure it matches what the server advertises.",
    ],
    "header-mismatch",
  ),
  "jsonrpc/unsupported_protocol_version": entry(
    "jsonrpc/unsupported_protocol_version",
    "Unsupported protocol version (-32004)",
    "The server does not support any protocol version this inspector offered.",
    [
      "Server pinned to a newer MCP draft your inspector build does not understand.",
      "Server pinned to a legacy version this build dropped support for.",
    ],
    [
      "Update the inspector to a newer build.",
      "Check the supported versions list in the server's `initialize` response.",
    ],
    "unsupported-protocol-version",
  ),
  "jsonrpc/url_elicitation_required": entry(
    "jsonrpc/url_elicitation_required",
    "URL elicitation required (-32042)",
    "The server needs the user to visit an external URL to complete the operation.",
    [
      "Server requested a URL elicitation (OAuth, payment, confirmation).",
      "Operation cannot proceed until the user opens the URL in a browser.",
    ],
    [
      "Open the elicited URL and complete the flow.",
      "Re-issue the request after the external step completes.",
    ],
    "url-elicitation-required",
    "warning",
  ),

  // --- Transport (Node errno + fetch) ---
  "transport/econnrefused": entry(
    "transport/econnrefused",
    "Connection refused",
    "Nothing is listening on the host and port the server URL points at.",
    [
      "Server isn't running.",
      "Port number is wrong in the server URL.",
      "Server is bound to a different interface (e.g. only `127.0.0.1` but you're connecting via the LAN IP).",
    ],
    [
      "Start the server.",
      "Double-check the URL's host and port.",
      "For Docker/containers, confirm the port is published to your host.",
    ],
    "econnrefused",
  ),
  "transport/econnreset": entry(
    "transport/econnreset",
    "Connection reset",
    "The remote side closed the TCP connection abruptly.",
    [
      "Server process crashed mid-request.",
      "Intermediate proxy or load balancer dropped the connection.",
      "Server hit an OS-level resource limit.",
    ],
    [
      "Inspect the server logs for a crash.",
      "Retry the request.",
    ],
    "econnreset",
  ),
  "transport/etimedout": entry(
    "transport/etimedout",
    "Connection timed out",
    "The OS-level TCP connection attempt did not complete in time.",
    [
      "Wrong host/port in the server URL.",
      "Firewall is silently dropping packets.",
      "Server is overloaded and never accepted the connection.",
    ],
    [
      "Verify the URL is reachable from your machine (e.g. `curl`).",
      "Check firewall / VPN rules.",
    ],
    "etimedout",
  ),
  "transport/enotfound": entry(
    "transport/enotfound",
    "Host not found",
    "DNS lookup failed for the server's hostname.",
    [
      "Hostname is misspelled in the URL.",
      "DNS resolver is misconfigured.",
      "You're offline.",
    ],
    [
      "Confirm the hostname in the URL is correct.",
      "Try resolving the host with `nslookup` or `dig`.",
    ],
    "enotfound",
  ),
  "transport/eai_again": entry(
    "transport/eai_again",
    "Temporary DNS failure",
    "DNS resolution failed with a transient error.",
    [
      "Local DNS resolver is overloaded or restarting.",
      "Upstream DNS server is briefly unavailable.",
    ],
    [
      "Wait a few seconds and retry.",
      "Switch to a different DNS resolver if this persists.",
    ],
    "eai-again",
    "warning",
  ),
  "transport/undici": entry(
    "transport/undici",
    "HTTP transport error",
    "The underlying HTTP client (undici / fetch) reported a low-level transport failure.",
    [
      "Server closed the connection mid-response.",
      "TLS handshake failed.",
      "Socket-level error during streaming.",
    ],
    [
      "Inspect the Traffic Log for the failed request.",
      "Verify the server's TLS certificate is valid.",
    ],
    "undici-transport-error",
  ),
  "transport/fetch_failed": entry(
    "transport/fetch_failed",
    "Fetch failed",
    "The HTTP request never produced a response.",
    [
      "Server is unreachable (offline, wrong URL, blocked by firewall).",
      "TLS handshake failed (self-signed cert, expired cert).",
      "Mixed-content block (HTTPS page calling HTTP endpoint in browser).",
    ],
    [
      "Open the URL in a browser to confirm it loads.",
      "If self-signed, install the certificate or switch to a trusted one.",
    ],
    "fetch-failed",
  ),
  "transport/socket_hang_up": entry(
    "transport/socket_hang_up",
    "Socket hang up",
    "The server closed the connection without sending a response.",
    [
      "Server crashed or restarted during the request.",
      "Reverse proxy timed the request out.",
    ],
    [
      "Retry the request.",
      "Check server-side logs for the crash.",
    ],
    "socket-hang-up",
  ),

  // --- Auth ---
  "auth/http_401": entry(
    "auth/http_401",
    "Unauthorized (401)",
    "The server requires authentication that wasn't provided or is no longer valid.",
    [
      "Missing or expired bearer token.",
      "OAuth access token expired and refresh failed.",
      "Server changed its required authentication scheme.",
    ],
    [
      "Re-authenticate using the Reconnect button on the server card.",
      "If using OAuth, run through the OAuth flow again from Servers.",
    ],
    "unauthorized-401",
  ),
  "auth/http_403": entry(
    "auth/http_403",
    "Forbidden (403)",
    "You authenticated successfully but lack permission for the operation.",
    [
      "OAuth scopes granted don't cover the requested operation.",
      "Server-side ACL blocks this account.",
    ],
    [
      "Re-run OAuth and request the additional scopes if the server allows.",
      "Ask the server admin to grant the necessary permissions.",
    ],
    "forbidden-403",
  ),
  "auth/oauth_refresh_failed": entry(
    "auth/oauth_refresh_failed",
    "OAuth token refresh failed",
    "An expired OAuth access token could not be refreshed.",
    [
      "Refresh token was revoked.",
      "Refresh token expired.",
      "Server returned `invalid_grant` to the refresh attempt.",
    ],
    [
      "Click Reconnect on the server card to run a fresh OAuth flow.",
    ],
    "oauth-refresh-failed",
  ),
  "auth/missing_bearer": entry(
    "auth/missing_bearer",
    "Missing bearer token",
    "The API call did not include the required `Authorization: Bearer ...` header.",
    [
      "Inspector session expired.",
      "Sign-in token failed to attach to the request.",
    ],
    [
      "Refresh the page and sign in again.",
    ],
    "missing-bearer",
  ),

  // --- OAuth ---
  "oauth/invalid_grant": entry(
    "oauth/invalid_grant",
    "OAuth: invalid grant",
    "The OAuth server rejected the authorization code or refresh token.",
    [
      "Authorization code was already redeemed.",
      "Refresh token was revoked.",
      "Authorization code expired (typical lifetime ~60s).",
    ],
    [
      "Start the OAuth flow again from the server card.",
    ],
    "oauth-invalid-grant",
  ),
  "oauth/invalid_client": entry(
    "oauth/invalid_client",
    "OAuth: invalid client",
    "The OAuth server does not recognize the client credentials.",
    [
      "Client was deleted on the authorization server.",
      "Dynamic registration cache is stale.",
      "`client_id` was rotated server-side.",
    ],
    [
      "Re-register the client (Reconnect from the server card triggers DCR if supported).",
    ],
    "oauth-invalid-client",
  ),
  "oauth/redirect_mismatch": entry(
    "oauth/redirect_mismatch",
    "OAuth: redirect URI mismatch",
    "The redirect URI in the request does not match the one registered with the OAuth server.",
    [
      "Authorization server requires the inspector's callback URL to be registered explicitly.",
      "Server's allow-list is wrong.",
    ],
    [
      "Add the inspector's callback URL to the OAuth server's allowed redirects.",
      "Verify the inspector's base URL hasn't changed.",
    ],
    "oauth-redirect-mismatch",
  ),
  "oauth/well_known_unreachable": entry(
    "oauth/well_known_unreachable",
    "OAuth metadata unreachable",
    "The OAuth `.well-known` discovery endpoint could not be fetched.",
    [
      "Authorization server is down.",
      "Wrong issuer URL.",
      "CORS blocks the discovery request from the browser.",
    ],
    [
      "Confirm the issuer URL in the server config.",
      "Open the `.well-known/openid-configuration` (or `oauth-authorization-server`) URL in a browser.",
    ],
    "oauth-well-known-unreachable",
  ),

  // --- Inspector sentinels (SDK-specific) ---
  "sdk/not_yet_supported_in_stateless": entry(
    "sdk/not_yet_supported_in_stateless",
    "Operation not supported on stateless transport",
    "The inspector's stateless HTTP transport does not yet implement this MCP operation.",
    [
      "Operation requires a server-initiated channel (subscriptions, MRTR) the stateless preview transport hasn't wired up yet.",
    ],
    [
      "Switch the server to the legacy stateful transport in its protocol-mode toggle.",
    ],
    "not-yet-supported-in-stateless",
    "warning",
  ),
  "sdk/stateless_requires_http": entry(
    "sdk/stateless_requires_http",
    "Stateless transport requires HTTP",
    "Stateless mode can only be used with an HTTP-transport server, not STDIO.",
    [
      "You enabled the stateless protocol toggle on a stdio server.",
    ],
    [
      "Disable the stateless toggle for stdio servers.",
    ],
    "stateless-requires-http",
  ),
  "sdk/paginated_tool_header_discovery_unsupported": entry(
    "sdk/paginated_tool_header_discovery_unsupported",
    "Paginated tool discovery not supported with header overrides",
    "Paginated tools discovery cannot run alongside per-request header overrides on this transport.",
    [
      "Conflicting combination of progressive tool discovery + per-server header overrides.",
    ],
    [
      "Disable progressive tool discovery for this server, or move headers into the server config.",
    ],
    "paginated-tool-header-discovery-unsupported",
    "warning",
  ),

  // --- Provider / sampling ---
  "provider/invalid_tool_name": entry(
    "provider/invalid_tool_name",
    "Provider rejected the tool name",
    "An LLM provider rejected a tool name (Anthropic's strict tool-name validator is the most common source).",
    [
      "Tool name contains characters or length the provider does not allow.",
      "Two attached servers expose tools whose namespaced names collide after sanitization.",
    ],
    [
      "Rename the offending tool on the server.",
      "Detach one of the colliding servers from the chat surface.",
    ],
    "provider-invalid-tool-name",
  ),
  "provider/auth_error": entry(
    "provider/auth_error",
    "Provider authentication error",
    "Your LLM provider rejected the API key for this request.",
    [
      "Key is missing.",
      "Key is invalid or revoked.",
      "Key is for a different environment (project, region).",
    ],
    [
      "Add or update your API key under Settings → LLM Providers.",
      "Verify the key in the provider's dashboard.",
    ],
    "provider-auth-error",
  ),
  "provider/quota": entry(
    "provider/quota",
    "Provider quota / rate limit",
    "Your LLM provider rejected the request because you hit a rate limit or quota.",
    [
      "Daily/monthly quota exhausted.",
      "Per-minute rate limit exceeded.",
      "Free tier limits hit.",
    ],
    [
      "Wait for the limit window to reset.",
      "Upgrade your provider plan.",
      "Switch to a different provider in Settings.",
    ],
    "provider-quota",
    "warning",
  ),

  // --- Internal / unknown ---
  "internal/unknown": entry(
    "internal/unknown",
    "Unknown error",
    "An error occurred that the inspector could not classify.",
    [
      "Unhandled error path.",
      "New error class the inspector hasn't been taught about yet.",
    ],
    [
      "Open the details panel and copy the raw message.",
      "File an issue with the raw message so we can add it to the catalog.",
    ],
    "unknown-error",
  ),
};

export type ErrorCatalogSlug = keyof typeof ERROR_CATALOG;
