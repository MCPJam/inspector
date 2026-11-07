/**
 * Required native tool discovery, checked against the route the planner chose.
 *
 * Only a client that requires native discovery reaches the checks; every other
 * turn returns at once. Each refusal happens before any token is minted or
 * sandbox woken.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import type { HarnessHostCapabilityQualification } from "@/shared/harness-host-capabilities";
import {
  harnessOrgUpstream,
  type HarnessDiscoveryRoute,
} from "@/shared/harness-model-support";
import { usesAppHostCapabilities } from "./forwarding/native-admission.js";
import {
  harnessDiscoveryRoute,
  type HarnessMcpPlan,
} from "./harness-mcp-plan.js";
import type { HarnessMcpProxyStrategy } from "./harness-proxy-strategy.js";
import { assertNativeDiscovery } from "./native-discovery.js";

export function assertHarnessMcpDiscoveryGate(args: {
  required: boolean | undefined;
  plan: Pick<
    HarnessMcpPlan,
    "delivery" | "forwardingKind" | "gaps" | "reasons"
  >;
  harnessId: string;
  pinnedRuntimeVersion: string | undefined;
  adapterVersion: string | undefined;
  manager: MCPClientManager;
  serverIds: string[];
  hostCapabilities: HarnessHostCapabilityQualification | undefined;
  scenarioParticipant: unknown;
  modelId: string;
  sourceType: string | undefined;
  plane: HarnessMcpProxyStrategy["plane"] | undefined;
  localExecution: boolean;
  brokeredEndpoint: string;
}): void {
  if (!args.required) return;
  const { plan, manager, serverIds } = args;
  if (
    plan.gaps.some(
      (gap) =>
        gap === "server-capabilities-unavailable" ||
        gap.startsWith("server-capability:"),
    )
  ) {
    assertNativeDiscovery({ required: true, reasons: plan.reasons });
  }
  if (
    usesAppHostCapabilities({ manager, serverIds }) &&
    (!args.hostCapabilities || args.hostCapabilities.gaps.length)
  ) {
    assertNativeDiscovery({ required: true, reasons: plan.reasons });
  }
  if (!serverIds.length || args.scenarioParticipant) {
    assertNativeDiscovery({ required: true, reasons: plan.reasons });
  }
  const platform = args.brokeredEndpoint === "platform";
  const route: Omit<HarnessDiscoveryRoute, "delivery" | "protocolVersion"> = {
    runtimeVersion: args.pinnedRuntimeVersion ?? "",
    adapterVersion: args.adapterVersion ?? "",
    modelId: args.modelId,
    venue:
      !args.localExecution && args.plane === "web-authorized"
        ? "hosted"
        : "local",
    surface:
      args.sourceType === "eval"
        ? "eval"
        : args.sourceType === "swarm"
          ? "swarm"
          : "chat",
    funding: platform ? "platform" : "organization",
    upstreamProfile: platform
      ? "gateway"
      : (harnessOrgUpstream(args.harnessId)?.profile ?? "gateway"),
  };
  for (const serverId of serverIds) {
    assertNativeDiscovery({
      required: true,
      reasons: plan.reasons,
      harnessId: args.harnessId,
      route: harnessDiscoveryRoute(plan, {
        ...route,
        protocolVersion:
          manager.getInitializationInfo(serverId)?.protocolVersion ?? "",
      }),
    });
  }
}
