/** Browser routing is independent of shell capability, location, and consent. */
import { HOSTED_MODE, LOCAL_BROWSER_ENABLED } from "../../config.js";
import { isComputersDataPlaneConfigured } from "./control-plane-client.js";
import { getComputersRemoteDataPlaneUrl } from "./remote-data-plane.js";
import type { ComputerEngine } from "./engine.js";
export function resolveBrowserEngine(args: {
  preference?: "local" | "cloud";
  localConsentValid: boolean;
}): ComputerEngine {
  if (args.preference === "local") {
    return !HOSTED_MODE && LOCAL_BROWSER_ENABLED && args.localConsentValid
      ? "local"
      : "unavailable";
  }
  return isComputersDataPlaneConfigured()
    ? "e2b"
    : getComputersRemoteDataPlaneUrl()
    ? "delegated"
    : "unavailable";
}

/** An explicit local request is never coerced onto another machine. */
export function coerceBrowserEngineForActor(
  engine: ComputerEngine,
  actor: {
    isGuest: boolean;
    isScenarioSession: boolean;
    isJourneySession: boolean;
    executionScopeKind?: "project" | "swarm";
  },
): ComputerEngine {
  return engine === "local" &&
    (actor.isGuest ||
      actor.isScenarioSession ||
      actor.isJourneySession ||
      actor.executionScopeKind === "swarm")
    ? "unavailable"
    : engine;
}
