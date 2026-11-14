import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DISCOVERY_MS = 5_000;
const AUTHORIZATION_URL = "https://auth.example/authorize";

interface FakeRunnerDeps {
  createInteractiveAuthorizationSession: () => Promise<{
    authorize(input: {
      authorizationUrl: string;
      timeoutMs?: number;
    }): Promise<unknown>;
  }>;
}

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  // Stands in for a server whose discovery and registration are slow, then
  // asks for user authorization like the real runner does.
  class SlowDiscoveryOAuthConformanceTest {
    constructor(
      _config: unknown,
      private readonly deps: FakeRunnerDeps,
    ) {}

    async run() {
      await new Promise((resolve) => setTimeout(resolve, DISCOVERY_MS));
      const session = await this.deps.createInteractiveAuthorizationSession();
      await session.authorize({
        authorizationUrl: AUTHORIZATION_URL,
        timeoutMs: 30_000,
      });
      return { passed: true, steps: [] };
    }
  }
  return { ...actual, OAuthConformanceTest: SlowDiscoveryOAuthConformanceTest };
});

import { startOAuthConformance, completeOAuthConformance, cancelOAuthConformance } from "../conformance.js";
import { clearAllSessions, getSession } from "../../../services/conformance-oauth-sessions.js";

describe("startOAuthConformance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearAllSessions();
    vi.useRealTimers();
  });

  it("returns the authorization URL even when discovery takes several seconds", async () => {
    let outcome: unknown;
    void startOAuthConformance({
      defaultServerUrl: "https://mcp.example/mcp",
      redirectUrl: "https://inspector.example/oauth/callback/debug",
    }).then((result) => {
      outcome = result;
    });

    await vi.advanceTimersByTimeAsync(DISCOVERY_MS + 1);

    expect(outcome).toMatchObject({
      phase: "authorization_needed",
      authorizationUrl: AUTHORIZATION_URL,
    });
  });
  it("keeps the same deadline while waiting for authorization", async () => {
    const started = startOAuthConformance({
      defaultServerUrl: "https://mcp.example/mcp",
      redirectUrl: "https://inspector.example/oauth/callback/debug",
      runTimeoutSeconds: 10,
    });
    await vi.advanceTimersByTimeAsync(DISCOVERY_MS + 1);
    const result = await started;
    expect(result.phase).toBe("authorization_needed");
    if (result.phase !== "authorization_needed") throw new Error("Expected auth wait");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(completeOAuthConformance({ sessionId: result.sessionId })).rejects.toThrow("Run timed out after 10 seconds");
    expect(getSession(result.sessionId)?.cancelRunner).toBeUndefined();
  });

  it("only lets the owning caller cancel the session", async () => {
    const started = startOAuthConformance({
      defaultServerUrl: "https://mcp.example/mcp",
      redirectUrl: "https://inspector.example/oauth/callback/debug",
      runTimeoutSeconds: 10,
      owner: "user:a",
    });
    await vi.advanceTimersByTimeAsync(DISCOVERY_MS + 1);
    const result = await started;
    if (result.phase !== "authorization_needed") throw new Error("Expected auth wait");
    cancelOAuthConformance({ sessionId: result.sessionId, owner: "user:b" });
    expect(getSession(result.sessionId, "user:a")).toBeDefined();
    cancelOAuthConformance({ sessionId: result.sessionId, owner: "user:a" });
    expect(getSession(result.sessionId, "user:a")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
  });

});
