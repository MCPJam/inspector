import { MCPConformanceTest } from "./runner.js";
import type {
  MCPConformanceConfig,
  MCPConformanceResult,
  MCPConformanceSuiteConfig,
  MCPConformanceSuiteResult,
} from "./types.js";

function buildRunLabel(
  run: MCPConformanceSuiteConfig["runs"][number],
  index: number,
): string {
  if (run.label?.trim()) {
    return run.label.trim();
  }

  if (run.checkIds?.length) {
    return `Run ${index + 1}: ${run.checkIds.join(", ")}`;
  }

  if (run.categories?.length) {
    return `Run ${index + 1}: ${run.categories.join(", ")}`;
  }

  return `Run ${index + 1}`;
}

function buildSuiteSummary(
  results: Array<MCPConformanceResult & { label: string }>,
): string {
  const passedCount = results.filter((result) => result.passed).length;
  if (passedCount === results.length) {
    return `All ${results.length} conformance runs passed`;
  }

  return `${passedCount}/${results.length} conformance runs passed`;
}

export class MCPConformanceSuite {
  private readonly config: MCPConformanceSuiteConfig;

  constructor(config: MCPConformanceSuiteConfig) {
    const serverUrl = config.serverUrl.trim();
    if (!serverUrl) {
      throw new Error("MCP conformance suite requires serverUrl");
    }
    if (!config.runs.length) {
      throw new Error("MCP conformance suite requires at least one run");
    }

    this.config = {
      ...config,
      serverUrl,
    };
  }

  async run(): Promise<MCPConformanceSuiteResult> {
    const startedAt = Date.now();
    const results: Array<MCPConformanceResult & { label: string }> = [];

    for (let index = 0; index < this.config.runs.length; index += 1) {
      const runConfig = this.config.runs[index];
      const label = buildRunLabel(runConfig, index);
      const mergedConfig: MCPConformanceConfig = {
        serverUrl: this.config.serverUrl,
        ...this.config.defaults,
        ...runConfig,
      };

      const result = await new MCPConformanceTest(mergedConfig).run();
      results.push({ ...result, label });
    }

    const passed = results.every((result) => result.passed);

    return {
      name: this.config.name?.trim() || "MCP Conformance Suite",
      serverUrl: this.config.serverUrl,
      passed,
      results,
      summary: buildSuiteSummary(results),
      durationMs: Date.now() - startedAt,
    };
  }
}
