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

import { startOAuthConformance } from "../conformance.js";
import { clearAllSessions } from "../../../services/conformance-oauth-sessions.js";

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
});
