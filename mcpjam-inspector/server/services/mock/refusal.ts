/**
 * Every refusal the mock route gives is a JSON-RPC error: the hosted fetch
 * blanks any other error body, and a client outside MCPJam reads this one. A
 * message says what failed and what to do next, and names no address, token
 * or anything of the real server.
 */

const REFUSALS = {
  unauthorized: [401, -32013, "mock_unauthorized", "MCPJam did not accept this credential. Send your own MCPJam API key as the bearer token."],
  grant_over_http: [401, -32013, "mock_grant_not_accepted", "A mock's grant opens nothing over HTTP. Send your own MCPJam API key as the bearer token."],
  grant_expired: [401, -32013, "mock_grant_expired", "This mock's grant has expired. Connect again to get a new one."],
  guest: [403, -32014, "mock_guest_refused", "Mock servers are not available to guest sessions. Sign in and send your own MCPJam API key as the bearer token."],
  forbidden: [403, -32014, "mock_forbidden", "This credential cannot open this mock server. Use a key for a project that holds it."],
  not_found: [404, -32015, "mock_not_found", "This mock server was not found. Check its id, and that it was not deleted."],
  rate_limited: [429, -32016, "mock_rate_limited", "Too many requests to this mock server. Wait a minute, then try again."],
  unavailable: [503, -32017, "mock_unavailable", "MCPJam could not check this mock server just now. Try again in a moment."],
  paused: [503, -32019, "mock_serving_paused", "MCPJam has paused mock servers. Try again in a few minutes; your own servers are not affected."],
  invalid_definition: [500, -32018, "mock_definition_unreadable", "This mock server's saved definition could not be read. Save the mock again from MCPJam."],
} as const;

export type MockRefusalKind = keyof typeof REFUSALS;

/** A refusal raised inside the route and turned into a response at its edge. */
export class MockRefusal extends Error {
  constructor(readonly kind: MockRefusalKind) {
    super(REFUSALS[kind][3]);
    this.name = "MockRefusal";
  }
}

/** How long a client is told to wait while mocks are paused. */
const PAUSED_RETRY_AFTER_SECONDS = 60;

export function mockRefusalResponse(
  kind: MockRefusalKind,
  options: { retryAfterSeconds?: number; message?: string } = {},
): Response {
  const [status, code, mockCode, message] = REFUSALS[kind];
  const headers = new Headers({ "content-type": "application/json" });
  const retryAfter = options.retryAfterSeconds ?? (kind === "paused" ? PAUSED_RETRY_AFTER_SECONDS : undefined);
  if (retryAfter !== undefined) {
    headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfter))));
  }
  const error = { code, message: options.message ?? message, data: { mockCode } };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error }), { status, headers });
}
