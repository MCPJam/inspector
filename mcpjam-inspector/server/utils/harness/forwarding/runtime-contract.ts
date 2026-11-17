import type { HarnessV1 } from "@ai-sdk/harness";
import type { McpProtocolVersion } from "@mcpjam/sdk";
import type { HarnessMcpJson } from "../mcp-config.js";

/**
 * What the pinned runtime's own MCP client sends when it connects, as
 * measured. A client profile pinned to these values presents the runtime's
 * own client, so native admission counts those pins as no gap. Absent
 * protocol settings mean the runtime negotiates as MCPJam's default (Auto).
 */
export type NativeClientHandshake = {
  clientInfo: { name: string; version: string } & Record<string, unknown>;
  capabilities: Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersion?: McpProtocolVersion;
  versionNegotiation?: "legacy-first";
};

/** Vendor-owned continuation behavior; authorization and policy stay shared. */
export type ForwardingRuntimeContract = {
  runtimeVersion: string;
  /** Changes to launch configuration must not reuse an older live process. */
  configurationVersion?: string;
  correlationKey?: string;
  /** Shared MCPJam handlers may fulfill input alongside this runtime. */
  ownedInput?: boolean;
  /** The user approves at the runtime's own prompt, and that answer is bound
   *  to one forwarded request; MCPJam never answers the prompt for it. */
  boundApprovals?: true;
  /** Measured at `runtimeVersion`; a runtime that was not measured has none. */
  nativeClient?: NativeClientHandshake;
  refresh<T extends HarnessV1>(
    runtime: T,
    servers: HarnessMcpJson["mcpServers"],
    policyDigest: string,
    context?: {
      /** This turn's MCP configuration is the lane's session configuration,
       *  identical to the one a paused turn started with. */
      sessionStable?: boolean;
    },
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

/** Whether a hosted message may run on an agent kept warm in its box. A
 *  `refresh` runtime needs its qualified contract to apply the message's MCP
 *  configuration to the live agent; a `restart` runtime resumes its session. */
export function hostedWarmAgentEligible(adapter: {
  hostedWarmAgent?: "refresh" | "restart";
  pinnedRuntimeVersion?: string;
  forwardingRuntime?: ForwardingRuntimeContract;
}): boolean {
  return (
    adapter.hostedWarmAgent === "restart" ||
    (adapter.hostedWarmAgent === "refresh" &&
      qualifiedForwardingRuntime(adapter) !== undefined)
  );
}
