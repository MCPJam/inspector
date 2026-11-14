import { describe, expect, it } from "vitest";
import {
  qualifiedForwardingRuntime,
  type ForwardingRuntimeContract,
} from "../runtime-contract.js";

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
