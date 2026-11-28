import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  type MockMCPClientManager,
} from "./helpers/index.js";
import { WebRouteError, ErrorCode } from "../../web/errors.js";
import { tunnelRefusal } from "../../../utils/delivered-oauth-credential.js";

const TOKEN = "tok_EFTW41_SECRET_member_token";
const ACCOUNT_TOKEN = "tok_EFTW41_SECRET_second_account";
const SERVER_NAME = "Linear";

function authorizeReturns(result: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        results: {
          srv_linear: {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "https://moved.example.com/mcp",
              headers: {},
              useOAuth: true,
            },
            oauthAccessToken: TOKEN,
            ...result,
          },
        },
      }),
    ),
  );
}

describe("connecting with a backend-delivered OAuth token", () => {
  let manager: MockMCPClientManager;
  let app: Hono;
  const originalConvexUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    manager = createMockMcpClientManager();
    app = createTestApp(manager, ["connect", "servers"]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexUrl;
  });

  const reconnect = () =>
    app.request("/api/mcp/servers/reconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer member-bearer",
      },
      body: JSON.stringify({
        projectId: "proj",
        serverId: "srv_linear",
        serverName: SERVER_NAME,
      }),
    });

  const priorConnection = (url: string) =>
    manager.getServerConfig.mockImplementation((key: string) =>
      key === SERVER_NAME
        ? { url: new URL(url), credentialSource: "mcpjam-backend" }
        : undefined,
    );

  it("preserves the personal OAuth sign-in prompt after initial refresh fails", async () => {
    authorizeReturns({ oauthBoundOrigins: ["https://moved.example.com"] });
    manager.connectToServer.mockRejectedValue(new WebRouteError(401, ErrorCode.UNAUTHORIZED, "Sign in again to connect.", { oauthRequired: true }));
    const res = await reconnect();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ oauthRequired: true });
  });

  it("does not attach the token when a reconnect finds the server moved to another origin", async () => {
    authorizeReturns({});
    priorConnection("https://mcp.example.com/mcp");

    const res = await reconnect();

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body)).toMatchObject({
      success: false,
      oauthRequired: true,
      serverId: "srv_linear",
      serverName: SERVER_NAME,
    });
    expect(manager.connectToServer).not.toHaveBeenCalled();
    // The old connection is closed but kept, so the next attempt refuses too.
    expect(manager.disconnectServer).toHaveBeenCalledWith(SERVER_NAME);
    expect(manager.removeServer).not.toHaveBeenCalled();
  });

  it("reconnects on the same origin with the token bound and marked", async () => {
    authorizeReturns({});
    priorConnection("https://moved.example.com/old-path");

    const res = await reconnect();

    expect(res.status).toBe(200);
    const [key, config] = manager.connectToServer.mock.calls[0];
    expect(key).toBe(SERVER_NAME);
    expect(config.credentialSource).toBe("mcpjam-backend");
    expect(config.requestInit.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(config.baseFetch).toEqual(expect.any(Function));
  });

  it("lets the backend's bound origins settle a move", async () => {
    authorizeReturns({ oauthBoundOrigins: ["https://moved.example.com"] });
    priorConnection("https://mcp.example.com/mcp");

    expect((await reconnect()).status).toBe(200);
    expect(manager.connectToServer).toHaveBeenCalledTimes(1);
  });

  it("binds each extra account and skips one bound elsewhere", async () => {
    authorizeReturns({
      oauthConnections: [
        { connectionId: "conn_default", isDefault: true, accessToken: TOKEN },
        {
          connectionId: "conn_elsewhere",
          isDefault: false,
          accessToken: ACCOUNT_TOKEN,
          boundOrigins: ["https://other.example.com"],
        },
        {
          connectionId: "conn_second",
          isDefault: false,
          accessToken: ACCOUNT_TOKEN,
          boundOrigins: ["https://moved.example.com"],
        },
      ],
    });
    manager.getConnectionStatus.mockReturnValue("disconnected");
    manager.removeServer.mockResolvedValue(undefined);

    const res = await app.request("/api/mcp/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer member-bearer",
      },
      body: JSON.stringify({
        projectId: "proj",
        serverId: "srv_linear",
        serverName: SERVER_NAME,
      }),
    });

    expect(res.status).toBe(200);
    const connected = new Map(
      manager.connectToServer.mock.calls.map(([key, config]) => [key, config]),
    );
    const keys = [...connected.keys()];
    expect(keys).toContain(SERVER_NAME);
    expect(keys.some((key) => key.includes("conn_elsewhere"))).toBe(false);
    const second = keys.find((key) => key.includes("conn_second"));
    expect(second).toBeDefined();
    const account = connected.get(second!);
    expect(account.credentialSource).toBe("mcpjam-backend");
    expect(new Headers(account.requestInit.headers).get("Authorization")).toBe(
      `Bearer ${ACCOUNT_TOKEN}`,
    );
    // Its own binding, not the default account's.
    expect(account.baseFetch).not.toBe(connected.get(SERVER_NAME).baseFetch);
  });

  it("reconnects an account whose bound origins narrowed, and reuses an unchanged one", async () => {
    const withSecond = (boundOrigins: string[]) =>
      authorizeReturns({
        oauthConnections: [
          { connectionId: "conn_default", isDefault: true, accessToken: TOKEN },
          {
            connectionId: "conn_second",
            isDefault: false,
            accessToken: ACCOUNT_TOKEN,
            boundOrigins,
          },
        ],
      });
    manager.getConnectionStatus.mockReturnValue("connected");
    manager.removeServer.mockResolvedValue(undefined);
    manager.getServerConfig.mockImplementation((key: string) =>
      key.includes("conn_second")
        ? {
            url: new URL("https://moved.example.com/mcp"),
            requestInit: { headers: { Authorization: `Bearer ${ACCOUNT_TOKEN}` } },
            credentialSource: "mcpjam-backend",
          }
        : undefined,
    );
    const connect = () =>
      app.request("/api/mcp/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer member-bearer",
        },
        body: JSON.stringify({
          projectId: "proj",
          serverId: "srv_linear",
          serverName: SERVER_NAME,
        }),
      });
    const secondConnects = () =>
      manager.connectToServer.mock.calls.filter(([key]) =>
        String(key).includes("conn_second"),
      ).length;
    const wide = ["https://moved.example.com", "https://other.example.com"];

    withSecond(wide);
    await connect();
    const first = secondConnects();
    withSecond(wide);
    await connect();
    expect(secondConnects()).toBe(first);
    withSecond(["https://moved.example.com"]);
    await connect();
    expect(secondConnects()).toBe(first + 1);
  });

  it("keeps each shared account out of tunnels under its own key", async () => {
    authorizeReturns({
      oauthAccountKind: "shared",
      oauthConnections: [
        { connectionId: "conn_default", isDefault: true, accessToken: TOKEN, accountKind: "shared" },
        { connectionId: "conn_second", isDefault: false, accessToken: ACCOUNT_TOKEN, accountKind: "shared" },
      ],
    });
    manager.getConnectionStatus.mockReturnValue("disconnected");
    manager.removeServer.mockResolvedValue(undefined);

    const res = await app.request("/api/mcp/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer member-bearer",
      },
      body: JSON.stringify({
        projectId: "proj",
        serverId: "srv_linear",
        serverName: SERVER_NAME,
      }),
    });

    expect(res.status).toBe(200);
    const second = manager.connectToServer.mock.calls
      .map(([key]) => key as string)
      .find((key) => key.includes("conn_second"));
    expect(second).toBeDefined();
    expect(tunnelRefusal(manager, second!)).toContain("shared with the project");
  });
});
