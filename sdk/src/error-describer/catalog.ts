/**
 * Error catalog: one entry per known error class. The single source of
 * truth for friendly title, one-line explanation, likely causes, next
 * steps, and the docs anchor every renderer deep-links to.
 *
 * Slugs are stable strings. Once published in the docs anchor URL they
 * should not change — adding a new slug is fine; renaming an existing
 * one is a docs-breaking change.
 */

/**
 * Who has to act — NOT a blame label.
 *
 * MCPJam is a debugger: pointing it at a broken server is the product
 * working, not an incident. This field exists so a failure that belongs to
 * the user's server or the user's configuration can be shown to them clearly
 * while never paging the MCPJam team, and so the failures that ARE ours stop
 * being lost in that noise.
 *
 * - `user_server`  — we reached the user's server (or its authorization
 *                    server) and it failed, refused, or answered wrongly.
 * - `user_config`  — the inputs we were given are wrong or incomplete: URL,
 *                    credentials, transport, capability toggles.
 * - `mcpjam`       — MCPJam's own code or infrastructure.
 * - `ambiguous`    — the evidence does not settle it. Deliberately distinct
 *                    from `mcpjam`: consumers surface these without paging.
 *
 * Some slugs are genuinely undecidable between the two `user_*` values — a
 * refused port is "nothing is running there" or "wrong port", and the wire
 * cannot tell you which. Nothing downstream depends on separating them:
 * capture policy treats both as never-page, and user-facing copy comes from
 * this entry's own `oneLine` / `likelyCauses` / `nextSteps`, which already
 * state the ambiguity in words. Do NOT write user-facing prose off `origin`.
 */
export type ErrorOrigin = "user_server" | "user_config" | "mcpjam" | "ambiguous";

export type ErrorCatalogEntry = {
  slug: string; // e.g. "jsonrpc/connection_closed"
  title: string;
  oneLine: string;
  /**
   * The count carries meaning: several entries say the evidence does not
   * settle which one it was, one entry says we know. The error card labels
   * the section "Likely causes" or "Why this happened" off that, so never pad
   * a known cause out to a list — it makes the product read as unsure of its
   * own state.
   */
  likelyCauses: string[];
  nextSteps: string[];
  /**
   * Path on the docs site (`docs.mcpjam.com`) that this entry deep-links
   * to. Anchor matches a `<h3>` in `/troubleshooting/error-codes`.
   */
  docsAnchor: string;
  severity: "info" | "warning" | "error";
  /**
   * Optional in the type because `ErrorCatalogEntry` is published and an
   * external caller may still construct one; required in practice — a test
   * asserts every catalog slug carries an origin. Read it through
   * `originOf()`, which defaults a missing value to `ambiguous`.
   */
  origin?: ErrorOrigin;
};

const DOCS_BASE = "/troubleshooting/error-codes";

/**
 * Origin per slug, kept as one table rather than a field threaded through 34
 * call sites: the whole taxonomy is the thing that needs reviewing, and it is
 * only reviewable when it can be read at once.
 *
 * A slug missing from this table fails the catalog test.
 */
const ERROR_ORIGINS: Record<string, ErrorOrigin> = {
  // --- The server answered, and the answer was the problem -----------------
  // This is a server-side error only when the wire evidence identifies the
  // server as the failing boundary. Keep protocol codes that can also be
  // caused by the client or transport out of this bucket.
  "jsonrpc/internal_error": "user_server",
  // Parse errors, missing methods, invalid params, and unsupported versions
  // are direction-dependent protocol signals. A client can send malformed
  // JSON, call an unadvertised method, or request a version the server does
  // not support, so the slug alone cannot identify who must act.
  "jsonrpc/parse_error": "ambiguous",
  "jsonrpc/method_not_found": "ambiguous",
  "jsonrpc/invalid_params": "ambiguous",
  "jsonrpc/unsupported_protocol_version": "ambiguous",
  // A provider may reject a server-supplied name, but a host-side namespace
  // collision or sanitization bug is MCPJam's responsibility.
  "provider/invalid_tool_name": "ambiguous",
  // Discovery can fail because of server metadata, a wrong configured issuer,
  // CORS, or the network. The slug does not settle that boundary.
  "oauth/well_known_unreachable": "ambiguous",
  // A peer, proxy, or local transport can all produce this symptom.
  "transport/socket_hang_up": "ambiguous",

  // --- What we were told to connect to, or with, was wrong -----------------
  "transport/econnrefused": "user_config",
  "transport/enotfound": "user_config",
  "auth/http_401": "user_config",
  "auth/http_403": "user_config",
  "auth/missing_bearer": "user_config",
  // Default only. A refresh failure on a credential MCPJam itself holds is
  // ours — callers pass `credentialOwner: "mcpjam"` to say so.
  "auth/oauth_refresh_failed": "user_config",
  "oauth/invalid_client": "user_config",
  "oauth/invalid_grant": "user_config",
  "oauth/redirect_mismatch": "user_config",
  // Same default/override pair: a managed key hitting an auth or quota wall
  // is MCPJam's account problem, a BYO key is the user's.
  "provider/auth_error": "user_config",
  "provider/quota": "user_config",
  // Deliberately NOT credential-owned: MCPJam holds the key, but a spent
  // allowance is an account state the user resolves, never an outage of ours.
  "provider/mcpjam_limit": "user_config",
  "provider/mcpjam_limit_daily": "user_config",
  "provider/mcpjam_limit_monthly": "user_config",
  // "Enable the required client capability in the connection's Client
  // settings" — a toggle the user owns.
  "jsonrpc/missing_required_client_capability": "user_config",
  // Not a failure at all: the server is asking the user to go open a URL.
  "jsonrpc/url_elicitation_required": "user_config",
  // Despite the `sdk/` namespace, this one is a misconfiguration: "you
  // enabled the stateless protocol toggle on a stdio server".
  "sdk/stateless_requires_http": "user_config",
  // Same shape, and the reason this slug exists at all: the failure is a
  // version PIN meeting a server that doesn't offer it, and the pin is a
  // setting the user (or the host profile they picked) owns. Classifying it
  // `ambiguous` would be defensible from the wire alone — but the wire is not
  // all we have here, because MCPJam chose the pin, so the boundary is known.
  "sdk/protocol_version_pin_unsupported": "user_config",

  // --- Ours ----------------------------------------------------------------
  "sdk/not_yet_supported_in_stateless": "mcpjam",
  "sdk/paginated_tool_header_discovery_unsupported": "mcpjam",

  // --- Not settled by the evidence ----------------------------------------
  // Either peer can drop a connection or run out of time.
  "jsonrpc/connection_closed": "ambiguous",
  "jsonrpc/request_timeout": "ambiguous",
  "transport/etimedout": "ambiguous",
  "transport/econnreset": "ambiguous",
  "transport/eai_again": "ambiguous",
  "transport/fetch_failed": "ambiguous",
  "transport/undici": "ambiguous",
  // -32600 and a protocol-version header mismatch are envelope-level: MCPJam
  // builds that envelope, so a systematic serialization bug of ours would
  // land here. Marking them `user_server` would make exactly the class of
  // MCPJam bug that affects every user the one class we never see.
  "jsonrpc/invalid_request": "ambiguous",
  "jsonrpc/header_mismatch": "ambiguous",
  // Unclassifiable. NOT `mcpjam`: this is where every unrecognized failure
  // from an arbitrary user server lands, and paging on it would rebuild the
  // noise problem this field exists to remove. Callers that know the failure
  // happened on an internal boundary escalate it themselves.
  "internal/unknown": "ambiguous",
};

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
    ...(ERROR_ORIGINS[slug] ? { origin: ERROR_ORIGINS[slug] } : {}),
  };
}

export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  // --- JSON-RPC (spec) ---
  "jsonrpc/parse_error": entry(
    "jsonrpc/parse_error",
    "Parse error (-32700)",
    "The MCP wire contained JSON the inspector could not parse as JSON-RPC.",
    [
      "The server emitted invalid JSON on the response channel.",
      "A proxy or middleware mangled the response body.",
      "Server emitted log output on stdout instead of stderr (STDIO transport).",
      "The inspector sent malformed JSON and the server returned a parse error.",
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
    "Protocol header mismatch (-32020)",
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
    "Unsupported protocol version (-32022)",
    "The server does not support any protocol version this inspector offered.",
    [
      "Server pinned to a newer MCP draft your inspector build does not understand.",
      "Server pinned to a legacy version this build dropped support for.",
    ],
    [
      "Update the inspector to a newer build.",
      "Check the supported versions list in the server's `server/discover` result (modern) or `initialize` response (legacy).",
    ],
    "unsupported-protocol-version",
  ),
  "jsonrpc/missing_required_client_capability": entry(
    "jsonrpc/missing_required_client_capability",
    "Missing required client capability (-32021)",
    "The server refused the request because the client did not advertise a capability the operation requires.",
    [
      "A server-initiated input request (elicitation, sampling) needs a client capability MCPJam did not declare.",
      "The connection advertised a capability set the server considers insufficient for this operation.",
    ],
    [
      "Enable the required client capability in the connection's Client settings.",
      "Check the server's documentation for which client capabilities it requires.",
    ],
    "missing-required-client-capability",
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
  "sdk/protocol_version_pin_unsupported": entry(
    "sdk/protocol_version_pin_unsupported",
    "Server doesn't support the pinned protocol version",
    "This connection is pinned to one MCP protocol version, and the server does not offer it.",
    [
      "The client profile you're emulating pins a protocol version this server hasn't adopted — a host set to the latest revision against a server that still speaks a 2025 one.",
      "A per-server protocol override left pinned to a version the server dropped or never shipped.",
    ],
    [
      "Set the protocol version to Automatic to negotiate whatever the server does support.",
      "Or pick the version the server advertises — `server/discover` (modern) or the `initialize` response (legacy) lists them.",
    ],
    "protocol-version-pin-unsupported",
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
  // The backend refuses on one of two allowances and says which in its own
  // copy, so these are two slugs rather than one that lists both and makes the
  // reader pick. The unlabelled slug below stays as the net for copy that
  // names no period.
  "provider/mcpjam_limit_daily": entry(
    "provider/mcpjam_limit_daily",
    "Daily MCPJam limit reached",
    "This account's free daily MCPJam allowance is spent. It resets tomorrow.",
    [
      "Chat, evals and swarm generation all draw on one daily bucket, shared across the organization.",
    ],
    [
      "Top up credits or upgrade the plan — the limit dialog offers both.",
      "Wait for the daily allowance to reset.",
      // Named precisely because the generic advice costs people an afternoon:
      // a swarm's generation and persona-driver calls are platform-billed and
      // have no BYOK path, so adding a key does nothing for them.
      "Add your own key under Settings → LLM Providers for CHAT. Swarm generation and persona turns are always MCPJam-billed.",
    ],
    "mcpjam-model-limit-reached",
    "warning",
  ),
  "provider/mcpjam_limit_monthly": entry(
    "provider/mcpjam_limit_monthly",
    "Monthly MCPJam credits spent",
    "This team's monthly MCPJam credits are spent for the current billing period.",
    [
      "Team plans draw on one monthly per-seat allowance instead of the daily bucket, and it renews when the billing period does.",
    ],
    [
      "Top up credits or upgrade the plan — the limit dialog offers both.",
      "Wait for the billing period to renew.",
      "Add your own key under Settings → LLM Providers for CHAT. Swarm generation and persona turns are always MCPJam-billed.",
    ],
    "mcpjam-model-limit-reached",
    "warning",
  ),
  "provider/mcpjam_limit": entry(
    "provider/mcpjam_limit",
    "MCPJam model limit reached",
    "This account's MCPJam model allowance is spent, so the call was refused before it reached a provider.",
    [
      "Chat, evals and swarm generation all draw on the same MCPJam allowance.",
    ],
    [
      "Top up credits or upgrade the plan — the limit dialog offers both.",
      "Wait for the allowance to reset.",
      "Add your own key under Settings → LLM Providers for CHAT. Swarm generation and persona turns are always MCPJam-billed.",
    ],
    "mcpjam-model-limit-reached",
    "warning",
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
