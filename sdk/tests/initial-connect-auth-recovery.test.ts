import { MCPClientManager } from "../src/mcp-client-manager";
import { startMockStreamableHttpServer } from "./mock-servers";

describe("initial connection credential recovery", () => {
  it.each([false, true])(
    "retries once and shares the outcome, rejected replacement=%s",
    async (rejectReplacement) => {
      const fixture = await startMockStreamableHttpServer();
      const manager = new MCPClientManager({});
      const failure = new Error("Upload a fresh token.");
      const onRetryRejected = jest.fn((): never => {
        throw failure;
      });
      const onUnauthorized = jest.fn(async () => ({
        accessToken: "replacement",
        onRetryRejected,
      }));
      const baseFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined)
        );
        if (
          rejectReplacement ||
          headers.get("authorization") !== "Bearer replacement"
        ) {
          return new Response("Unauthorized", { status: 401 });
        }
        return fetch(input, init);
      };
      const config = {
        url: fixture.url,
        accessToken: "expired",
        baseFetch,
        onUnauthorized,
        disableSseFallback: true,
      };
      try {
        const results = await Promise.allSettled([
          manager.connectToServer("shared", config),
          manager.connectToServer("shared", config),
        ]);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        if (rejectReplacement) {
          expect(results).toEqual([
            { status: "rejected", reason: failure },
            { status: "rejected", reason: failure },
          ]);
          expect(onRetryRejected).toHaveBeenCalledTimes(1);
        } else {
          expect(results.every((result) => result.status === "fulfilled")).toBe(
            true
          );
        }
      } finally {
        await manager.disconnectAllServers();
        await fixture.stop();
      }
    },
    20000
  );
});

it("stops initial recovery when access is revoked", async () => {
  const manager = new MCPClientManager({});
  const denied = Object.assign(new Error("Access was revoked."), {
    statusCode: 403,
  });
  const onUnauthorized = jest.fn(async () => {
    throw denied;
  });
  const baseFetch = jest.fn(
    async () => new Response("Unauthorized", { status: 401 })
  );
  try {
    await expect(
      manager.connectToServer("shared", {
        url: "https://mcp.example/mcp",
        accessToken: "expired",
        baseFetch,
        onUnauthorized,
        disableSseFallback: true,
      })
    ).rejects.toBe(denied);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  } finally {
    await manager.disconnectAllServers();
  }
});

it("preserves the authorization failure for personal OAuth to show sign-in", async () => {
  const manager = new MCPClientManager({});
  const baseFetch = jest.fn(
    async () =>
      new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      })
  );
  try {
    await expect(
      manager.connectToServer("personal", {
        url: "https://mcp.example/mcp",
        baseFetch,
        disableSseFallback: true,
      })
    ).rejects.toThrow(/401|authoriz/i);
  } finally {
    await manager.disconnectAllServers();
  }
});

it("reports an empty refresh result without a property access error", async () => {
  const manager = new MCPClientManager({});
  const onUnauthorized = jest.fn().mockResolvedValue(undefined);
  try {
    await expect(
      manager.connectToServer("shared", {
        url: "https://mcp.example/mcp",
        accessToken: "old",
        onUnauthorized,
        baseFetch: async () => new Response("Unauthorized", { status: 401 }),
        disableSseFallback: true,
      })
    ).rejects.toThrow("empty access token");
  } finally {
    await manager.disconnectAllServers();
  }
});
