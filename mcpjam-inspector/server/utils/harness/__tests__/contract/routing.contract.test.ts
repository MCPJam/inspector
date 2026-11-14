import { describe, expect, it, vi } from "vitest";
import { HARNESS_MCP_DELIVERY } from "@/shared/harness-mcp-delivery";
import { resolveAgentLoop } from "../../agent-loop-dispatch";
import { qualifiedForwardingRuntime } from "../../forwarding/runtime-contract";
import {
  resolveHarnessMcpPlan,
  toDiscoveryDeliveryLabel,
} from "../../harness-mcp-plan";
import { CASES, assertFullMatrix, bumpedPin, hostedChatFacts } from "./support";

it("covers every registered harness", assertFullMatrix);

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
      hostedChatFacts({ dispatch: configured(), forwardingEnabled: false }),
    );
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
        admit,
      }),
    );
    expect(plan.delivery).toBe("host-tools");
    expect(admit).not.toHaveBeenCalled();
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
      hostedChatFacts({ dispatch: configured(), forwardingRuntime: moved }),
    );
    expect(plan.forwardingKind).toBeUndefined();
    expect(plan.reasons).toContain("runtime contract unqualified");
  });

  it("takes the profiled bridge only when its contract lets MCPJam's client stand in", () => {
    const contract = qualifiedForwardingRuntime(adapter);
    const plan = resolveHarnessMcpPlan(
      hostedChatFacts({
        dispatch: configured(),
        forwardingRuntime: contract,
        admit: () => ({ delivery: "bridge", gaps: ["app-host-capabilities"] }),
      }),
    );
    expect(plan.forwardingKind).toBe(
      contract && !contract.passThroughOnly ? "profiled" : undefined,
    );
    if (contract?.passThroughOnly) {
      expect(plan.gaps).toEqual(["app-host-capabilities"]);
      expect(plan.reasons).toEqual([
        "forwarding not admitted; configured route retained",
      ]);
    }
  });

  it("reaches a forwarded label only when it declares a forwarding contract", () => {
    const plan = resolveHarnessMcpPlan(
      hostedChatFacts({
        dispatch: configured(),
        forwardingRuntime: qualifiedForwardingRuntime(adapter),
      }),
    );
    const label = toDiscoveryDeliveryLabel(plan);
    if (adapter.forwardingRuntime) {
      expect(label).toBe("forwarded-native");
    } else {
      expect(label).not.toMatch(/^forwarded-/);
    }
  });
});
