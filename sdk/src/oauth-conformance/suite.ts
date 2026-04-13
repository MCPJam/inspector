import { OAuthConformanceTest } from "./runner.js";
import type {
  ConformanceResult,
  OAuthConformanceConfig,
  OAuthConformanceSuiteConfig,
  OAuthConformanceSuiteResult,
} from "./types.js";

function deriveLabel(merged: OAuthConformanceConfig & { label?: string }): string {
  if (merged.label) {
    return merged.label;
  }
  const mode = merged.auth?.mode ?? "headless";
  return `${merged.protocolVersion}/${merged.registrationStrategy}/${mode}`;
}

function buildSuiteSummary(
  results: Array<ConformanceResult & { label: string }>,
  passed: boolean,
  serverUrl: string,
): string {
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;

  if (passed) {
    return `All ${total} flows passed for ${serverUrl}`;
  }

  const failures = results
    .filter((r) => !r.passed)
    .map((r) => r.label);
  return `${passedCount}/${total} flows passed. Failed: ${failures.join(", ")}`;
}

/**
 * Runs a matrix of OAuth conformance flows against a single MCP server.
 *
 * Each flow inherits shared `defaults` from the suite config and can
 * override any field. Flows run sequentially to avoid overwhelming
 * authorization servers with concurrent registrations.
 */
export class OAuthConformanceSuite {
  private readonly config: OAuthConformanceSuiteConfig;

  constructor(config: OAuthConformanceSuiteConfig) {
    if (!config.serverUrl?.trim()) {
      throw new Error("OAuthConformanceSuiteConfig requires serverUrl");
    }
    if (!config.flows?.length) {
      throw new Error("OAuthConformanceSuiteConfig requires at least one flow");
    }
    this.config = config;
  }

  async run(): Promise<OAuthConformanceSuiteResult> {
    const startedAt = Date.now();
    const results: Array<ConformanceResult & { label: string }> = [];

    for (const flow of this.config.flows) {
      // Merge defaults with per-flow overrides. Runtime validation
      // happens inside OAuthConformanceTest's constructor.
      const merged = {
        ...this.config.defaults,
        ...flow,
        serverUrl: this.config.serverUrl,
      } as OAuthConformanceConfig;
      const label = deriveLabel({ ...merged, label: flow.label });

      const test = new OAuthConformanceTest(merged);
      const result = await test.run();
      results.push({ ...result, label });
    }

    const durationMs = Date.now() - startedAt;
    const passed = results.every((r) => r.passed);

    return {
      name: this.config.name ?? "OAuth Conformance Suite",
      serverUrl: this.config.serverUrl,
      passed,
      results,
      summary: buildSuiteSummary(results, passed, this.config.serverUrl),
      durationMs,
    };
  }
}
