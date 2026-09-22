/**
 * Engine resolution for the PERSONAL-computer bash/terminal path.
 *
 * "The host attaches a computer" stays an abstract capability on the host
 * config (`computer: {kind:"personal"}` — never widened on the wire); WHERE
 * it executes is resolved here, at the data plane, per turn:
 *
 *   e2b        — this process holds the vendor credentials (deployed servers)
 *   delegated  — no credentials, but a deployed data plane was discovered;
 *                personal exec/terminal forward there with the user's bearer
 *   local      — the user's own machine (Playground "This machine" engine)
 *   unavailable— none of the above can serve this turn
 *
 * INVARIANTS (each enforced structurally, not by convention):
 *  - A hosted server can never resolve `local`: HOSTED_MODE short-circuits
 *    before the preference is read, `LOCAL_COMPUTER_ENABLED` is forced false
 *    hosted, and the only route that parses the preference (/api/mcp/chat-v2)
 *    is not mounted hosted at all.
 *  - An ABSENT preference reproduces the legacy cloud-family fork byte-for-
 *    byte — deploy-skew safe, and it makes consent server-enforceable
 *    ("local requires an explicit, verified ask").
 *  - An explicit `local` that can't be honored (kill switch off, consent
 *    invalid, no bash) resolves `unavailable`, NEVER silently cloud — the
 *    user asked for their machine; running elsewhere unannounced is the exact
 *    dishonesty this program removes.
 *  - Ephemeral sandbox paths never consult this module: `sandbox-bash`,
 *    evals, swarms, and scenario provisioning have no import path here.
 */
import { HOSTED_MODE, LOCAL_COMPUTER_ENABLED } from "../../config.js";
import { isComputersDataPlaneConfigured } from "./control-plane-client.js";
import { getComputersRemoteDataPlaneUrl } from "./remote-data-plane.js";
import { isLocalComputerEngineAvailable } from "./local-machine.js";

export type ComputerEngine = "e2b" | "delegated" | "local" | "unavailable";

function resolveCloudFamily(): ComputerEngine {
  if (isComputersDataPlaneConfigured()) return "e2b";
  return getComputersRemoteDataPlaneUrl() ? "delegated" : "unavailable";
}

export function resolvePersonalComputerEngine(args: {
  /** Validated Local⇄Cloud toggle off the request; absent ⇒ legacy cloud. */
  preference?: "local" | "cloud";
  /** Did the `X-MCPJam-Local-Consent` capability verify for this request? */
  localConsentValid: boolean;
}): ComputerEngine {
  if (HOSTED_MODE || args.preference !== "local") {
    return resolveCloudFamily();
  }
  if (!LOCAL_COMPUTER_ENABLED) return "unavailable";
  if (!args.localConsentValid) return "unavailable";
  return isLocalComputerEngineAvailable().available ? "local" : "unavailable";
}

export interface PersonalEngineActor {
  isGuest: boolean;
  isScenarioSession: boolean;
  isJourneySession: boolean;
  executionScopeKind?: "project" | "swarm" | undefined;
}

/**
 * Fail-closed downgrade at the tool-construction chokepoint: `local` is legal
 * only for a signed-in member's own direct turn. Every other actor — guests,
 * share-link scenario sessions, journey/swarm sessions, host-funded swarm
 * scopes — re-resolves to the cloud family, whatever arrived on ctx. This is
 * the second, independent layer under the route-level parse gates.
 */
export function coercePersonalEngineForActor(
  engine: ComputerEngine,
  actor: PersonalEngineActor
): ComputerEngine {
  if (engine !== "local") return engine;
  const eligible =
    !actor.isGuest &&
    !actor.isScenarioSession &&
    !actor.isJourneySession &&
    (actor.executionScopeKind === undefined ||
      actor.executionScopeKind === "project");
  return eligible ? "local" : resolveCloudFamily();
}
