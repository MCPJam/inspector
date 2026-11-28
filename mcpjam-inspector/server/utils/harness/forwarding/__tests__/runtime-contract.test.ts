import { describe, expect, it } from "vitest";
import {
  hostedWarmAgentEligible,
  qualifiedForwardingRuntime,
  type ForwardingRuntimeContract,
} from "../runtime-contract.js";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { getHarnessAdapter } from "../../registry.js";

describe("forwarding runtime qualification", () => {
  const contract: ForwardingRuntimeContract = {
    runtimeVersion: "fixture-runtime-1",
    refresh: (runtime) => runtime,
  };

  it("requires an adapter-owned contract", () => {
    expect(qualifiedForwardingRuntime({ pinnedRuntimeVersion: "fixture-runtime-1" })).toBeUndefined();
  });

  it("accepts a matching runtime without consulting a vendor name", () => {
    expect(qualifiedForwardingRuntime({ pinnedRuntimeVersion: "fixture-runtime-1", forwardingRuntime: contract })).toBe(contract);
  });

  it.each([undefined, "fixture-runtime-2"])("refuses the contract when the active pin is %s", (pinnedRuntimeVersion) => {
    expect(qualifiedForwardingRuntime({ pinnedRuntimeVersion, forwardingRuntime: contract })).toBeUndefined();
  });
});

describe("hosted warm agent eligibility", () => {
  const contract: ForwardingRuntimeContract = {
    runtimeVersion: "fixture-runtime-1",
    refresh: (runtime) => runtime,
  };

  it("lets a refresh runtime keep its agent warm only with its qualified contract", () => {
    expect(hostedWarmAgentEligible({ hostedWarmAgent: "refresh", pinnedRuntimeVersion: "fixture-runtime-1", forwardingRuntime: contract })).toBe(true);
    expect(hostedWarmAgentEligible({ hostedWarmAgent: "refresh", pinnedRuntimeVersion: "fixture-runtime-2", forwardingRuntime: contract })).toBe(false);
    expect(hostedWarmAgentEligible({ hostedWarmAgent: "refresh" })).toBe(false);
  });

  it("lets a restart runtime keep its agent warm with no contract, and an undeclared one never", () => {
    expect(hostedWarmAgentEligible({ hostedWarmAgent: "restart" })).toBe(true);
    expect(hostedWarmAgentEligible({ pinnedRuntimeVersion: "fixture-runtime-1", forwardingRuntime: contract })).toBe(false);
  });

  it("keeps today's registered runtimes: Claude Code, Codex and Copilot CLI warm, the others cold", () => {
    const warm = HARNESS_IDS.filter((id) => hostedWarmAgentEligible(getHarnessAdapter(id)));
    expect(warm.sort()).toEqual(["claude-code", "codex", "copilot-cli"]);
  });
});
