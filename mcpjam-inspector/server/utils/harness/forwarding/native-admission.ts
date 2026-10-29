import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config";

type Candidate = {
  manager: Pick<MCPClientManager, "getServerConfig"> & {
    getInitializationInfo: (serverId: string) =>
      | {
          protocolVersion?: string;
          transport?: string;
          clientCapabilities?: object;
        }
      | null
      | undefined;
  };
  serverIds: string[];
  respectToolVisibility?: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  hasClientTools?: boolean;
  hasTasks?: boolean;
};

/** Unqualified profiles keep their configured bridge before a turn starts. */
export function nativeForwardingGaps(candidate: Candidate): string[] {
  const gaps = new Set<string>();
  if (candidate.hasClientTools) gaps.add("client-tools");
  if (candidate.hasTasks) gaps.add("tasks");
  if (candidate.respectToolVisibility !== false) gaps.add("tool-visibility");
  if (candidate.modelVisibleMcpToolResults !== undefined)
    gaps.add("model-result-policy");
  for (const serverId of candidate.serverIds) {
    const config = candidate.manager.getServerConfig(serverId);
    if (!config || !("url" in config) || config.preferSSE) {
      gaps.add("transport");
      continue;
    }
    const initialized = candidate.manager.getInitializationInfo(serverId);
    const capabilities =
      initialized?.clientCapabilities ?? config.clientCapabilities;
    // Missing is not an empty declaration: manager defaults and runtime
    // handlers can add capabilities that the native client cannot fulfil.
    if (!capabilities || Object.keys(capabilities).length > 0)
      gaps.add("client-capabilities");
    if (
      (config.capabilities && Object.keys(config.capabilities).length > 0) ||
      config.eraCapabilities
    )
      gaps.add("capability-overrides");
    if (config.clientInfo || config.version) gaps.add("client-identity");
    if (
      ("mcpProtocolVersion" in config && config.mcpProtocolVersion) ||
      config.supportedProtocolVersions
    )
      gaps.add("protocol-pins");
    if (
      !initialized ||
      initialized.transport !== "streamable-http" ||
      !["2025-03-26", "2025-06-18", "2025-11-25"].includes(
        initialized.protocolVersion ?? "",
      )
    )
      gaps.add("unqualified-protocol");
    if (config.timeout !== undefined && config.timeout !== 300_000)
      gaps.add("request-timeout");
    if (
      config.sessionId ||
      config.eventSourceInit ||
      config.reconnectionOptions
    )
      gaps.add("connection-options");
    let hasHeaders = false;
    new Headers(config.requestInit?.headers).forEach(() => {
      hasHeaders = true;
    });
    if (
      hasHeaders ||
      (config.requestInit &&
        Object.entries(config.requestInit).some(
          ([key, value]) => key !== "headers" && value !== undefined,
        ))
    )
      gaps.add("request-options");
    if (
      config.mirrorToolParamHeaders === false ||
      config.firstPageOnly ||
      config.supportsMrtr === false ||
      config.suppressListenChannel ||
      config.dropToolListChanged ||
      config.toolCallCancellation
    )
      gaps.add("client-behavior");
  }
  return [...gaps];
}
