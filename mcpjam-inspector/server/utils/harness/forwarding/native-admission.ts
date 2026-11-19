import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config";
import { isNativeElicitationProfile } from "./native-elicitation-profile.js";
import { isEnhancedModelPolicy } from "../harness-connection-profile.js";
import { canonicalJson } from "../../tool-approval-token.js";
import type { NativeClientHandshake } from "./runtime-contract.js";
import type { HarnessHostCapabilityQualification } from "@/shared/harness-host-capabilities";

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
  hostCapabilities?: HarnessHostCapabilityQualification;
  /** Set only with a live owned elicitation handler for this pinned runtime. */
  elicitationRuntimeVersion?: string;
  /** The qualified runtime's measured handshake, if it has one. */
  nativeClient?: NativeClientHandshake;
};

const PROTOCOL_SETTINGS = [
  "mcpProtocolVersion",
  "supportedProtocolVersions",
  "versionNegotiation",
] as const;

/** A pin the runtime's own client shares adds nothing to its handshake. */
function differsFromNative(value: unknown, native: unknown): boolean {
  return value !== undefined && canonicalJson(value) !== canonicalJson(native);
}

/** UI host promises participate only on connections that declare MCP Apps. */
export function usesAppHostCapabilities(
  candidate: Pick<Candidate, "manager" | "serverIds">,
): boolean {
  return candidate.serverIds.some((serverId) => {
    const caps =
      candidate.manager.getInitializationInfo(serverId)?.clientCapabilities ??
      candidate.manager.getServerConfig(serverId)?.clientCapabilities;
    const extensions = (
      caps as { extensions?: Record<string, unknown> } | undefined
    )?.extensions;
    return !!extensions?.["io.modelcontextprotocol/ui"];
  });
}

/** Unqualified profiles keep their configured bridge before a turn starts. */
export function nativeForwardingGaps(candidate: Candidate): string[] {
  const gaps = new Set<string>();
  if (usesAppHostCapabilities(candidate)) {
    if (!candidate.hostCapabilities) gaps.add("host-capabilities-missing");
    else {
      if (candidate.hostCapabilities.gaps.length)
        gaps.add("unsupported-host-capabilities");
      if (Object.keys(candidate.hostCapabilities.capabilities).length)
        gaps.add("app-host-capabilities");
    }
  }
  if (candidate.hasClientTools) gaps.add("client-tools");
  if (candidate.hasTasks) gaps.add("tasks");
  if (candidate.respectToolVisibility !== false) gaps.add("tool-visibility");
  if (!isEnhancedModelPolicy(candidate.modelVisibleMcpToolResults))
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
    const elicitationProfile =
      isNativeElicitationProfile(capabilities, candidate.elicitationRuntimeVersion) &&
      initialized?.protocolVersion === "2025-11-25";
    // The runtime's own client declares the same set. A turn hands a
    // server's elicitation to its live handler only for the profile above, so
    // a runtime client that declares elicitation otherwise (Cursor CLI's
    // declines it) would answer the server itself, where MCPJam's connection
    // asks the member.
    const native = candidate.nativeClient;
    const nativeProfile =
      elicitationProfile ||
      (!!native &&
        !!capabilities &&
        !("elicitation" in native.capabilities) &&
        !differsFromNative(capabilities, native.capabilities));
    if (
      (!capabilities || Object.keys(capabilities).length > 0) && !nativeProfile
    )
      gaps.add("client-capabilities");
    // The SDK ignores both overlays when an exact declaration is installed.
    const inactiveOverrides =
      nativeProfile && Boolean(config.clientCapabilities);
    if (
      !inactiveOverrides &&
      ((config.capabilities && Object.keys(config.capabilities).length > 0) ||
        config.eraCapabilities)
    )
      gaps.add("capability-overrides");
    if (differsFromNative(config.clientInfo, native?.clientInfo) || config.version)
      gaps.add("client-identity");
    // The runtime's own negotiation is no pin: the connection negotiates as
    // the runtime's client does, and what it lands on is judged below.
    const protocol: Partial<Record<(typeof PROTOCOL_SETTINGS)[number], unknown>> =
      config;
    if (
      PROTOCOL_SETTINGS.some((key) =>
        differsFromNative(protocol[key], native?.[key]),
      )
    )
      gaps.add("protocol-pins");
    // On pass-through the runtime's own client speaks to the server, so the
    // version this connection landed on must be one that client offers.
    if (
      !initialized ||
      initialized.transport !== "streamable-http" ||
      !["2025-03-26", "2025-06-18", "2025-11-25"].includes(
        initialized.protocolVersion ?? "",
      ) ||
      (native?.supportedProtocolVersions !== undefined &&
        !native.supportedProtocolVersions.includes(
          initialized.protocolVersion ?? "",
        ))
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
