import { describe, expect, it, vi } from "vitest";
import {
  observeConnectionFetch,
  connectionChallengeFor,
} from "../connection-failure-context.js";

const denied = (error: string) =>
  new Response("denied", {
    status: 401,
    headers: { "www-authenticate": `Bearer error="${error}"` },
  });
const unauthorized = Object.assign(new Error("HTTP 401"), { status: 401 });

describe("server-scoped connection challenge capture", () => {
  it("isolates concurrent servers even at identical URLs and different tenant queries", async () => {
    for (const urls of [
      ["https://example.test/mcp", "https://example.test/mcp"],
      [
        "https://example.test/mcp?tenant=a",
        "https://example.test/mcp?tenant=b",
      ],
    ]) {
      const base = vi
        .fn()
        .mockResolvedValueOnce(denied("invalid_token"))
        .mockResolvedValueOnce(
          new Response("<html>denied</html>", {
            status: 401,
            headers: { "content-type": "text/html" },
          }),
        );
      const results = await Promise.all(
        urls.map(async (url) => {
          const fetch = observeConnectionFetch(base);
          await fetch(url);
          await Promise.resolve();
          return connectionChallengeFor(fetch, unauthorized);
        }),
      );
      expect(results).toEqual([
        { scheme: "bearer", error: "invalid_token", bodyKind: "text" },
        { scheme: "none", bodyKind: "html" },
      ]);
      expect(base).toHaveBeenCalledTimes(2);
    }
  });

  it("clears stale challenges on success and on later network failures", async () => {
    for (const next of [new Response("ok"), new Error("network failed")]) {
      const base = vi.fn().mockResolvedValueOnce(denied("invalid_token"));
      if (next instanceof Error) base.mockRejectedValueOnce(next);
      else base.mockResolvedValueOnce(next);
      const fetch = observeConnectionFetch(base);
      const challengeFor = (error: unknown) =>
        connectionChallengeFor(fetch, error);
      await fetch("https://example.test/mcp");
      expect(challengeFor(unauthorized)?.error).toBe("invalid_token");
      await fetch("https://example.test/mcp").catch(() => undefined);
      expect(challengeFor(unauthorized)).toBeUndefined();
      expect(
        connectionChallengeFor(observeConnectionFetch(base), unauthorized),
      ).toBeUndefined();
    }
  });

  it("omits evidence for mismatched status and overlapping requests", async () => {
    const fetch = observeConnectionFetch(
      vi.fn(async () => denied("invalid_token")),
    );
    const challengeFor = (error: unknown) =>
      connectionChallengeFor(fetch, error);
    await fetch("https://example.test/mcp");
    expect(
      challengeFor(Object.assign(new Error("HTTP 403"), { status: 403 })),
    ).toBeUndefined();
    await Promise.all([
      fetch("https://example.test/a"),
      fetch("https://example.test/b"),
    ]);
    expect(challengeFor(unauthorized)).toBeUndefined();
  });

  it("keeps the latest sequential rejection and never reads the response body", async () => {
    const response = denied("invalid_token");
    const text = vi.spyOn(response, "text");
    const fetch = observeConnectionFetch(
      vi
        .fn()
        .mockResolvedValueOnce(new Response("ok"))
        .mockResolvedValueOnce(response),
    );
    const challengeFor = (error: unknown) =>
      connectionChallengeFor(fetch, error);
    await fetch("https://example.test/mcp");
    expect(await fetch("https://example.test/mcp")).toBe(response);
    expect(challengeFor(unauthorized)).toEqual({
      scheme: "bearer",
      error: "invalid_token",
      bodyKind: "text",
    });
    expect(text).not.toHaveBeenCalled();
  });
});

it("captures eager native transport failures across each protocol pin", async () => {
  const { MCPClientManager, describeError } = await import("@mcpjam/sdk");
  for (const mcpProtocolVersion of [
    undefined,
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
  ] as const) {
    const base = vi.fn(async () => denied("invalid_token"));
    const baseFetch = observeConnectionFetch(base);
    const config = {
      url: "https://example.test/mcp",
      mcpProtocolVersion,
      disableSseFallback: true,
      baseFetch,
    };
    const manager = new MCPClientManager({ server: config });
    try {
      const error = await manager
        .getToolsForAiSdk(["server"])
        .catch((error) => error);
      expect(
        connectionChallengeFor(
          manager.getServerConfig("server")?.baseFetch,
          error,
        ),
        mcpProtocolVersion ?? "auto",
      ).toMatchObject({ scheme: "bearer", error: "invalid_token" });
      expect(
        describeError(error, {
          challenge: connectionChallengeFor(baseFetch, error),
        }),
      ).toMatchObject({
        slug: "auth/http_401",
        rawCode: 401,
        oneLine: expect.stringContaining("invalid_token"),
      });
      expect(base).toHaveBeenCalledTimes(1);
    } finally {
      await manager.disconnectAllServers();
    }
  }
});
