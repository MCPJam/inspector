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
  /** MCPJam's client never stands in for this runtime's own, so a turn the
   *  profiled bridge would carry keeps its configured route instead. */
  passThroughOnly?: true;
  /** The user approves at the runtime's own prompt, and that answer is bound
   *  to one forwarded request; MCPJam never answers the prompt for it. */
  boundApprovals?: true;
  /** Measured at `runtimeVersion`; a runtime that was not measured has none. */
  nativeClient?: NativeClientHandshake;
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
