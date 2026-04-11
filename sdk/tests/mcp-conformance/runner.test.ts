import {
  MCP_CHECK_IDS,
  MCPConformanceTest,
} from "../../src/mcp-conformance/index.js";
import { startConformanceMockServer } from "../mock-servers/conformance-mcp-server.js";

describe("MCPConformanceTest", () => {
  it("passes the full conformance suite against the dedicated mock server", async () => {
    const mockServer = await startConformanceMockServer();

    try {
      const test = new MCPConformanceTest({
        serverUrl: mockServer.url,
        checkTimeout: 10_000,
      });

      const result = await test.run();

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(MCP_CHECK_IDS.length);
      expect(result.checks.every((check) => check.status === "passed")).toBe(true);
      expect(result.categorySummary.core.passed).toBe(5);
      expect(result.categorySummary.protocol.passed).toBe(1);
      expect(result.categorySummary.tools.passed).toBe(2);
      expect(result.categorySummary.prompts.passed).toBe(1);
      expect(result.categorySummary.resources.passed).toBe(1);
      expect(result.categorySummary.security.passed).toBe(2);
      expect(result.categorySummary.transport.passed).toBe(3);
    } finally {
      await mockServer.stop();
    }
  });

  it("skips optional capabilities and accepts tools/prompts without descriptions", async () => {
    const mockServer = await startConformanceMockServer({
      omitLogging: true,
      omitCompletion: true,
      omitToolDescriptions: ["test_simple_text"],
      omitPromptDescriptions: ["test_simple_prompt"],
    });

    try {
      const test = new MCPConformanceTest({
        serverUrl: mockServer.url,
        checkTimeout: 10_000,
        checkIds: [
          "logging-set-level",
          "completion-complete",
          "tools-list",
          "prompts-list",
        ],
      });

      const result = await test.run();
      const statuses = Object.fromEntries(
        result.checks.map((check) => [check.id, check.status]),
      );

      expect(result.passed).toBe(true);
      expect(statuses).toEqual({
        "logging-set-level": "skipped",
        "completion-complete": "skipped",
        "tools-list": "passed",
        "prompts-list": "passed",
      });
    } finally {
      await mockServer.stop();
    }
  });

  it("treats stateless Streamable HTTP servers as supported transport variants", async () => {
    const mockServer = await startConformanceMockServer({
      statelessTransport: true,
    });

    try {
      const test = new MCPConformanceTest({
        serverUrl: mockServer.url,
        checkTimeout: 10_000,
        checkIds: [
          "server-sse-polling-session",
          "server-accepts-multiple-post-streams",
          "server-sse-streams-functional",
        ],
      });

      const result = await test.run();
      const statuses = Object.fromEntries(
        result.checks.map((check) => [check.id, check.status]),
      );

      expect(result.passed).toBe(true);
      expect(statuses).toEqual({
        "server-sse-polling-session": "skipped",
        "server-accepts-multiple-post-streams": "passed",
        "server-sse-streams-functional": "passed",
      });
    } finally {
      await mockServer.stop();
    }
  });
});
