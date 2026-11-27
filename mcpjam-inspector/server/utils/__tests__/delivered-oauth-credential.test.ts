import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPClientManager, type HttpServerConfig } from "@mcpjam/sdk";
import { toMCPServerConfig } from "../local-server-resolver.js";
import {
  deliveredCredentialBinding,
  deliveredCredentialFields,
  recordDeliveredAccountKind,
  registeringDeliveredToken,
  tunnelRefusal,
} from "../delivered-oauth-credential.js";
import { scrubDeliveredSecrets } from "../../../shared/delivered-secret-registry.js";
import { WebRouteError } from "../../routes/web/errors.js";
import { bindCredentialHeaders } from "../credential-header-binding.js";

const TOKEN = "tok_EFTW41_SECRET_default_account";

function authorized(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    role: "member",
    accessLevel: "project_member",
    permissions: { chatOnly: false },
    serverConfig: {
      transportType: "http" as const,
      url: "https://mcp.example.com/mcp",
      headers: {},
      useOAuth: true,
    },
    oauthAccessToken: TOKEN,
    ...overrides,
  };
}

/** Records what each hop carried; the server's own origin redirects away. */
function recordingFetch() {
  const hops: Array<{ url: string; authorization: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      hops.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return url.startsWith("https://mcp.example.com/")
        ? new Response(null, {
            status: 307,
            headers: { Location: "https://collector.example/steal" },
          })
        : new Response("{}", { status: 200 });
    }),
  );
  return hops;
}

const send = (config: HttpServerConfig, url: string) =>
  config.baseFetch!(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a backend-delivered OAuth token", () => {
  it("is marked, and attached only on its own origin, hop by hop", async () => {
    const config = toMCPServerConfig(authorized()) as HttpServerConfig;
    expect(config.credentialSource).toBe("mcpjam-backend");

    const hops = recordingFetch();
    await send(config, "https://mcp.example.com/mcp");
    // A first hop elsewhere (a legacy SSE `endpoint` event can name any URL).
    await send(config, "https://collector.example/messages");

    expect(hops).toEqual([
      { url: "https://mcp.example.com/mcp", authorization: `Bearer ${TOKEN}` },
      { url: "https://collector.example/steal", authorization: null },
      { url: "https://collector.example/messages", authorization: null },
    ]);
  });

  it("goes to every origin the backend bound it to, and nowhere else", async () => {
    const config = toMCPServerConfig(
      authorized({
        oauthBoundOrigins: ["https://mcp.example.com", "https://auth.example.com"],
      }),
    ) as HttpServerConfig;
    const hops = recordingFetch();
    await send(config, "https://auth.example.com/mcp");
    await send(config, "https://other.example/mcp");
    expect(hops.map((hop) => hop.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      null,
    ]);
  });

  it("is refused outright when the server is not where the backend bound it", () => {
    let thrown: unknown;
    try {
      toMCPServerConfig(
        authorized({ oauthBoundOrigins: ["https://old.example.com"] }),
        {
          refreshContext: {
            bearerToken: "bearer",
            projectId: "project",
            serverId: "srv",
            serverName: "Linear",
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebRouteError);
    const refusal = thrown as WebRouteError;
    expect(refusal.status).toBe(401);
    expect(refusal.details).toMatchObject({
      oauthRequired: true,
      serverId: "srv",
    });
    expect(refusal.message).toContain("https://mcp.example.com");
    expect(JSON.stringify(refusal)).not.toContain(TOKEN);
  });

  it("keeps Authorization for the token when stored headers name it too", async () => {
    const fields = deliveredCredentialFields({
      url: "https://mcp.example.com/mcp",
      token: TOKEN,
      boundOrigins: undefined,
      // Stored headers bound nowhere must not strip the token's header.
      stored: { headerNames: ["authorization", "x-api-key"], boundOrigins: [] },
      target: { serverId: "srv" },
    });
    const sent: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers));
        return new Response("{}");
      }),
    );
    await fields.baseFetch!("https://mcp.example.com/mcp", {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Api-Key": "stored" },
    });
    expect(sent[0].get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent[0].get("x-api-key")).toBeNull();
  });

  it("leaves an XAA token, minted here for this server, unmarked", () => {
    const config = toMCPServerConfig(
      authorized({
        serverConfig: {
          transportType: "http",
          url: "https://mcp.example.com/mcp",
          headers: {},
          authMethod: "xaa",
        },
        oauthBoundOrigins: ["https://old.example.com"],
      }),
      { oauthAccessToken: "tok_EFTW41_SECRET_minted" },
    ) as HttpServerConfig;
    expect(config.credentialSource).toBeUndefined();
    expect(config.baseFetch).toBeUndefined();
  });

  it("leaves a connection without one unmarked and on the default fetch", () => {
    const config = toMCPServerConfig(
      authorized({ oauthAccessToken: null }),
    ) as HttpServerConfig;
    expect(config.credentialSource).toBeUndefined();
    expect(config.baseFetch).toBeUndefined();
  });

  it("stays out of replay configs and the HTTP exchange log, with the stored headers", async () => {
    const exchanges: unknown[] = [];
    const manager = new MCPClientManager(
      {},
      {
        retryPolicy: { retries: 0, retryDelayMs: 0 },
        httpLogger: (exchange) => exchanges.push(exchange),
      },
    );
    const config = toMCPServerConfig(
      authorized({
        serverConfig: {
          transportType: "http",
          url: "http://127.0.0.1:9/mcp",
          headers: { "X-Tenant-Key": "tok_EFTW41_SECRET_stored_header" },
          useOAuth: true,
        },
        credentialBinding: {
          headerNames: ["X-Tenant-Key"],
          boundOrigins: ["http://127.0.0.1:9"],
        },
      }),
      { timeoutMs: 250 },
    );
    // Nothing listens there; the failed connect still registers the server
    // and logs the exchange it attempted.
    await expect(manager.connectToServer("srv", config)).rejects.toThrow();
    expect(manager.hasServer("srv")).toBe(true);

    expect(manager.getServerReplayConfigs()).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(0);
    expect(JSON.stringify(exchanges)).toContain('"x-tenant-key":"<redacted>"');
    expect(JSON.stringify(exchanges)).not.toContain("tok_EFTW41_SECRET");
  });

  it("is replaced exactly in scrubbed text, with or without a Bearer prefix", async () => {
    toMCPServerConfig(authorized());
    expect(scrubDeliveredSecrets(`upstream said ${TOKEN} was revoked`)).toBe(
      "upstream said [redacted-oauth-token] was revoked",
    );

    const refreshed = "tok_EFTW41_SECRET_refreshed_value";
    const hook = registeringDeliveredToken(async () => ({
      accessToken: refreshed,
    }));
    await hook({ serverId: "srv", error: new Error("401") });
    expect(scrubDeliveredSecrets(refreshed)).toBe("[redacted-oauth-token]");
  });
});

describe("tunnelRefusal", () => {
  const manager = {};
  const record = (kind: unknown, credentialSource?: "mcpjam-backend") =>
    recordDeliveredAccountKind(manager, "Linear", {
      config: { url: "https://mcp.example.com/mcp", credentialSource },
      authorizeResult: { oauthAccountKind: kind },
    });

  it("refuses a shared or uploaded account and allows a personal one", () => {
    record("shared", "mcpjam-backend");
    expect(tunnelRefusal(manager, "Linear")).toContain(
      "an account shared with the project",
    );
    record("uploaded", "mcpjam-backend");
    expect(tunnelRefusal(manager, "Linear")).toContain(
      "an uploaded test account",
    );
    record(undefined, "mcpjam-backend");
    expect(tunnelRefusal(manager, "Linear")).toBeUndefined();
  });

  it("only counts a kind that came with a delivered token", () => {
    record("shared");
    expect(tunnelRefusal(manager, "Linear")).toBeUndefined();
  });
});

describe("deliveredCredentialBinding", () => {
  it("holds a connection's delivered credentials to the server's own origin", async () => {
    const binding = deliveredCredentialBinding({
      url: "https://mcp.example.com/mcp",
      credentialSource: "mcpjam-backend",
      credentialHeaderNames: ["X-Tenant-Key"],
    });
    expect(binding).toEqual({
      headerNames: ["X-Tenant-Key", "authorization"],
      boundOrigins: ["https://mcp.example.com"],
    });

    // A conformance suite dialing an endpoint it discovered elsewhere.
    const seen: Array<string | null> = [];
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const fetchFn = bindCredentialHeaders(inner, binding!);
    const headers = { Authorization: `Bearer ${TOKEN}` };
    await fetchFn("https://mcp.example.com/mcp", { headers });
    await fetchFn("https://auth.elsewhere.example/token", { headers });
    expect(seen).toEqual([`Bearer ${TOKEN}`, null]);
  });

  it("binds nothing for a connection with only its own credentials", () => {
    expect(
      deliveredCredentialBinding({ url: "https://mcp.example.com/mcp" }),
    ).toBeUndefined();
  });
});
