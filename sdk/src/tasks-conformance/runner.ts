export * from "./metadata.js";
export * from "./shapes.js";
export * from "./evidence.js";
import { captureConformanceRun } from "../telemetry.js";
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
  private readonly suppressTelemetry: boolean;
  constructor(config: MCPTasksConformanceConfig) {
    this.config = normalizeMCPTasksConformanceConfig(config);
    // The normalized config drops it, so read it from the caller's config.
    this.suppressTelemetry = config.__suppressTelemetry === true;
  }
  async run(): Promise<MCPTasksConformanceResult> {
    if (!this.suppressTelemetry) void captureConformanceRun("sdk");
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
