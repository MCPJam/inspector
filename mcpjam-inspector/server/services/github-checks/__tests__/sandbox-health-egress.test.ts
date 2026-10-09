/**
 * MJ-001: the GitHub-check health probe dials the pull request's server
 * through the hosted MCP transport, not the global fetch.
 *
 * The URL is ours — the sandbox's public edge — but the code answering it is
 * the pull request's, and it can redirect. So the property worth pinning is the
 * transport, and the observable is a target the hosted guard refuses: under the
 * global fetch the probe would open a connection to it, under the guard it
 * never does. Connections are counted rather than requests because the probe
 * speaks https and this target speaks plain http — an unguarded dial fails its
 * handshake before any request handler could see it.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckSandbox } from "../sandbox";

const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;
const RECIPE = {
  build: "npm ci && npm run build",
  start: "npm start",
  port: 3001,
  mcpPath: "/mcp",
};

const servers: http.Server[] = [];

async function countingTarget(): Promise<{
  host: string;
  connections: () => number;
}> {
  let connections = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.on("connection", () => {
    connections += 1;
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { host: `127.0.0.1:${port}`, connections: () => connections };
}

/** Just enough box for build → start → probe; every command succeeds. */
function sandboxServing(host: string): CheckSandbox {
  return {
    sandboxId: "sb_test",
    getHost: () => host,
    commands: {
      run: async (_command: string, opts?: { background?: boolean }) =>
        opts?.background
          ? { pid: 1234 }
          : { exitCode: 0, stdout: "", stderr: "" },
    },
    kill: async () => {},
  } as unknown as CheckSandbox;
}

afterEach(async () => {
  if (ORIGINAL_HOSTED_MODE === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
  }
  vi.resetModules();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("GitHub-check health probe in hosted mode", () => {
  it("never dials a target the hosted guard refuses", async () => {
    const target = await countingTarget();
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    vi.resetModules();
    const { buildAndStart } = await import("../sandbox");

    const error = await buildAndStart(sandboxServing(target.host), RECIPE, {
      healthTimeoutMs: 300,
      healthIntervalMs: 20,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ outcome: "server_unhealthy" });
    expect(target.connections()).toBe(0);
  }, 60_000);
});
