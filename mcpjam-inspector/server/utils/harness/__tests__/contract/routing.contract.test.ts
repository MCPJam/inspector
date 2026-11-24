import { describe, expect, it, vi } from "vitest";
import { HARNESS_MCP_DELIVERY } from "@/shared/harness-mcp-delivery";
import { resolveAgentLoop } from "../../agent-loop-dispatch";
import { qualifiedForwardingRuntime } from "../../forwarding/runtime-contract";
import {
  HARNESS_MCP_PLAN_REASONS,
  resolveHarnessMcpPlan,
  toDiscoveryDeliveryLabel,
  type HarnessForwardingAdmission,
  type HarnessMcpPlanFacts,
} from "../../harness-mcp-plan";
import { CASES, assertFullMatrix, bumpedPin, hostedChatFacts } from "./support";
import type { HarnessRuntimeAdapter } from "../../registry";

it("covers every registered harness", assertFullMatrix);

/**
 * A web client has its own route on every surface, declared by its adapter:
 * the vendor's MCP client always reaches the servers through the forwarding
 * endpoint, so none of the forwarding exclusions applies to it.
 */
const webRoute = (adapter: HarnessRuntimeAdapter) =>
  adapter.mcpNativeDelivery === "web-connector";
const WEB_PLAN = {
  upstream: "harness",
  delivery: "mcp-endpoint",
  forwardingKind: "pass-through",
  gaps: [],
  reasons: [],
} as const;

describe.each(CASES)("$id routing", ({ id, adapter, descriptor }) => {
  const configured = () =>
    resolveAgentLoop({
      harness: id,
      defaultMcpClient:
        adapter.mcpDelivery === "harness" ? "harness" : "mcpjam",
    });

  it("declares one MCP client in the adapter, the shared table and the descriptor", () => {
    expect(HARNESS_MCP_DELIVERY[id]).toBe(adapter.mcpDelivery);
    expect(descriptor.mcpClient).toBe(
      adapter.mcpDelivery === "harness" ? "harness" : "mcpjam",
    );
    expect(configured().mcpClient).toBe(descriptor.mcpClient);
  });

  it("keeps an unforwarded chat on the configured route", () => {
    const plan = resolveHarnessMcpPlan(
      hostedChatFacts({
        dispatch: configured(),
        forwardingEnabled: false,
        webConnector: webRoute(adapter),
      }),
    );
    if (webRoute(adapter)) {
      expect(plan).toMatchObject(WEB_PLAN);
      expect(toDiscoveryDeliveryLabel(plan)).toBe("forwarded-native");
      return;
    }
    expect(plan.upstream).toBe("mcpjam");
    expect(toDiscoveryDeliveryLabel(plan)).toBe(
      descriptor.mcpClient === "harness" ? "native-proxy" : "host-tools",
    );
  });

  it("moves account-routed chats to MCPJam's client and never forwards them", () => {
    const dispatch = resolveAgentLoop({
      harness: id,
      defaultMcpClient:
        adapter.mcpDelivery === "harness" ? "harness" : "mcpjam",
      hasAccountRouting: true,
    });
    expect(dispatch.mcpClient).toBe("mcpjam");
    const admit = vi.fn(() => ({ delivery: "native" as const, gaps: [] }));
    const plan = resolveHarnessMcpPlan(
      hostedChatFacts({
        dispatch,
        accountRouting: true,
        forwardingRuntime: qualifiedForwardingRuntime(adapter),
        webConnector: webRoute(adapter),
        admit,
      }),
    );
    expect(admit).not.toHaveBeenCalled();
    if (webRoute(adapter)) {
      // The vendor's client picks no MCPJam account: the connector's own
      // credential is what the endpoint forwards with.
      expect(plan).toMatchObject(WEB_PLAN);
      return;
    }
    expect(plan.delivery).toBe("host-tools");
  });

  it("runs a client that picks this harness as its loop on MCPJam's client", () => {
    expect(resolveAgentLoop({ agentLoop: id })).toMatchObject({
      loop: "harness",
      mcpClient: "mcpjam",
    });
  });

  it("forwards only through a contract qualified at the current pin", () => {
    const contract = qualifiedForwardingRuntime(adapter);
    if (adapter.forwardingRuntime) {
      expect(contract).toBe(adapter.forwardingRuntime);
      expect(contract?.runtimeVersion).toBe(adapter.pinnedRuntimeVersion);
    } else {
      expect(contract).toBeUndefined();
    }
    const moved = qualifiedForwardingRuntime({
      ...adapter,
      pinnedRuntimeVersion: bumpedPin(adapter.pinnedRuntimeVersion ?? "0"),
    });
    expect(moved).toBeUndefined();
    const plan = resolveHarnessMcpPlan(
      hostedChatFacts({
        dispatch: configured(),
        forwardingRuntime: moved,
        webConnector: webRoute(adapter),
      }),
    );
    if (webRoute(adapter)) {
      // No CLI pin to qualify: the page module is what a run is compared by.
      expect(plan).toMatchObject(WEB_PLAN);
      return;
    }
    expect(plan.forwardingKind).toBeUndefined();
    expect(plan.reasons).toContain("runtime contract unqualified");
  });

  it("takes the profiled bridge whenever admission bridges a turn its contract qualifies", () => {
    const contract = qualifiedForwardingRuntime(adapter);
    const plan = resolveHarnessMcpPlan(
      hostedChatFacts({
        dispatch: configured(),
        forwardingRuntime: contract,
        webConnector: webRoute(adapter),
        admit: () => ({ delivery: "bridge", gaps: ["app-host-capabilities"] }),
      }),
    );
    if (webRoute(adapter)) {
      // There is no bridge for a website to fall back to.
      expect(plan).toMatchObject(WEB_PLAN);
      return;
    }
    expect(plan.forwardingKind).toBe(contract ? "profiled" : undefined);
    expect(plan.reasons).toEqual(contract ? [] : ["runtime contract unqualified"]);
  });

  it("reaches a forwarded label only when it declares a forwarding contract", () => {
    const plan = resolveHarnessMcpPlan(
      hostedChatFacts({
        dispatch: configured(),
        forwardingRuntime: qualifiedForwardingRuntime(adapter),
        webConnector: webRoute(adapter),
      }),
    );
    const label = toDiscoveryDeliveryLabel(plan);
    if (adapter.forwardingRuntime || webRoute(adapter)) {
      expect(label).toBe("forwarded-native");
    } else {
      expect(label).not.toMatch(/^forwarded-/);
    }
  });
});

/** Each product area as the planner sees a turn there. */
const PRODUCT_AREAS: Array<[string, Partial<HarnessMcpPlanFacts>]> = [
  ["the Playground, forwarding open", {}],
  ["the Playground, forwarding off", { forwardingEnabled: false }],
  ["the Playground, organization not enrolled", { forwardingOrganization: false }],
  ["evals", { evalIterationId: "iteration-1" }],
  ["swarms", { journeyRunId: "journey-run-1" }],
  ["User Testing", { scenarioId: "scenario-1" }],
  ["the v1 API", { hostId: undefined }],
  ["a member's computer", { localExecution: true, plane: "local-loopback" }],
];
const ADMISSIONS: Array<[string, () => HarnessForwardingAdmission]> = [
  ["admits pass-through", () => ({ delivery: "native", gaps: [] })],
  ["admits the bridge", () => ({ delivery: "bridge", gaps: ["unqualified-protocol"] })],
  ["admits neither", () => ({ gaps: ["client-tools"] })],
];

describe.each(CASES)("$id in every product area", ({ id, adapter, descriptor }) => {
  const dispatch = resolveAgentLoop({
    harness: id,
    defaultMcpClient: adapter.mcpDelivery === "harness" ? "harness" : "mcpjam",
  });
  const configuredDelivery =
    descriptor.mcpClient === "harness" ? "mcp-endpoint" : "host-tools";

  it.each(PRODUCT_AREAS)("routes its servers in %s, whatever admission says", (area, overrides) => {
    const contract = qualifiedForwardingRuntime(adapter);
    const opens = area === "the Playground, forwarding open" && contract !== undefined;
    for (const [said, admit] of ADMISSIONS) {
      const plan = resolveHarnessMcpPlan(
        hostedChatFacts({
          dispatch,
          forwardingRuntime: contract,
          admit,
          webConnector: webRoute(adapter),
          ...overrides,
        }),
      );
      const label = `${area}: ${said}`;
      if (webRoute(adapter)) {
        // Its own route everywhere (E4): forwarded, never refused, never
        // moved to MCPJam's client.
        expect(plan, label).toMatchObject(WEB_PLAN);
        continue;
      }
      // No runtime refuses its servers for the route: every turn gets one.
      expect(plan, label).not.toHaveProperty("refused");
      expect(["mcp-endpoint", "host-tools"], label).toContain(plan.delivery);
      for (const reason of plan.reasons)
        expect(HARNESS_MCP_PLAN_REASONS, label).toContain(reason);
      // Forwarding follows admission alone, with no runtime-specific route.
      const kind = !opens
        ? undefined
        : said === "admits pass-through"
          ? "pass-through"
          : said === "admits the bridge"
            ? "profiled"
            : undefined;
      expect(plan.forwardingKind, label).toBe(kind);
      if (kind === undefined)
        expect(plan.delivery, label).toBe(configuredDelivery);
    }
  });

  it("asks admission once, before anything is dispatched", () => {
    const admit = vi.fn(() => ({ delivery: "bridge" as const, gaps: [] }));
    resolveHarnessMcpPlan(
      hostedChatFacts({ dispatch, forwardingRuntime: qualifiedForwardingRuntime(adapter), admit }),
    );
    expect(admit).toHaveBeenCalledTimes(qualifiedForwardingRuntime(adapter) ? 1 : 0);
  });
});
