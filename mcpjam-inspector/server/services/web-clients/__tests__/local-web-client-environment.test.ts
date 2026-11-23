/**
 * A local Inspector's web client environment: a capability connector per
 * server in this process's registry, one browser per profile at a time, a
 * tunnel URL the vendor's app can reach, and startup only with the flag on.
 * Evidence: fixture (no browser is launched).
 */
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalConnectorRegistry } from "../local-connectors";
import {
  createLocalWebClientEnvironment,
  createLocalWebClientEnvironmentFactory,
  localWebClientProfileDir,
} from "../local-web-client-environment";
import { REPOSITORY_ROOT } from "../../../utils/outside-repository";
import { mountWebClientRuntime } from "../runtime-mount";
import { setWebClientEnvironment, webClientEnvironmentFor } from "../web-client-environment";

afterEach(() => {
  vi.unstubAllEnvs();
  setWebClientEnvironment(undefined);
});

const SERVERS = {
  getServerConfig: (serverId: string) =>
    serverId === "orders"
      ? { url: "http://localhost:3000/mcp", accessToken: "orders-token", requestInit: { headers: { "x-tenant": "t1" } } }
      : serverId === "shell"
        ? { command: "node", args: ["server.js"] }
        : undefined,
};

/**
 * A page in a Chromium context that takes the driver's routes and its
 * session for pausing document requests; `route` stands in for the context's.
 */
function chromiumPage(route: () => Promise<void> = async () => {}) {
  const context = {
    browser: () => ({ browserType: () => ({ name: () => "chromium" }) }),
    route,
    on: () => {},
    pages: () => [],
    newCDPSession: async () => ({
      send: async (method: string) =>
        method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {},
      on: () => {},
    }),
  };
  return { context: () => context, on: () => {} } as never;
}

function environment(over: Partial<Parameters<typeof createLocalWebClientEnvironment>[0]> = {}) {
  return createLocalWebClientEnvironment({
    vendor: "chatgpt",
    publicBaseUrl: "https://tunnel.example",
    servers: SERVERS,
    profileDir: "/profiles/chatgpt-profile",
    headless: true,
    registry: createLocalConnectorRegistry(),
    ...over,
  });
}

describe("a local web client environment", () => {
  it("reaches a server through one capability connector carrying its credential", async () => {
    const registry = createLocalConnectorRegistry();
    const env = environment({ registry });
    const args = { projectId: "p", webAccountId: "local:chatgpt", serverId: "orders", auth: "oauth" as const };
    const first = await env.ensureConnector(args);
    expect(await env.ensureConnector(args)).toEqual(first);
    expect(registry.list()).toEqual([
      expect.objectContaining({ connectorId: first.connectorId, serverId: "orders", upstreamUrl: "http://localhost:3000/mcp" }),
    ]);
    const connector = await registry.resolver.resolve(first.connectorId);
    expect(connector).toMatchObject({ auth: "capability" });
    expect(await registry.resolver.upstream(connector!, {} as never)).toEqual({
      url: "http://localhost:3000/mcp",
      headers: { authorization: "Bearer orders-token", "x-tenant": "t1" },
    });
    // Another vendor's app keeps its own connector, so their turns don't collide.
    const claude = await environment({ vendor: "claude", registry }).ensureConnector(args);
    expect(claude.connectorId).not.toBe(first.connectorId);
  });

  it("keeps the vendor's connector through a token refresh and forwards with the new token", async () => {
    const registry = createLocalConnectorRegistry();
    let accessToken = "token-1";
    const env = environment({
      registry,
      servers: {
        getServerConfig: () => ({
          url: "http://localhost:3000/mcp",
          accessToken,
        }),
      },
    });
    const args = {
      projectId: "p",
      webAccountId: "local:chatgpt",
      serverId: "orders",
      auth: "oauth" as const,
    };
    const first = await env.ensureConnector(args);
    accessToken = "token-2";
    expect(await env.ensureConnector(args)).toEqual(first);
    expect(registry.list()).toHaveLength(1);
    const connector = await registry.resolver.resolve(first.connectorId);
    expect((await registry.resolver.upstream(connector!, {})).headers).toEqual({
      authorization: "Bearer token-2",
    });
  });

  it("refuses a server that signs in with a refresh token rather than forward it without one", async () => {
    const registry = createLocalConnectorRegistry();
    const env = environment({
      registry,
      servers: {
        getServerConfig: () => ({
          url: "http://localhost:3000/mcp",
          refreshToken: "refresh-1",
          clientId: "client-1",
        }),
      },
    });
    await expect(
      env.ensureConnector({
        projectId: "p",
        webAccountId: "local:chatgpt",
        serverId: "billing",
        auth: "oauth",
      }),
    ).rejects.toThrow(
      "billing signs in with a refresh token, so the vendor's app can't use its sign-in.",
    );
    expect(registry.list()).toEqual([]);
  });

  it("refuses a server the vendor's app can't reach by URL", async () => {
    await expect(
      environment().ensureConnector({ projectId: "p", webAccountId: "local:chatgpt", serverId: "shell", auth: "oauth" }),
    ).rejects.toThrow("shell isn't a server with a URL");
  });

  it("opens one browser per profile at a time and frees it on close or a failed launch", async () => {
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ page: chromiumPage(), close }));
    const env = environment({ launch });
    const sites = ["https://chatgpt.com"];
    const browser = await env.openBrowser({ webAccountId: "local:chatgpt", sites });
    expect(launch).toHaveBeenCalledWith("/profiles/chatgpt-profile", { headless: true });
    await expect(env.openBrowser({ webAccountId: "local:chatgpt", sites })).rejects.toMatchObject({
      failure: { kind: "turn_running", message: "Another turn is using this machine's ChatGPT web browser." },
    });
    await browser.close();
    expect(close).toHaveBeenCalled();
    launch.mockRejectedValueOnce(new Error("Chromium is not installed"));
    await expect(env.openBrowser({ webAccountId: "local:chatgpt", sites })).rejects.toThrow("Chromium is not installed");
    await (await env.openBrowser({ webAccountId: "local:chatgpt", sites })).close();
  });

  it("closes a browser it couldn't drive before freeing its profile", async () => {
    const sites = ["https://chatgpt.com"];
    // While the browser closes, another turn asks for the same profile.
    let closing = false;
    let openedWhileClosing: unknown;
    const close = vi.fn(async () => {
      if (closing) return;
      closing = true;
      openedWhileClosing = await env.openBrowser({ webAccountId: "local:chatgpt", sites }).catch((error: unknown) => error);
    });
    const page = chromiumPage(async () => {
      throw new Error("The page could not be routed.");
    });
    const env = environment({ launch: vi.fn(async () => ({ page, close })) });
    await expect(env.openBrowser({ webAccountId: "local:chatgpt", sites })).rejects.toThrow("The page could not be routed.");
    expect(close).toHaveBeenCalledTimes(1);
    expect(openedWhileClosing).toMatchObject({ failure: { kind: "turn_running" } });
  });

  it("stops as turn_running when another process has the profile open", async () => {
    const sites = ["https://chatgpt.com"];
    // Playwright's words for it: its chromium.ts quotes Chromium's log line,
    // and its process launcher logs Chromium's profile-in-use exit code.
    const inUse = [
      "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory. This usually means that the profile is already in use by another instance of Chromium.",
      "browserType.launchPersistentContext: Opening in existing browser session. This usually means that the profile is already in use by another instance of Chromium.",
      "browserType.launchPersistentContext: Failed to launch the browser process.\nBrowser logs:\n\nCall log:\n  - [pid=4242] <process did exit: exitCode=21, signal=null>",
    ];
    const launch = vi.fn(async () => ({
      page: chromiumPage(),
      close: async () => {},
    }));
    const env = environment({ launch });
    for (const message of inUse) {
      launch.mockRejectedValueOnce(new Error(message));
      await expect(
        env.openBrowser({ webAccountId: "local:chatgpt", sites }),
      ).rejects.toMatchObject({
        failure: {
          kind: "turn_running",
          message:
            "Another Inspector or a sign-in window has this machine's ChatGPT web browser open.",
        },
      });
    }
    // This process holds nothing, so the next turn opens the profile.
    await (
      await env.openBrowser({ webAccountId: "local:chatgpt", sites })
    ).close();
  });

  it("keeps profiles under the folder the person chose, never inside this repository", async () => {
    vi.stubEnv("MCPJAM_WEB_CLIENTS_PROFILE_DIR", "/home/someone/web-profiles");
    expect(localWebClientProfileDir("claude")).toBe(join("/home/someone/web-profiles", "claude-profile"));
    // A commit from this checkout could carry the session, so a turn stops
    // before it opens a browser there.
    const root = REPOSITORY_ROOT;
    if (root === undefined) throw new Error("The package didn't resolve its own manifest.");
    const inside = join(root, "mcpjam-inspector", ".web-profiles");
    vi.stubEnv("MCPJAM_WEB_CLIENTS_PROFILE_DIR", inside);
    expect(() => localWebClientProfileDir("claude")).toThrow(
      "The Claude web browser profile is inside this Inspector's repository",
    );
    const factory = createLocalWebClientEnvironmentFactory({
      env: {
        MCPJAM_INSPECTOR_PUBLIC_URL: "https://tunnel.example",
        MCPJAM_WEB_CLIENTS_PROFILE_DIR: inside,
      },
    });
    await expect(
      factory({ runtimeId: "chatgpt-web", projectId: "p", runId: "r" }),
    ).rejects.toThrow(
      "Set MCPJAM_WEB_CLIENTS_PROFILE_DIR to a folder outside the repository",
    );
  });
});

describe("the local Inspector's startup", () => {
  const turn = { runtimeId: "chatgpt-web" as const, projectId: "p", runId: "r" };

  it("sets the environment only with the flag on", async () => {
    mountWebClientRuntime(new Hono(), { hosted: false, flagOn: () => false });
    expect(await webClientEnvironmentFor(turn)).toBeUndefined();
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "https://tunnel.example");
    mountWebClientRuntime(new Hono(), { hosted: false, flagOn: () => true });
    expect((await webClientEnvironmentFor(turn))?.publicBaseUrl).toBe("https://tunnel.example");
  });

  it("stops a turn the vendor's app could not reach", async () => {
    const factory = createLocalWebClientEnvironmentFactory({ env: { MCPJAM_INSPECTOR_PUBLIC_URL: "http://localhost:6274" } });
    await expect(factory(turn)).rejects.toThrow(/no public HTTPS address/);
  });
});
