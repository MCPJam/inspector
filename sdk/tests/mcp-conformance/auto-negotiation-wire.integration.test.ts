import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import type { MCPConformanceResult } from "../../src/mcp-conformance/index.js";
import { serveWireFixture } from "../support/wire-schema-fixture.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * A 2025-era server on the official v1 SDK, one transport per session. Like
 * every such server, it answers a sessionless request before `initialize`,
 * here the unpinned client's `server/discover` probe, with HTTP 400 and
 * `"id": null`.
 */
async function serveLegacyServer(): Promise<string> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const server = http.createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const existing =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    const mcp = new McpServer({ name: "legacy-fixture", version: "1.0.0" });
    mcp.registerTool("echo", { description: "Echoes." }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      })
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function wireSchemaCheck(result: MCPConformanceResult) {
  const check = result.checks.find((entry) => entry.id === "wire-schema-valid");
  if (!check) throw new Error("wire-schema-valid did not appear in the run");
  return check;
}

describe("wire-schema-valid on an unpinned run", { timeout: 20_000 }, () => {
  it("does not grade the negotiation probe of a 2025-era server", async () => {
    const url = await serveLegacyServer();
    const result = await new MCPConformanceTest({
      serverUrl: url,
      checkTimeout: 5_000,
      checkIds: ["wire-schema-valid"],
    }).run();
    const check = wireSchemaCheck(result);

    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
    // Non-vacuity: the handshake and list traffic was still graded.
    expect(Number(check.details?.messagesValidated)).toBeGreaterThan(0);
  });

  it("still grades server/discover when the server speaks 2026-07-28", async () => {
    const fixture = await serveWireFixture({ omitResultType: true });
    closers.push(fixture.close);
    const result = await new MCPConformanceTest({
      serverUrl: fixture.url,
      checkTimeout: 5_000,
      checkIds: ["wire-schema-valid"],
      // The readiness advice sends its own server/discover; without it, the
      // only one left in the record is the client's negotiation probe.
      readinessIds: [],
    }).run();
    const check = wireSchemaCheck(result);
    const violations = (
      check.details as {
        violations?: Array<{ origin: string; definition: string }>;
      }
    ).violations;

    expect(check.status).toBe("failed");
    expect(violations).toContainEqual(
      expect.objectContaining({
        origin: "POST server/discover",
        definition: "DiscoverResult",
      })
    );
  });
});
