import http from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPAppsConformanceTest } from "../../src/apps-conformance/index.js";
import { createFixtureHandler } from "../support/dual-era-fixture.js";

/**
 * Phase 3 §11.4: MCPAppsConformanceConfig already accepts
 * `mcpProtocolVersion` (it spreads `MCPServerConfig`, and
 * `HttpServerConfig.mcpProtocolVersion` exists) — no sdk change is needed to
 * run the apps-conformance suite against a modern (2026-07-28) connection.
 * This is a REGRESSION GATE that a modern run produces the same check
 * statuses as a legacy run against the same server.
 */

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixtureOnPort(): Promise<ServedFixture> {
  const handler = createFixtureHandler({ apps: true });
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

describe("MCPAppsConformanceTest against the apps fixture — 2026-07-28", () => {
  it("passes on a modern (2026-07-28) pin", async () => {
    const served = await serveFixtureOnPort();
    try {
      const test = new MCPAppsConformanceTest({
        url: served.url,
        mcpProtocolVersion: "2026-07-28",
        timeout: 10_000,
      });

      const result = await test.run();

      expect(result.checks.length).toBeGreaterThan(0);
      expect(
        result.checks.every(
          (check) => check.status === "passed" || check.status === "skipped",
        ),
      ).toBe(true);
    } finally {
      await served.close();
    }
  });

  it("yields identical check statuses on legacy and modern runs", async () => {
    const legacyServed = await serveFixtureOnPort();
    const modernServed = await serveFixtureOnPort();
    try {
      const legacyResult = await new MCPAppsConformanceTest({
        url: legacyServed.url,
        timeout: 10_000,
      }).run();
      const modernResult = await new MCPAppsConformanceTest({
        url: modernServed.url,
        mcpProtocolVersion: "2026-07-28",
        timeout: 10_000,
      }).run();

      const statuses = (checks: typeof legacyResult.checks) =>
        Object.fromEntries(checks.map((c) => [c.id, c.status]));

      expect(statuses(modernResult.checks)).toEqual(statuses(legacyResult.checks));
      expect(modernResult.passed).toBe(legacyResult.passed);
    } finally {
      await legacyServed.close();
      await modernServed.close();
    }
  });
});
