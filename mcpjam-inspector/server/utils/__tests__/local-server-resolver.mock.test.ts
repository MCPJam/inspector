/**
 * Local connect for a mock's id: the same marker the hosted builder reads
 * gives an in-process config, the grant comes back through authorize, and
 * every other server keeps the config it had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMockInProcessHandler } from "../../services/mock/registry.js";
import { resolveLocalServerForConnect } from "../local-server-resolver.js";

const NOW = 1_800_000_000_000;
const context = {
  set: () => undefined,
  get: (key: string) => (key === "authMethod" ? "authkit_jwt" : key === "workosUserId" ? "ann" : undefined),
} as never;

let authorizeCalls: number;

function answer(serverId: string, config: Record<string, unknown>, grant?: string) {
  return Response.json({
    results: {
      [serverId]: {
        ok: true,
        role: "owner",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        serverConfig: config,
        ...(grant ? { oauthAccessToken: grant } : {}),
      },
    },
  });
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  authorizeCalls = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolveLocalServerForConnect for a mock", () => {
  it("serves it in this process with the grant and who connected, and mints again when the grant runs low", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        authorizeCalls += 1;
        return answer(
          "mock1",
          {
            transportType: "http",
            url: "https://mock.mcpjam.invalid/mock1",
            headers: {},
            mock: {
              mockId: "mock1",
              version: 3,
              contentHash: "h".repeat(64),
              grantExpiresAt: NOW + (authorizeCalls === 1 ? 20_000 : 3_600_000),
            },
          },
          authorizeCalls === 1 ? "local-grant-aaaaaaaaaa" : "local-grant-bbbbbbbbbb",
        );
      }),
    );
    const seen: Array<{ grant: string; bearerToken: string; projectId: string; caller: unknown }> = [];
    registerMockInProcessHandler(async (_id, _request, door) => {
      seen.push(door);
      return new Response("{}");
    });

    const { config, effectiveAuth } = await resolveLocalServerForConnect(
      context,
      "ann-bearer",
      "proj1",
      "mock1",
      { timeoutMs: 8_000 },
    );
    expect(effectiveAuth).toBe("none");
    expect(config).toMatchObject({ credentialSource: "mcpjam-backend" });
    expect(String((config as { url: URL }).url)).toBe("https://mock.mcpjam.invalid/mock1");
    await (config as { baseFetch: typeof fetch }).baseFetch("https://mock.mcpjam.invalid/mock1", {
      method: "POST",
      body: "{}",
    });
    expect(authorizeCalls).toBe(2);
    expect(seen).toEqual([
      expect.objectContaining({
        grant: "local-grant-bbbbbbbbbb",
        bearerToken: "ann-bearer",
        projectId: "proj1",
        caller: expect.objectContaining({ authMethod: "authkit_jwt", workosUserId: "ann" }),
      }),
    ]);
  });

  it("builds the config it always built for a server with no mock marker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer("srv-1", { transportType: "http", url: "https://plain.example/mcp", headers: {}, authMethod: "none" }),
      ),
    );
    const { config } = await resolveLocalServerForConnect(context, "ann-bearer", "proj1", "srv-1", {});
    expect(String((config as { url: URL }).url)).toBe("https://plain.example/mcp");
    expect(config).not.toHaveProperty("credentialSource");
    expect(config).not.toHaveProperty("baseFetch");
  });
});
