import { describe, expect, it } from "vitest";
import {
  attachConnectionAuthContext,
  attachConnectionChallenges,
  connectionContextFor,
  connectionUrlKey,
  createChallengeStore,
  recordConnectionChallenge,
} from "../connection-failure-context.js";

describe("connection-failure-context", () => {
  it("keys challenges by origin + path and finds them through the server's URL", () => {
    expect(connectionUrlKey("https://a.example/mcp/?token=x#frag")).toBe(
      "https://a.example/mcp",
    );
    expect(connectionUrlKey("not a url")).toBeUndefined();

    const manager = {
      getServerConfig: (id: string) =>
        id === "s2" ? { url: "https://b.example/mcp" } : undefined,
    };
    const store = createChallengeStore();
    recordConnectionChallenge(store, "https://a.example/mcp?x=1", {
      scheme: "none",
    });
    attachConnectionChallenges(manager, store);
    attachConnectionAuthContext(manager, "s1", {
      method: "oauth",
      credentialSent: true,
      refreshable: true,
      serverUrl: "https://a.example/mcp/",
    });
    // Challenges recorded AFTER attaching still land: same map.
    recordConnectionChallenge(store, "https://b.example/mcp", {
      scheme: "bearer",
      error: "invalid_token",
    });

    expect(connectionContextFor(manager, "s1")).toEqual({
      auth: {
        method: "oauth",
        credentialSent: true,
        refreshable: true,
        serverUrl: "https://a.example/mcp/",
      },
      challenge: { scheme: "none" },
    });
    // No auth context, but the manager knows the URL: the challenge alone.
    expect(connectionContextFor(manager, "s2")).toEqual({
      challenge: { scheme: "bearer", error: "invalid_token" },
    });
    expect(connectionContextFor(manager, "s3")).toBeUndefined();
    expect(connectionContextFor({}, "s1")).toBeUndefined();
  });
});
