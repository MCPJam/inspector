import { logger } from "../../utils/logger.js";
import { resolveAppVersion } from "../../utils/log-events.js";
import { HOSTED_MODE } from "../../config.js";

/**
 * Request-boundary telemetry for the LEGACY eval request shapes that
 * environment-only suites replace (a launch, quick run or generation that
 * names its own model and servers instead of an environment).
 *
 * The backend counts the legacy branches it takes; this counts the requests
 * that ask for them, by surface and by the inspector build that served them,
 * which is what tells a dormant desktop install apart from a live caller when
 * the legacy paths are deleted. Identifiers only.
 */
export type LegacyEvalRequestSurface =
  "suite_run" | "quick_run" | "generation" | "suite_patch";

export function logLegacyEvalRequest(event: {
  surface: LegacyEvalRequestSurface;
  use: string;
  suiteId?: string | null;
  projectId?: string | null;
  fields?: string[];
}): void {
  try {
    logger.info("legacy_eval_path", {
      event: "legacy_eval_path",
      ...event,
      inspectorVersion: resolveAppVersion(),
      deployment: HOSTED_MODE ? "hosted" : "self_hosted",
    });
  } catch {
    // Telemetry never fails the request it observes.
  }
}
