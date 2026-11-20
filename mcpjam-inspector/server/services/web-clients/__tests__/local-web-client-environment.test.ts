/**
 * A local Inspector's web client environment: a capability connector per
 * server in this process's registry, one browser per profile at a time, a
 * tunnel URL the vendor's app can reach, and startup only with the flag on.
 * Evidence: fixture (no browser is launched).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalConnectorRegistry } from "../local-connectors";
import {
  createLocalWebClientEnvironment,
  createLocalWebClientEnvironmentFactory,
  localWebClientProfileDir,
} from "../local-web-client-environment";
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

  it("refuses a server the vendor's app can't reach by URL", async () => {
    await expect(
      environment().ensureConnector({ projectId: "p", webAccountId: "local:chatgpt", serverId: "shell", auth: "oauth" }),
    ).rejects.toThrow("shell isn't a server with a URL");
  });

  it("opens one browser per profile at a time and frees it on close or a failed launch", async () => {
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ page: { route: async () => {} } as never, close }));
    const env = environment({ launch, profileWaitMs: 60, profilePollMs: 10 });
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

  it("lets a second turn on the same profile wait for the first browser to close", async () => {
    const launch = vi.fn(async () => ({ page: { route: async () => {} } as never, close: async () => {} }));
    const env = environment({ launch, profilePollMs: 10 });
    const sites = ["https://chatgpt.com"];
    const first = await env.openBrowser({ webAccountId: "local:chatgpt", sites });
    const second = env.openBrowser({ webAccountId: "local:chatgpt", sites });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(launch).toHaveBeenCalledTimes(1);
    await first.close();
    await (await second).close();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("keeps profiles outside any checkout, under the folder the person chose", () => {
    vi.stubEnv("MCPJAM_WEB_CLIENTS_PROFILE_DIR", "/home/someone/web-profiles");
    expect(localWebClientProfileDir("claude")).toBe("/home/someone/web-profiles/claude-profile");
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
