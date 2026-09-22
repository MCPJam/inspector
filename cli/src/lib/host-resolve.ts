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
  // Both of these are HTTP-only: the stateless wire-mode pin, and the SEP-2243
  // mirroring knob (mirroring is a Streamable HTTP concern, so the flag is
  // inert on stdio and is not worth putting on the config there).
  const httpOnly =
    "url" in config
      ? {
          ...(host.mcpProtocolVersion
            ? { mcpProtocolVersion: host.mcpProtocolVersion }
            : {}),
          ...(host.mirrorToolParamHeaders === false
            ? { mirrorToolParamHeaders: false }
            : {}),
        }
      : {};
  // The client-conformance knobs are NOT http-only, unlike the two above.
  // Pagination truncation is enforced by a transport wrapper on JSON-RPC
  // frames, and the MRTR knob works through capability advertisement and the
  // verb gates — neither mechanism is Streamable-HTTP-specific, and both are
  // behaviors a stdio client can exhibit. Gating them to `url` would make a
  // `--host` silently mean something different over stdio.
  const conformance = {
    ...(host.firstPageOnly ? { firstPageOnly: true } : {}),
    ...(host.supportsMrtr === false ? { supportsMrtr: false } : {}),
  };
  return {
    ...config,
    ...identity,
    ...httpOnly,
    ...conformance,
  } as MCPServerConfig;
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

// Bound the tools pagination so a pathological server can't loop forever.
const TOOLS_PAGE_CAP = 50;

/**
 * Reject calling an app-only tool when running as a host whose model can't see
 * it — `--host` simulates that host. (No-op when the host opts out of
 * visibility, or when the tool is model-visible / unlisted.)
 *
 * `executeTool` connects but does NOT list tools, so the manager's metadata map
 * is empty here — we list the tools ourselves (across pages) and read the
 * requested tool's inline `_meta` directly.
 */
export async function assertToolVisibleToHost(
  manager: MCPClientManager,
  serverId: string,
  toolName: string,
  host: ResolvedHost,
): Promise<void> {
  if (host.policy.respectToolVisibility === false) return;
  let cursor: string | undefined;
  for (let page = 0; page < TOOLS_PAGE_CAP; page++) {
    const result = await manager.listTools(
      serverId,
      // Presence, not truthiness: `""` is a valid continuation cursor.
      cursor !== undefined ? { cursor } : undefined,
    );
    const tool = (result.tools ?? []).find(
      (t) => (t as { name?: unknown }).name === toolName,
    ) as { _meta?: Record<string, unknown> } | undefined;
    if (tool) {
      if (isAppOnlyTool(tool._meta)) {
        throw usageError(
          `Tool "${toolName}" is app-only — not visible to host "${host.id}"'s model. Omit --host to call it as an operator.`,
        );
      }
      return; // found and model-visible
    }
    cursor = result.nextCursor;
    // Paged through the WHOLE list without finding it → genuinely unlisted;
    // allow the call (the server may still expose it). "Whole list" means the
    // server stopped handing out cursors — MCP 2026-07-28
    // `server/utilities/pagination` makes `""` a valid cursor that MUST NOT be
    // read as the end of results.
    //
    // There is no repeated-cursor guard here: comparing two cursors for
    // equality is itself a determination based on cursor value, and a server
    // may legally reissue one constant token for every page. The cap bounds
    // the walk, and hitting it already fails CLOSED below.
    if (cursor === undefined) return;
  }
  // Couldn't page through the full tool list (hit the page cap) and the tool
  // hasn't appeared — can't confirm it's model-visible, so fail CLOSED.
  throw usageError(
    `Could not verify "${toolName}" is visible to host "${host.id}" — the server's tool list is too long to page through. Omit --host to call it as an operator.`,
  );
}
