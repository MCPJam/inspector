import {
  MCP_APPS_CHECK_IDS,
  MCPAppsConformanceTest,
} from "../../src/apps-conformance/index.js";
import {
  CONFORMANCE_UI_RESOURCE_URI,
  startConformanceMockServer,
} from "../mock-servers/conformance-mcp-server.js";

describe("MCPAppsConformanceTest", () => {
  it("passes the full apps conformance suite against the dedicated mock server", async () => {
    const mockServer = await startConformanceMockServer();

    try {
      const test = new MCPAppsConformanceTest({
        url: mockServer.url,
        timeout: 10_000,
      });

      const result = await test.run();

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(MCP_APPS_CHECK_IDS.length);
      expect(result.checks.every((check) => check.status === "passed")).toBe(true);
      expect(result.categorySummary.tools.passed).toBe(3);
      expect(result.categorySummary.resources.passed).toBe(4);
      expect(result.discovery.uiToolCount).toBe(1);
      expect(result.discovery.listedUiResourceCount).toBe(1);
      expect(result.discovery.checkedUiResourceCount).toBe(1);
    } finally {
      await mockServer.stop();
    }
  });

  it("fails when a UI tool references a resource that cannot be read", async () => {
    const mockServer = await startConformanceMockServer({
      omitResources: [CONFORMANCE_UI_RESOURCE_URI],
    });

    try {
      const test = new MCPAppsConformanceTest({
        url: mockServer.url,
        timeout: 10_000,
      });

      const result = await test.run();
      const statuses = Object.fromEntries(
        result.checks.map((check) => [check.id, check.status]),
      );

      expect(result.passed).toBe(false);
      expect(statuses).toEqual({
        "ui-tools-present": "passed",
        "ui-tool-metadata-valid": "passed",
        "ui-tool-input-schema-valid": "passed",
        "ui-listed-resources-valid": "skipped",
        "ui-resources-readable": "failed",
        "ui-resource-contents-valid": "skipped",
        "ui-resource-meta-valid": "skipped",
      });
    } finally {
      await mockServer.stop();
    }
  });
});
