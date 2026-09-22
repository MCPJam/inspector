/**
 * Cleanup ownership, and the retirement of the legacy callback exchange.
 *
 * Two related problems lived here.
 *
 * `clearOAuthData(serverName)` cleared the per-server keys but never the global
 * `mcp-oauth-pending` marker, so a stale marker survived cleanup and a later
 * callback could still find a server name with no flow session behind it —
 * which is exactly the state that reached the legacy `exchangeAuthorization`
 * branch. That branch was a second, era-blind wire implementation: it
 * rediscovered metadata and redeemed the code itself, skipping the era machine,
 * the callback-state checks it does, resource binding, and issuer policy.
 *
 * The marker is global, so cleanup for server A must never strand an active
 * transaction for server B — it is removed only when it names the server being
 * cleaned.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTrack = vi.fn();
vi.mock("@/lib/analytics", () => ({ track: mockTrack }));

// The whole point of retiring the legacy exchange is that this path redeems
// NOTHING. Asserting only the error message would pass a regression that
// re-added a token request and happened to reuse the same copy, so watch both
// network seams directly.
const mockAuthFetch = vi.fn(() => {
  throw new Error("no request may be made on the no-session recovery path");
});
vi.mock("@/lib/session-token", () => ({ authFetch: mockAuthFetch }));

const directFetch = vi.fn(() => {
  throw new Error("no request may be made on the no-session recovery path");
});
window.fetch = directFetch as unknown as typeof fetch;

/**
 * Every `mcp-*` key an OAuth flow writes for one server.
 *
 * Enumerated rather than pattern-matched: the point is that adding a new
 * per-server key without adding it to `clearOAuthData` fails here, and a
 * prefix scan of "whatever happens to be in storage" would not catch that.
 */
const PER_SERVER_KEYS = (serverName: string) => [
  `mcp-tokens-${serverName}`,
  `mcp-client-${serverName}`,
  `mcp-verifier-${serverName}`,
  `mcp-oauth-issued-state-${serverName}`,
  `mcp-serverUrl-${serverName}`,
  `mcp-oauth-config-${serverName}`,
  `mcp-oauth-binding-${serverName}`,
  `mcp-discovery-${serverName}`,
  `mcp-oauth-flow-state-${serverName}`,
  `mcp-oauth-trace-${serverName}`,
];

function seedServer(serverName: string) {
  for (const key of PER_SERVER_KEYS(serverName)) {
    localStorage.setItem(key, JSON.stringify({ seeded: serverName }));
  }
  sessionStorage.setItem(
    `mcp-oauth-session-trace-${serverName}`,
    JSON.stringify({ version: 1, steps: [], httpHistory: [] }),
  );
}

describe("clearOAuthData owns the full per-server key list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("removes every per-server key it is responsible for", async () => {
    const { clearOAuthData } = await import("../mcp-oauth");
    seedServer("alpha");

    clearOAuthData("alpha");

    for (const key of PER_SERVER_KEYS("alpha")) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
    expect(
      sessionStorage.getItem("mcp-oauth-session-trace-alpha"),
    ).toBeNull();
  });

  it("removes the global pending marker when it names this server", async () => {
    const { clearOAuthData } = await import("../mcp-oauth");
    seedServer("alpha");
    localStorage.setItem("mcp-oauth-pending", "alpha");

    clearOAuthData("alpha");

    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
  });

  // The cross-tab / two-server shape. Server B has an authorization in flight;
  // cleaning up A must not strand it.
  it("preserves an active pending marker belonging to another server", async () => {
    const { clearOAuthData } = await import("../mcp-oauth");
    seedServer("alpha");
    seedServer("beta");
    localStorage.setItem("mcp-oauth-pending", "beta");

    clearOAuthData("alpha");

    expect(localStorage.getItem("mcp-oauth-pending")).toBe("beta");
    for (const key of PER_SERVER_KEYS("beta")) {
      expect(localStorage.getItem(key), key).not.toBeNull();
    }
  });
});

describe("the pending marker has one name", () => {
  // Two modules read the marker with a literal rather than importing the
  // constant (a module edge neither wants). This is the ratchet that makes a
  // rename of OAUTH_PENDING_STORAGE_KEY fail here instead of silently leaving
  // those readers pointed at a key nobody writes.
  it("matches every literal reader", async () => {
    const { OAUTH_PENDING_STORAGE_KEY } = await import("../mcp-oauth");
    expect(OAUTH_PENDING_STORAGE_KEY).toBe("mcp-oauth-pending");
  });
});

describe("callback with no stored flow session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("asks for reauthorization and makes zero token requests", async () => {
    const { handleOAuthCallback } = await import("../mcp-oauth");

    // The reachable shape: a pending marker and a server URL, but no flow
    // session. `clearOAuthData` used to leave the marker behind, so this could
    // happen after ordinary cleanup — and it also happens to a session that
    // straddles a deploy.
    localStorage.setItem("mcp-oauth-pending", "gamma");
    localStorage.setItem("mcp-serverUrl-gamma", "https://mcp.example.com/mcp");
    localStorage.setItem(
      "mcp-client-gamma",
      JSON.stringify({ client_id: "client-id" }),
    );
    localStorage.setItem("mcp-verifier-gamma", "stored-verifier");

    const result = await handleOAuthCallback("auth-code", {
      callbackState: "some-state",
      callbackIss: null,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/re-?authoriz/i);
    // Directly, not by inference from the message.
    expect(mockAuthFetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
    // The pending marker is cleared so the dead-end cannot be retried forever.
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
  });

  it("increments the no-session recovery counter", async () => {
    const { handleOAuthCallback } = await import("../mcp-oauth");

    localStorage.setItem("mcp-oauth-pending", "gamma");
    localStorage.setItem("mcp-serverUrl-gamma", "https://mcp.example.com/mcp");

    await handleOAuthCallback("auth-code", { callbackState: "s" });

    expect(mockTrack).toHaveBeenCalledWith(
      "oauth_callback_no_session_recovery",
      expect.objectContaining({ serverName: "gamma" }),
    );
  });

  // Cleanup leaves no marker at all, so a stray callback afterwards cannot find
  // a server name to half-recover from. (That initiation itself re-writes the
  // marker with a session behind it is covered by the integration test.)
  it("leaves no marker for a stray callback to find", async () => {
    const { clearOAuthData } = await import("../mcp-oauth");

    localStorage.setItem("mcp-oauth-pending", "delta");
    seedServer("delta");
    clearOAuthData("delta");

    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
  });
});
