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
  const notApplicable = results.filter((r) => r.outcome === "not-applicable");

  if (passed) {
    if (notApplicable.length === total) {
      return `Authorization is not required by ${serverUrl}; all ${total} flows were not applicable`;
    }
    const suffix =
      notApplicable.length > 0
        ? ` (${notApplicable.length} not applicable)`
        : "";
    return `All ${total} flows passed for ${serverUrl}${suffix}`;
  }

  // A not-applicable flow is not a failure — only genuine failures are named,
  // and incomplete flows are named as what they are: unestablished, not
  // violated.
  const failures = results
    .filter((r) => r.outcome === "failed")
    .map((r) => r.label);
  const incomplete = results
    .filter((r) => r.outcome === "incomplete")
    .map((r) => r.label);
  const parts = [`${passedCount}/${total} flows passed.`];
  if (failures.length > 0) {
    parts.push(`Failed: ${failures.join(", ")}`);
  }
  if (incomplete.length > 0) {
    parts.push(`Incomplete: ${incomplete.join(", ")}`);
  }
  return parts.join(" ");
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
    // A flow that did not apply cannot fail the suite: authorization is
    // OPTIONAL, so a server that requires none has nothing to violate. An
    // incomplete flow is not a pass either — it established nothing — so the
    // suite is green only when every flow passed or was inapplicable.
    const passed = results.every(
      (r) => r.outcome === "passed" || r.outcome === "not-applicable",
    );

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
