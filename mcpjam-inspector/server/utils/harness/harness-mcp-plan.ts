/**
 * The MCP route a harness turn takes, decided once after its servers connect.
 *
 * Pure: every input is a fact the runner already holds, so a new harness gets
 * its route from its adapter's declarations alone. The runner still provisions
 * whatever route this returns.
 *
 * Two fields describe a route. `upstream` is who talks to the user's server:
 * MCPJam's MCP client, or the harness's own client with its bytes forwarded.
 * `delivery` is how the harness gets the tools: in-process host tools, or an
 * MCP endpoint its native client dials. Whose handshake MCPJam's client used
 * is a fact of the connection the runner builds, so it is not decided here.
 */
import type {
  HarnessMcpAtTurnDelivery,
  HarnessMcpAtTurnForwardingKind,
  HarnessMcpAtTurnUpstream,
} from "@mcpjam/sdk/host-config/internal";
import type { HarnessDiscoveryRoute } from "@/shared/harness-model-support";
import type { AgentLoopDispatch } from "./agent-loop-dispatch";
import type { ForwardingRuntimeContract } from "./forwarding/runtime-contract";
import type { HarnessMcpProxyStrategy } from "./harness-proxy-strategy";

export const HARNESS_MCP_PLANNER_VERSION = "harness-mcp-plan-v1";

/** Why a turn did not forward, in the order the planner checks. */
export const HARNESS_MCP_PLAN_REASONS = [
  "forwarding flag off",
  "organization not enrolled",
  "runtime contract unqualified",
  "plane is not web-authorized",
  "scenario turn",
  "eval iteration",
  "journey run",
  "local execution target",
  "no host id",
  "no servers selected",
  "account routing",
  "forwarding not admitted; configured route retained",
] as const;
export type HarnessMcpPlanReason = (typeof HARNESS_MCP_PLAN_REASONS)[number];

export type HarnessForwardingAdmission = {
  delivery?: "native" | "bridge";
  gaps: string[];
};

export type HarnessMcpPlanFacts = {
  /** The MCP client the loop dispatch configured for this turn. */
  dispatch: Pick<AgentLoopDispatch, "mcpClient">;
  /** `qualifiedForwardingRuntime(adapter)`: absent once the pin moves. */
  forwardingRuntime: ForwardingRuntimeContract | undefined;
  forwardingOrganization: boolean;
  accountRouting: boolean;
  forwardingEnabled: boolean;
  plane: HarnessMcpProxyStrategy["plane"] | undefined;
  selectedServerCount: number;
  hostId?: string;
  scenarioId?: string;
  evalIterationId?: string;
  journeyRunId?: string;
  localExecution: boolean;
  /** The capability check, run once and only for a forwarding candidate. */
  admit: () => HarnessForwardingAdmission;
};

export type HarnessMcpPlan = {
  upstream: HarnessMcpAtTurnUpstream;
  delivery: HarnessMcpAtTurnDelivery;
  forwardingKind?: HarnessMcpAtTurnForwardingKind;
  /** The hosted-chat forwarding surface is open for this turn. */
  surface: boolean;
  /** The turn was offered to the forwarding admission check. */
  candidate: boolean;
  gaps: string[];
  reasons: HarnessMcpPlanReason[];
};

/** Hosted chat turns only: scenarios, evals, journeys and local runs never forward. */
export function hostedForwardingSurface(facts: {
  hostId?: string;
  scenarioId?: string;
  evalIterationId?: string;
  journeyRunId?: string;
  localExecution: boolean;
}): boolean {
  return (
    !!facts.hostId &&
    !facts.scenarioId &&
    !facts.evalIterationId &&
    !facts.journeyRunId &&
    !facts.localExecution
  );
}

export function resolveHarnessMcpPlan(
  facts: HarnessMcpPlanFacts,
): HarnessMcpPlan {
  const configuredHarnessClient = facts.dispatch.mcpClient === "harness";
  const reasons: HarnessMcpPlanReason[] = [];
  const refuse = (blocked: boolean, reason: HarnessMcpPlanReason) => {
    if (blocked) reasons.push(reason);
  };
  refuse(!facts.forwardingEnabled, "forwarding flag off");
  refuse(!facts.forwardingOrganization, "organization not enrolled");
  refuse(facts.forwardingRuntime === undefined, "runtime contract unqualified");
  refuse(facts.plane !== "web-authorized", "plane is not web-authorized");
  refuse(!!facts.scenarioId, "scenario turn");
  refuse(!!facts.evalIterationId, "eval iteration");
  refuse(!!facts.journeyRunId, "journey run");
  refuse(facts.localExecution, "local execution target");
  refuse(!facts.hostId, "no host id");
  const surface = reasons.length === 0;
  refuse(facts.selectedServerCount === 0, "no servers selected");
  refuse(!configuredHarnessClient && facts.accountRouting, "account routing");
  const candidate = reasons.length === 0;
  const admission: HarnessForwardingAdmission = candidate
    ? facts.admit()
    : { gaps: [] };
  refuse(
    candidate && admission.delivery === undefined,
    "forwarding not admitted; configured route retained",
  );
  const forwardingKind: HarnessMcpAtTurnForwardingKind | undefined =
    admission.delivery === "native"
      ? "pass-through"
      : admission.delivery === "bridge"
        ? "profiled"
        : undefined;
  return {
    upstream: forwardingKind === "pass-through" ? "harness" : "mcpjam",
    delivery:
      forwardingKind !== undefined || configuredHarnessClient
        ? "mcp-endpoint"
        : "host-tools",
    ...(forwardingKind !== undefined ? { forwardingKind } : {}),
    surface,
    candidate,
    gaps: admission.gaps,
    reasons,
  };
}

/** The label the discovery evidence table records routes under. */
export function toDiscoveryDeliveryLabel(
  plan: Pick<HarnessMcpPlan, "delivery" | "forwardingKind">,
): HarnessDiscoveryRoute["delivery"] {
  if (plan.forwardingKind === "profiled") return "forwarded-bridge";
  if (plan.forwardingKind === "pass-through") return "forwarded-native";
  return plan.delivery === "mcp-endpoint" ? "native-proxy" : "host-tools";
}

export function harnessDiscoveryRoute(
  plan: Pick<HarnessMcpPlan, "delivery" | "forwardingKind">,
  route: Omit<HarnessDiscoveryRoute, "delivery">,
): HarnessDiscoveryRoute {
  return { ...route, delivery: toDiscoveryDeliveryLabel(plan) };
}
