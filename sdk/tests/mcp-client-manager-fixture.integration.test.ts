import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import {
  createFixtureHandler,
  FIXTURE_GREETING_URI,
} from "./support/dual-era-fixture.js";

/**
 * End-to-end integration: the real `MCPClientManager` against the beta.4
 * dual-era fixture served over a real (loopback) HTTP port. Unlike
 * `support/dual-era-fixture.test.ts` (which drives the fixture with a bare
 * client), this exercises the manager's full connection path — resolver,
 * transport construction, capability advertisement, and adapter routing.
 *
 * On a `2026-07-28` pin this is currently the FIRST integration of MCPJam's
 * modern path against a conformant modern server. It is also the parity
 * harness for the official-client cutover (Phase 1B/1C): the same assertions
 * must pass before and after modern connections move from the hand-rolled
 * preview to the upstream `Client`.
 */

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixtureOnPort(): Promise<ServedFixture> {
  const handler = createFixtureHandler();
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

describe("MCPClientManager × dual-era fixture over HTTP", () => {
  let served: ServedFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    served = await serveFixtureOnPort();
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("connects on a modern (2026-07-28) pin and serves the primitive surface", async () => {
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });

    const tools = await manager.listTools("fixture");
    expect(tools.tools.map((t) => t.name)).toContain("echo");

    const resources = await manager.listResources("fixture");
    expect(resources.resources.map((r) => r.uri)).toContain(
      FIXTURE_GREETING_URI,
    );

    const prompts = await manager.listPrompts("fixture");
    expect(prompts.prompts.map((p) => p.name)).toContain("welcome");

    const read = await manager.readResource("fixture", {
      uri: FIXTURE_GREETING_URI,
    });
    expect(
      Array.isArray(read.contents) ? read.contents[0]?.text : undefined,
    ).toBe("hello from the fixture");
  });

  it("connects on the default (legacy) path to the same server", async () => {
    await manager.connectToServer("fixture", {
      url: served.url,
      timeout: 10_000,
    });

    const tools = await manager.listTools("fixture");
    expect(tools.tools.map((t) => t.name)).toContain("echo");
  });
});
