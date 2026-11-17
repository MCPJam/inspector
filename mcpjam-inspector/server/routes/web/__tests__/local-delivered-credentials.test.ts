/**
 * Local runs built through `createAuthorizedManager` (evals, the v1 eval
 * route) attach tokens the backend delivered. Each one goes only to the
 * origins the backend bound it to, is registered for scrubbing, and marks its
 * connection `credentialSource: "mcpjam-backend"` so replay never copies it.
 * Hosted managers keep their own rules and are left as they were.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { constructions } = vi.hoisted(() => ({
  constructions: [] as Array<Record<string, Record<string, unknown>>>,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  class RecordingManager {
    constructor(configs: Record<string, Record<string, unknown>>) {
      constructions.push(configs);
    }
    setElicitationCallback() {}
    setMrtrInputCollector() {}
    async disconnectAllServers() {}
  }
  return { ...actual, MCPClientManager: RecordingManager };
});

const TOKEN = "tok-delivered-3f9a1c7e";
const SERVER_URL = "https://mcp.example.test/mcp";

function authorizeResult(extra: Record<string, unknown>) {
  return {
    results: {
      s1: {
        ok: true,
        role: "member",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        serverConfig: {
          transportType: "http",
          url: SERVER_URL,
          useOAuth: true,
          name: "Lab server",
        },
        oauthAccessToken: TOKEN,
        ...extra,
      },
    },
  };
}

async function inMode<T>(hosted: boolean, run: () => Promise<T>) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  constructions.length = 0;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
    else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
    vi.resetModules();
  }
}

async function buildManager() {
  const { createAuthorizedManager } = await import("../auth.js");
  await createAuthorizedManager(
    { authMethod: "jwt" } as never,
    "bearer-token",
    "p1",
    ["s1"],
    5_000,
  );
  expect(constructions).toHaveLength(1);
  return constructions[0]!.s1!;
}

/** What `fetchFn` sends as `Authorization` to `url`. */
async function authorizationSentTo(fetchFn: typeof fetch, url: string) {
  const seen: Array<string | null> = [];
  const saved = global.fetch;
  global.fetch = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("{}", { status: 200 });
    },
  ) as typeof fetch;
  try {
    await fetchFn(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  } finally {
    global.fetch = saved;
  }
  return seen[0];
}

describe("createAuthorizedManager with a delivered token", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  let batch: Record<string, unknown>;

  it.each(["shared", "uploaded", undefined])("applies remote HTTPS enforcement to %s accounts", async (accountKind) => {
    batch = authorizeResult({
      serverConfig: { transportType: "http", url: "http://private.example/mcp", useOAuth: true, name: "Lab server" },
      oauthBoundOrigins: ["http://private.example"],
      ...(accountKind ? { oauthAccountKind: accountKind } : {}),
    });
    await inMode(false, async () => {
      if (accountKind) await expect(buildManager()).rejects.toThrow("needs HTTPS");
      else await expect(buildManager()).resolves.toMatchObject({ credentialSource: "mcpjam-backend" });
    });
  });

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    batch = authorizeResult({
      oauthBoundOrigins: ["https://mcp.example.test"],
    });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/web/authorize-batch")) {
        return new Response(JSON.stringify(batch), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl)
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    else delete process.env.CONVEX_HTTP_URL;
  });

  it("locally, sends it only to its bound origin and keeps it out of replay", async () => {
    await inMode(false, async () => {
      const config = await buildManager();
      expect(config.credentialSource).toBe("mcpjam-backend");
      const fetchFn = config.baseFetch as typeof fetch;
      expect(await authorizationSentTo(fetchFn, SERVER_URL)).toBe(
        `Bearer ${TOKEN}`,
      );
      expect(
        await authorizationSentTo(fetchFn, "https://collector.example/x"),
      ).toBeNull();

      const { scrubDeliveredSecrets } =
        await import("../../../../shared/delivered-secret-registry.js");
      expect(scrubDeliveredSecrets(`token ${TOKEN} leaked`)).not.toContain(
        TOKEN,
      );
    });
  });

  it("locally, binds it to the server's own origin when the backend names none", async () => {
    batch = authorizeResult({});
    await inMode(false, async () => {
      const config = await buildManager();
      const fetchFn = config.baseFetch as typeof fetch;
      expect(await authorizationSentTo(fetchFn, SERVER_URL)).toBe(
        `Bearer ${TOKEN}`,
      );
      expect(
        await authorizationSentTo(fetchFn, "https://collector.example/x"),
      ).toBeNull();
    });
  });

  it("locally, refuses to build when the server moved off the token's origins", async () => {
    batch = authorizeResult({
      oauthBoundOrigins: ["https://old.example.test"],
    });
    await inMode(false, async () => {
      await expect(buildManager()).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining("its sign-in was not sent"),
      });
      expect(constructions).toHaveLength(0);
    });
  });

  const createLocal = async (options: Record<string, unknown>) => {
    const { createAuthorizedManager } = await import("../auth.js");
    return createAuthorizedManager(
      { authMethod: "jwt" } as never,
      "bearer-token",
      "p1",
      ["s1"],
      5_000,
      undefined,
      undefined,
      options,
    );
  };

  it("locally, keeps the backend's origins for an implicit account", async () => {
    batch = authorizeResult({
      oauthCredentialId: "cred-1",
      oauthBoundOrigins: ["https://old.example.test"],
    });
    await inMode(false, async () => {
      await expect(
        createLocal({ multiConnection: true }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  it("locally, refuses only the moved server when refusals are tolerated", async () => {
    batch = authorizeResult({
      oauthBoundOrigins: ["https://old.example.test"],
    });
    await inMode(false, async () => {
      const result = await createLocal({ tolerateServerRefusals: true });
      expect(Object.keys(result.refusedServers ?? {})).toEqual(["s1"]);
      expect(constructions).toEqual([{}]);
    });
  });

  it("locally, pins a refresh to the account that answered", async () => {
    batch = authorizeResult({
      oauthCredentialId: "cred-1",
      oauthBoundOrigins: ["https://mcp.example.test"],
    });
    const refreshes: unknown[] = [];
    global.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/web/authorize-batch")) return Response.json(batch);
        if (url.endsWith("/web/oauth/force-refresh")) {
          refreshes.push(JSON.parse(String(init?.body)));
          return Response.json({ accessToken: "next-token" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    ) as typeof fetch;
    await inMode(false, async () => {
      const config = await buildManager();
      const refresh = config.onUnauthorized as (context: unknown) => unknown;
      await refresh({ serverId: "s1", error: new Error("HTTP 401") });
      expect(refreshes).toEqual([
        expect.objectContaining({ connectionId: "cred-1" }),
      ]);
    });
  });

  it("locally, names stored credential headers for the exchange log", async () => {
    const result = authorizeResult({
      oauthBoundOrigins: ["https://mcp.example.test"],
    });
    Object.assign(result.results.s1.serverConfig, {
      headers: { "X-Tenant-Key": "tenant-secret" },
      boundOrigins: ["https://mcp.example.test"],
    });
    batch = result;
    await inMode(false, async () => {
      const config = await buildManager();
      expect(config.credentialHeaderNames).toEqual(["X-Tenant-Key"]);
      expect(config.credentialSource).toBe("mcpjam-backend");
      // The stored value standing alone in an error is scrubbed too.
      const { scrubDeliveredSecrets } =
        await import("../../../../shared/delivered-secret-registry.js");
      expect(scrubDeliveredSecrets("failed: tenant-secret")).not.toContain(
        "tenant-secret",
      );
    });
    await inMode(true, async () => {
      const config = await buildManager();
      expect(config.credentialHeaderNames).toBeUndefined();
    });
  });

  it("locally, gives a token whose account is unknown no refresh", async () => {
    // Unpinned, a refresh after the server moved could return another
    // account's token.
    batch = authorizeResult({});
    await inMode(false, async () => {
      expect((await buildManager()).onUnauthorized).toBeUndefined();
    });
    await inMode(true, async () => {
      expect((await buildManager()).onUnauthorized).toEqual(
        expect.any(Function),
      );
    });
  });

  it("names the delivery contract on a local manager's authorize call only", async () => {
    const sent = async () =>
      new Headers(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers,
      ).get("x-mcpjam-delivery-contract");
    await inMode(false, async () => {
      await buildManager();
      expect(await sent()).toBe("1");
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
    await inMode(true, async () => {
      await buildManager();
      expect(await sent()).toBeNull();
    });
  });

  it("locally, never sends another origin's token after the server moved", async () => {
    batch = authorizeResult({
      oauthCredentialId: "cred-1",
      oauthBoundOrigins: ["https://mcp.example.test"],
    });
    let refreshed: Record<string, unknown> = {};
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch")) return Response.json(batch);
      if (url.endsWith("/web/oauth/force-refresh"))
        return Response.json(refreshed);
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    await inMode(false, async () => {
      const config = await buildManager();
      const refresh = config.onUnauthorized as (
        context: unknown,
      ) => Promise<{ accessToken: string }>;
      const unauthorized = { serverId: "s1", error: new Error("HTTP 401") };

      refreshed = {
        accessToken: "moved-token",
        credentialId: "cred-1",
        boundOrigins: ["https://moved.example.test"],
      };
      await expect(refresh(unauthorized)).rejects.toMatchObject({
        status: 401,
      });

      refreshed = {
        accessToken: "same-origin-token",
        credentialId: "cred-1",
        boundOrigins: ["https://mcp.example.test"],
      };
      await expect(refresh(unauthorized)).resolves.toEqual({
        accessToken: "same-origin-token",
      });
    });
  });

  it("leaves hosted managers as they were", async () => {
    await inMode(true, async () => {
      const config = await buildManager();
      expect(config.credentialSource).toBeUndefined();
    });
  });
});
