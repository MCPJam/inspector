import type { HarnessV1 } from "@ai-sdk/harness";
import type { HarnessMcpJson } from "../mcp-config.js";

/** Vendor-owned continuation behavior; authorization and policy stay shared. */
export type ForwardingRuntimeContract = {
  runtimeVersion: string;
  refresh<T extends HarnessV1>(
    runtime: T,
    servers: HarnessMcpJson["mcpServers"],
    policyDigest: string,
  ): T;
};

/** A runtime upgrade must qualify its forwarding contract again. */
export function qualifiedForwardingRuntime(adapter: {
  pinnedRuntimeVersion?: string;
  forwardingRuntime?: ForwardingRuntimeContract;
}): ForwardingRuntimeContract | undefined {
  const contract = adapter.forwardingRuntime;
  return contract && contract.runtimeVersion === adapter.pinnedRuntimeVersion
    ? contract
    : undefined;
}
