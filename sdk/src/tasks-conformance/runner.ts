export * from "./metadata.js";
export * from "./shapes.js";
export * from "./evidence.js";
import { normalizeMCPTasksConformanceConfig } from "./validation.js";
import { planTasksConformance } from "./plan.js";
import { mergeTasksConformanceResults } from "./report.js";
import { TaskGroupRunner } from "./group-runner.js";
import type {
  MCPTasksConformanceConfig,
  MCPTasksConformanceResult,
  NormalizedMCPTasksConformanceConfig,
} from "./types.js";
export class MCPTasksConformanceTest {
  private readonly config: NormalizedMCPTasksConformanceConfig;
  constructor(config: MCPTasksConformanceConfig) {
    this.config = normalizeMCPTasksConformanceConfig(config);
  }
  async run(): Promise<MCPTasksConformanceResult> {
    const started = Date.now();
    const results: MCPTasksConformanceResult[] = [];
    for (const group of planTasksConformance(this.config)) {
      this.config.signal?.throwIfAborted();
      results.push(
        await new TaskGroupRunner({
          ...this.config,
          toolName: undefined,
          toolArguments: undefined,
          inputResponses: undefined,
          checkOverrides: undefined,
          ...group,
        }).run()
      );
    }
    this.config.signal?.throwIfAborted();
    return mergeTasksConformanceResults(
      results,
      this.config.checkIds,
      Date.now() - started
    );
  }
}
