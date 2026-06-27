import { type MCPClientManager, type MCPServerConfig } from "@mcpjam/sdk";
import {
  HOST_TEMPLATE_IDS,
  seedHostTemplate,
  type HostTemplateId,
} from "@mcpjam/sdk/host-config/templates";
import {
  applyVisibilityPolicyAndCountSignals,
  extractHostExecutionPolicy,
  hostConnectionProfile,
  isAppOnlyTool,
  type HostConnectionProfile,
  type HostExecutionPolicy,
  type ToolMetadataSource,
} from "@mcpjam/sdk/host-config/internal";
import { usageError } from "./output.js";

export interface ResolvedHost {
  id: HostTemplateId;
  /** Pins for the `initialize` handshake (clientInfo/capabilities/protocol). */
  connection: HostConnectionProfile;
  /** Execution policy — drives tool-visibility filtering. */
  policy: HostExecutionPolicy;
}

/** Seed a host by id and derive its connection profile + execution policy. */
export function resolveHostConnection(hostId: string): ResolvedHost {
  if (!(HOST_TEMPLATE_IDS as readonly string[]).includes(hostId)) {
    throw usageError(
      `Unknown host "${hostId}". Valid hosts: ${HOST_TEMPLATE_IDS.join(", ")}.`,
    );
  }
  const id = hostId as HostTemplateId;
  const seeded = seedHostTemplate(id) as unknown as Record<string, unknown>;
  return {
    id,
    connection: hostConnectionProfile(seeded),
    policy: extractHostExecutionPolicy(seeded, id),
  };
}

/**
 * Resolve `--host`, rejecting the conflict with `--client-capabilities` (both
 * set the *exact* advertised client capabilities, so they're mutually
 * exclusive). Returns `undefined` when `--host` is absent.
 */
export function resolveHostFromOptions(options: {
  host?: string;
  clientCapabilities?: unknown;
}): ResolvedHost | undefined {
  if (!options.host) return undefined;
  if (options.clientCapabilities !== undefined) {
    throw usageError(
      "--host advertises the host's client capabilities; pass --host or --client-capabilities, not both.",
    );
  }
  return resolveHostConnection(options.host);
}

/** Merge a host's connection pins onto a parsed server config. */
export function applyHostToConfig(
  config: MCPServerConfig,
  host: HostConnectionProfile,
): MCPServerConfig {
  const identity = {
    ...(host.clientInfo ? { clientInfo: host.clientInfo } : {}),
    ...(host.clientCapabilities
      ? { clientCapabilities: host.clientCapabilities }
      : {}),
    ...(host.supportedProtocolVersions
      ? { supportedProtocolVersions: host.supportedProtocolVersions }
      : {}),
  };
  // `mcpProtocolVersion` is HTTP-only (the stateless wire-mode pin).
  const httpOnly =
    "url" in config && host.mcpProtocolVersion
      ? { mcpProtocolVersion: host.mcpProtocolVersion }
      : {};
  return { ...config, ...identity, ...httpOnly } as MCPServerConfig;
}

/**
 * Apply a host's tool-visibility policy to a listed tool array, dropping
 * app-only tools the host's model can't see, and report how many were dropped.
 * Reuses the shared `applyVisibilityPolicyAndCountSignals` (no-op when the host
 * opts out via `respectToolVisibility: false`) so counts match chat/eval.
 */
export function applyHostVisibility(
  tools: Array<Record<string, unknown>>,
  manager: MCPClientManager,
  serverId: string,
  policy: HostExecutionPolicy,
): { tools: Array<Record<string, unknown>>; toolsDroppedVisibility: number } {
  const record: Record<string, Record<string, unknown>> = {};
  for (const tool of tools) {
    record[String(tool.name)] = { ...tool, _serverId: serverId };
  }
  const signals = applyVisibilityPolicyAndCountSignals(
    record,
    manager as unknown as ToolMetadataSource,
    policy,
  );
  const visible = tools.filter((tool) => String(tool.name) in record);
  return { tools: visible, toolsDroppedVisibility: signals.toolsDroppedVisibility };
}

/**
 * Reject calling an app-only tool when running as a host whose model can't see
 * it — `--host` simulates that host. (No-op when the host opts out of
 * visibility, or when the tool is model-visible.)
 */
export function assertToolVisibleToHost(
  manager: MCPClientManager,
  serverId: string,
  toolName: string,
  host: ResolvedHost,
): void {
  if (host.policy.respectToolVisibility === false) return;
  // getAllToolsMetadata returns name → the tool's `_meta` (with `.ui` at top
  // level), which is exactly what isAppOnlyTool reads.
  const meta = manager.getAllToolsMetadata(serverId)[toolName] as
    | Record<string, unknown>
    | undefined;
  if (isAppOnlyTool(meta)) {
    throw usageError(
      `Tool "${toolName}" is app-only — not visible to host "${host.id}"'s model. Omit --host to call it as an operator.`,
    );
  }
}
