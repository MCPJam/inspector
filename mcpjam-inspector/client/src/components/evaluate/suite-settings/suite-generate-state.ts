import type { EvalSuite } from "@/components/evals/types";
import {
  generationEnvironmentTarget,
  getEffectiveSuiteServers,
} from "@/components/evals/helpers";

/**
 * Whether Generate can run for this suite, and the sentence that says why.
 *
 * The rule EvaluateTab applies to today's suite page, as a pure function so
 * the Suite settings page can read it from page services. EvaluateTab keeps
 * its own copy until the legacy page is removed.
 */
export function suiteGenerateState(
  suite: EvalSuite | null,
  connectedServerNames: ReadonlySet<string>,
  canConnectServers: boolean,
): { canGenerate: boolean; disabledReason: string } {
  // Environment suites: servers resolve server-side from the environment,
  // so neither the legacy list nor the browser's connections gate this.
  const environmentTarget = suite ? generationEnvironmentTarget(suite) : null;
  if (environmentTarget?.kind === "none") {
    return { canGenerate: false, disabledReason: environmentTarget.reason };
  }
  if (environmentTarget && environmentTarget.kind !== "legacy") {
    return {
      canGenerate: true,
      disabledReason:
        "Generate suggested cases from this suite’s environment servers. Open a case to run it when you are ready.",
    };
  }
  const suiteServers = suite ? getEffectiveSuiteServers(suite) : [];
  if (suiteServers.length === 0) {
    return {
      canGenerate: false,
      disabledReason:
        "Attach a client in the suite header before generating cases.",
    };
  }
  const missingServers = suiteServers.filter(
    (serverName) => !connectedServerNames.has(serverName),
  );
  if (missingServers.length > 0) {
    if (canConnectServers) {
      return {
        canGenerate: true,
        disabledReason:
          "Connects the suite’s MCP servers if needed, then creates suggested test cases.",
      };
    }
    return {
      canGenerate: false,
      disabledReason: `Connect ${missingServers.join(
        ", ",
      )} to generate cases for this suite.`,
    };
  }
  return {
    canGenerate: true,
    disabledReason:
      "Generate suggested cases from this suite’s servers. Open a case to run it when you are ready.",
  };
}
