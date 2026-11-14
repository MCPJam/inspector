import http from "node:http";
import type { AddressInfo } from "node:net";
import { vi, afterEach, describe, it, expect } from "vitest";
import {
  MCPAppsConformanceTest,
  MCP_APPS_CHECK_IDS,
} from "../../src/apps-conformance/index.js";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import * as operations from "../../src/operations.js";
import {
  computeConformanceScore,
  pooledConformanceScore,
  scoreFromAppsResult,
} from "../../src/conformance-score.js";
import { toConformanceReport } from "../../src/conformance-reporting.js";
import {
  startConformanceMockServer,
  CONFORMANCE_UI_TOOL_NAME,
  CONFORMANCE_UI_RESOURCE_URI,
} from "../mock-servers/conformance-mcp-server.js";

afterEach(() => vi.restoreAllMocks());

function expectAbsent(
  result: Awaited<ReturnType<MCPAppsConformanceTest["run"]>>
) {
  expect(result.checks).toHaveLength(MCP_APPS_CHECK_IDS.length);
  expect(
    result.checks.every(
      (c) => c.status === "skipped" && c.skipReason === "not-applicable"
    )
  ).toBe(true);
  expect(scoreFromAppsResult(result)).toMatchObject({
    score: null,
    applicable: 0,
    failed: 0,
  });
  const passing = computeConformanceScore([{ id: "ping", status: "passed" }]);
  expect(
    pooledConformanceScore([passing, scoreFromAppsResult(result)])
  ).toMatchObject({ score: 100, applicable: 1, failed: 0 });
  const report = toConformanceReport(result);
  expect(
    report.groups
      .flatMap((group) => group.cases)
      .every((c) => c.status === "skipped" && c.skipReason === "not-applicable")
  ).toBe(true);
  expect(report.score).toMatchObject({ score: null, applicable: 0, failed: 0 });
}

describe("absent Apps surface", () => {
  it.each([false, true])(
    "is not applicable with stateless=%s",
    async (statelessTransport) => {
      const mock = await startConformanceMockServer({
        statelessTransport,
        omitTools: [CONFORMANCE_UI_TOOL_NAME],
        omitResources: [CONFORMANCE_UI_RESOURCE_URI],
      });
      try {
        expectAbsent(await new MCPAppsConformanceTest({ url: mock.url }).run());
      } finally {
        await mock.stop();
      }
    }
  );

  it("is not applicable without resource support", async () => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: Record<string, unknown> = JSON.parse(
        Buffer.concat(chunks).toString()
      );
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "tools-only", version: "1" },
            }
          : body.method === "tools/list"
            ? { tools: [] }
            : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          ...(result
            ? { result }
            : { error: { code: -32601, message: "Method not found" } }),
        })
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const { port } = server.address() as AddressInfo;
      expectAbsent(
        await new MCPAppsConformanceTest({
          url: `http://127.0.0.1:${port}/mcp`,
        }).run()
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each(["declaration", "discovery"])(
    "keeps %s errors visible",
    async (kind) => {
      const manager = new MCPClientManager();
      vi.spyOn(manager, "listTools").mockResolvedValue({
        tools:
          kind === "declaration"
            ? [
                {
                  name: "broken",
                  inputSchema: { type: "object" },
                  _meta: { ui: { resourceUri: 42 } },
                },
              ]
            : [],
      });
      const resources = vi.spyOn(manager, "listResources");
      if (kind === "discovery")
        resources.mockRejectedValue(new Error("discovery failed"));
      else resources.mockResolvedValue({ resources: [] });
      vi.spyOn(operations, "withEphemeralClient").mockImplementation(
        async (_config, fn) => fn(manager, "test")
      );
      const result = await new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
      }).run();
      expect(result.outcome).toBe("failed");
      expect(result.checks[0]?.status).toBe("failed");
    }
  );
});
