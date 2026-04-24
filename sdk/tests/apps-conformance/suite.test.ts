import {
  MCPAppsConformanceSuite,
  MCPAppsConformanceTest,
  type MCPAppsConformanceResult,
} from "../../src/apps-conformance/index.js";
import { startConformanceMockServer } from "../mock-servers/conformance-mcp-server.js";

function createAppsResult(
  overrides: Partial<MCPAppsConformanceResult> = {},
): MCPAppsConformanceResult {
  return {
    passed: true,
    target: "node mock-server.js",
    checks: [
      {
        id: "ui-tools-present",
        category: "tools",
        title: "UI Tools Present",
        description: "At least one UI tool exists.",
        status: "passed",
        durationMs: 5,
      },
    ],
    summary: "1/1 checks passed, 0 failed, 0 skipped",
    durationMs: 5,
    categorySummary: {
      tools: { total: 1, passed: 1, failed: 0, skipped: 0 },
      resources: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
    discovery: {
      toolCount: 1,
      uiToolCount: 1,
      listedResourceCount: 1,
      listedUiResourceCount: 1,
      checkedUiResourceCount: 1,
    },
    ...overrides,
  };
}

describe("MCPAppsConformanceSuite", () => {
  it("throws when runs array is empty", () => {
    expect(
      () =>
        new MCPAppsConformanceSuite({
          target: {
            url: "https://example.com/mcp",
          },
          runs: [],
        }),
    ).toThrow("at least one run");
  });

  it("runs multiple HTTP conformance runs and aggregates results", async () => {
    const mockServer = await startConformanceMockServer();

    try {
      const suite = new MCPAppsConformanceSuite({
        name: "Apps Suite",
        target: {
          url: mockServer.url,
          timeout: 10_000,
        },
        defaults: {
          checkIds: ["ui-tools-present"],
        },
        runs: [
          {},
          {
            label: "resources",
            checkIds: ["ui-resources-readable"],
          },
        ],
      });

      const result = await suite.run();

      expect(result.name).toBe("Apps Suite");
      expect(result.target).toBe(mockServer.url);
      expect(result.passed).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].label).toBe("Run 1");
      expect(result.results[0].checks).toHaveLength(1);
      expect(result.results[0].checks[0]?.id).toBe("ui-tools-present");
      expect(result.results[1].label).toBe("resources");
      expect(result.results[1].checks).toHaveLength(1);
      expect(result.results[1].checks[0]?.id).toBe("ui-resources-readable");
      expect(result.summary).toContain("All 2 conformance runs passed");
    } finally {
      await mockServer.stop();
    }
  });

  it("merges stdio targets with run overrides", async () => {
    const runSpy = jest
      .spyOn(MCPAppsConformanceTest.prototype, "run")
      .mockImplementation(async function mockedRun(this: MCPAppsConformanceTest) {
        const config = (this as any).config;
        return createAppsResult({
          target: config.target,
          checks: [
            {
              id: config.checkIds?.[0] ?? "ui-tools-present",
              category: "tools",
              title: "UI Tools Present",
              description: "At least one UI tool exists.",
              status: "passed",
              durationMs: 5,
            },
          ],
        });
      });

    try {
      const suite = new MCPAppsConformanceSuite({
        target: {
          command: "node",
          args: ["mock-server.js"],
          timeout: 20_000,
        },
        defaults: {
          checkIds: ["ui-tools-present"],
        },
        runs: [
          {},
          {
            checkIds: ["ui-resource-meta-valid"],
          },
        ],
      });

      const result = await suite.run();

      expect(result.passed).toBe(true);
      expect(result.target).toBe("node");
      expect(result.results[0]?.checks[0]?.id).toBe("ui-tools-present");
      expect(result.results[1]?.checks[0]?.id).toBe("ui-resource-meta-valid");
      expect(runSpy).toHaveBeenCalledTimes(2);
    } finally {
      runSpy.mockRestore();
    }
  });

  it("reports failure when any run fails", async () => {
    const runSpy = jest
      .spyOn(MCPAppsConformanceTest.prototype, "run")
      .mockResolvedValueOnce(createAppsResult())
      .mockResolvedValueOnce(
        createAppsResult({
          passed: false,
          summary: "0/1 checks passed, 1 failed, 0 skipped",
          checks: [
            {
              id: "ui-resource-meta-valid",
              category: "resources",
              title: "UI Resource Metadata Valid",
              description: "Validate ui resource metadata.",
              status: "failed",
              durationMs: 5,
              error: {
                message: "Invalid CSP metadata",
              },
            },
          ],
          categorySummary: {
            tools: { total: 0, passed: 0, failed: 0, skipped: 0 },
            resources: { total: 1, passed: 0, failed: 1, skipped: 0 },
          },
        }),
      );

    try {
      const suite = new MCPAppsConformanceSuite({
        target: {
          command: "node",
        },
        runs: [{}, {}],
      });

      const result = await suite.run();

      expect(result.passed).toBe(false);
      expect(result.summary).toBe("1/2 conformance runs passed");
      expect(result.results[1]?.passed).toBe(false);
    } finally {
      runSpy.mockRestore();
    }
  });
});
