import type { MCPServerConfig } from "../mcp-client-manager/index.js";
import { normalizeMCPAppsConformanceConfig } from "./validation.js";
import { MCPAppsConformanceTest } from "./runner.js";
import type {
  MCPAppsConformanceConfig,
  MCPAppsConformanceResult,
  MCPAppsConformanceSuiteConfig,
  MCPAppsConformanceSuiteResult,
} from "./types.js";

function buildRunLabel(
  run: MCPAppsConformanceSuiteConfig["runs"][number],
  index: number,
): string {
  if (run.label?.trim()) {
    return run.label.trim();
  }

  if (run.checkIds?.length) {
    return `Run ${index + 1}: ${run.checkIds.join(", ")}`;
  }

  return `Run ${index + 1}`;
}

function buildSuiteSummary(
  results: Array<MCPAppsConformanceResult & { label: string }>,
): string {
  const passedCount = results.filter((result) => result.passed).length;
  if (passedCount === results.length) {
    return `All ${results.length} conformance runs passed`;
  }

  return `${passedCount}/${results.length} conformance runs passed`;
}

export class MCPAppsConformanceSuite {
  private readonly config: MCPAppsConformanceSuiteConfig;
  private readonly target: string;

  constructor(config: MCPAppsConformanceSuiteConfig) {
    if (!config.runs.length) {
      throw new Error("MCP Apps conformance suite requires at least one run");
    }

    const normalized = normalizeMCPAppsConformanceConfig(
      config.target as MCPAppsConformanceConfig,
    );

    this.target = normalized.target;
    this.config = {
      ...config,
      target: normalized.serverConfig as MCPServerConfig,
    };
  }

  async run(): Promise<MCPAppsConformanceSuiteResult> {
    const startedAt = Date.now();
    const results: Array<MCPAppsConformanceResult & { label: string }> = [];

    for (let index = 0; index < this.config.runs.length; index += 1) {
      const runConfig = this.config.runs[index];
      const label = buildRunLabel(runConfig, index);
      const mergedConfig: MCPAppsConformanceConfig = {
        ...this.config.target,
        ...this.config.defaults,
        ...runConfig,
      };

      const result = await new MCPAppsConformanceTest(mergedConfig).run();
      results.push({ ...result, label });
    }

    const passed = results.every((result) => result.passed);

    return {
      name: this.config.name?.trim() || "MCP Apps Conformance Suite",
      target: this.target,
      passed,
      results,
      summary: buildSuiteSummary(results),
      durationMs: Date.now() - startedAt,
    };
  }
}
