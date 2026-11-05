import {
  generationEnvironmentTarget,
  getEffectiveSuiteServers,
} from "../../evals/helpers";
import type { EvalSuite } from "../../evals/types";

export interface SuiteGenerateState {
  canGenerate: boolean;
  /** Why Generate is off, or what it will do when it is on. */
  disabledReason: string;
}

/**
 * Whether a suite can generate cases from its servers, and the reason to show
 * beside Generate. The same rules as the suite page's Generate button.
 */
export function suiteGenerateState(
  suite: EvalSuite,
  connectedServerNames: ReadonlySet<string>,
  canConnectServers: boolean,
): SuiteGenerateState {
  // Environment suites: servers resolve server-side from the environment,
  // so neither the legacy list nor the browser's connections gate this.
  const environmentTarget = generationEnvironmentTarget(suite);
  if (environmentTarget.kind === "none") {
    return { canGenerate: false, disabledReason: environmentTarget.reason };
  }
  if (environmentTarget.kind !== "legacy") {
    return {
      canGenerate: true,
      disabledReason:
        "Generate suggested cases from this suite’s environment servers. Open a case to run it when you are ready.",
    };
  }
  const suiteServers = getEffectiveSuiteServers(suite);
  if (suiteServers.length === 0) {
    return {
      canGenerate: false,
      disabledReason: "Add a client in Settings before generating cases.",
    };
  }
  const missingServers = suiteServers.filter(
    (serverName) => !connectedServerNames.has(serverName),
  );
  if (missingServers.length > 0 && !canConnectServers) {
    return {
      canGenerate: false,
      disabledReason: `Connect ${missingServers.join(", ")} to generate cases for this suite.`,
    };
  }
  return {
    canGenerate: true,
    disabledReason:
      missingServers.length > 0
        ? "Connects the suite’s MCP servers if needed, then creates suggested test cases."
        : "Generate suggested cases from this suite’s servers. Open a case to run it when you are ready.",
  };
}
