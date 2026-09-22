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

    let sameAccountProfileId: string | undefined;
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
      if (merged.verification?.profile?.expectSameAccount) {
        // A flow declared to represent a known account but supplying no
        // identity is not agreement — there is nothing to compare, and
        // silently skipping would let the suite pass on the strength of a
        // check that never ran.
        const stable =
          !!result.profileId &&
          (sameAccountProfileId === undefined ||
            sameAccountProfileId === result.profileId);
        if (sameAccountProfileId !== undefined || !result.profileId)
          result.steps.push({
            step: "verify_profile_identity_stable_across_flows",
            title: "Profile identity across flows",
            summary: "Compare flows declared to use the same account.",
            status: stable ? "passed" : "failed",
            durationMs: 0,
            logs: [],
            httpAttempts: [],
            ...(stable
              ? {}
              : {
                  error: {
                    message: result.profileId
                      ? "Flows declared to use the same account returned different profile IDs."
                      : "This flow was declared to use the same account but supplied no profile identity to compare.",
                  },
                }),
          });
        if (!stable) {
          result.passed = false;
          result.outcome = "failed";
          result.summary = result.profileId
            ? "OAuth conformance failed: flows declared to use the same account returned different profile identities."
            : "OAuth conformance failed: a flow declared to use the same account supplied no profile identity.";
        }
        if (result.profileId) sameAccountProfileId ??= result.profileId;
      }
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
