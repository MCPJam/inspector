/**
 * Every refusal the mock route gives is a JSON-RPC error: the hosted fetch
 * blanks any other error body, and a client outside MCPJam reads this one. A
 * message says what failed and what to do next, and names no address, token
 * or anything of the real server.
 */
import { MOCK_SERVERS_FLAG } from "../../../shared/mock-address.js";

const REFUSALS = {
  unauthorized: [401, -32013, "mock_unauthorized", "MCPJam did not accept this credential. Send your own MCPJam API key as the bearer token."],
  grant_over_http: [401, -32013, "mock_grant_not_accepted", "A mock's grant opens nothing over HTTP. Send your own MCPJam API key as the bearer token."],
  grant_expired: [401, -32013, "mock_grant_expired", "This mock's grant has expired. Connect again to get a new one."],
  guest: [403, -32014, "mock_guest_refused", "Mock servers are not available to guest sessions. Sign in and send your own MCPJam API key as the bearer token."],
  forbidden: [403, -32014, "mock_forbidden", "This credential cannot open this mock server. Check that it belongs to the project that holds the mock, or ask the project's owner for access."],
  not_found: [404, -32015, "mock_not_found", "This mock server was not found. Check its id, and that it was not deleted."],
  rate_limited: [429, -32016, "mock_rate_limited", "Too many requests to this mock server. Wait a minute, then try again."],
  unavailable: [503, -32017, "mock_unavailable", "MCPJam could not check this mock server just now. Try again in a moment."],
  invalid_definition: [500, -32018, "mock_definition_unreadable", "This mock server's saved definition could not be read. Save the mock again from MCPJam."],
  flag_off: [403, -32020, "mock_servers_disabled", `Mock servers are turned off for this account (the ${MOCK_SERVERS_FLAG} flag is off). Ask an MCPJam admin to turn it on, then try again.`],
  // A test run's URL is only good while the run is open and at its current epoch.
  run_closed: [410, -32023, "mock_run_closed", "This test run was closed. Open a new run and connect to its URL."],
  run_expired: [410, -32023, "mock_run_expired", "This test run expired (a run lasts 24 hours). Open a new run and connect to its URL."],
  run_not_found: [404, -32023, "mock_run_not_found", "This test run was not found. Check the run URL, or open a new run and connect to its URL."],
  run_forbidden: [403, -32023, "mock_run_forbidden", "This test run was opened by someone else, and only they can use it. Open your own run and connect to its URL."],
  run_stale_epoch: [409, -32023, "mock_run_reset", "This test run was reset after this URL was issued. Connect to the run's current URL, which the reset call returned."],
  run_url_invalid: [400, -32023, "mock_run_url_invalid", "This run URL is incomplete: it needs both a run and an epoch. Use the URL that opening or resetting the run returned."],
} as const;

export type MockRefusalKind = keyof typeof REFUSALS;

/** What a refused caller can act on depends on whether it holds a key or is signed in. */
function forbiddenMessage(authMethod: string | undefined): string | undefined {
  if (authMethod === "workos_api_key") {
    return "This API key's project does not hold this mock server. Use a key for the project that holds it.";
  }
  if (authMethod === "authkit_jwt" || authMethod === "workos_agent") {
    return "You do not have access to this mock server's project. Ask the project's owner to add you, then try again.";
  }
  return undefined;
}

/**
 * What the two sign-in refusals say to a person using MCPJam itself, where
 * "send your API key" is not something they can do.
 */
export const IN_APP_REFUSAL_MESSAGES: Partial<Record<MockRefusalKind, string>> = {
  unauthorized: "MCPJam could not confirm your sign-in. Sign in again, then reconnect this mock server.",
  guest: "Mock servers are not available to guest sessions. Sign in, then reconnect this mock server.",
};

/** A refusal raised inside the route and turned into a response at its edge. */
export class MockRefusal extends Error {
  constructor(readonly kind: MockRefusalKind) {
    super(REFUSALS[kind][3]);
    this.name = "MockRefusal";
  }
}

export function mockRefusalResponse(
  kind: MockRefusalKind,
  options: { retryAfterSeconds?: number; message?: string; authMethod?: string } = {},
): Response {
  const [status, code, mockCode, message] = REFUSALS[kind];
  const headers = new Headers({ "content-type": "application/json" });
  if (options.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(Math.max(1, Math.ceil(options.retryAfterSeconds))));
  }
  const text = options.message ?? (kind === "forbidden" ? forbiddenMessage(options.authMethod) : undefined) ?? message;
  const error = { code, message: text, data: { mockCode } };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error }), { status, headers });
}
