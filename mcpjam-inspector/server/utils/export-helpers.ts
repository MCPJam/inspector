/**
 * Shared export logic used by both local (/api/mcp) and hosted (/api/web) routes.
 *
 * Pure function: (manager, serverId) → export payload.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import { logger } from "./logger.js";

type Manager = InstanceType<typeof MCPClientManager>;

export type ServerToolSnapshotTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  metadata?: Record<string, unknown>;
};

// The server's response to MCP `initialize`. Captured alongside the tool
// catalog so the backend's diff engine can surface protocol/capability drift
// across reconnects.
export type ServerToolSnapshotInitialize = {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
};

export type ServerToolSnapshotServer = {
  serverId: string;
  tools: ServerToolSnapshotTool[];
  initialize?: ServerToolSnapshotInitialize;
  captureError?: string;
};

export type ServerToolSnapshot = {
  version: number;
  capturedAt: number;
  servers: ServerToolSnapshotServer[];
};

export type DiscoveredTool = {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
  serverId: string;
};

export type ServerToolSnapshotCaptureResult = {
  status: "missing" | "complete" | "partial";
  serverCount: number;
  toolCount: number;
  failedServerCount: number;
  failedServerIds: string[];
};

export type RenderedServerToolSnapshotSection = {
  promptSection?: string;
  truncated: boolean;
  maxChars: number;
};

export const TOOL_SNAPSHOT_PROMPT_HEADER = `# Available MCP Tools
Treat tool descriptions as authoritative semantics for correct tool ordering, prerequisites, and first-use requirements.`;

export const DEFAULT_TOOL_SNAPSHOT_PROMPT_MAX_CHARS = 30_000;

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableJson);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeForStableJson(entry)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function minifyStableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function sortSnapshotTools(
  tools: ServerToolSnapshotTool[],
): ServerToolSnapshotTool[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function sortSnapshotServers(
  servers: ServerToolSnapshotServer[],
): ServerToolSnapshotServer[] {
  return [...servers].sort((left, right) =>
    left.serverId.localeCompare(right.serverId),
  );
}

function renderPromptSectionVariant(
  snapshot: ServerToolSnapshot,
  mode: "full" | "withoutOutputSchemas" | "withoutSchemas",
): string {
  const lines: string[] = [TOOL_SNAPSHOT_PROMPT_HEADER];

  for (const server of sortSnapshotServers(snapshot.servers)) {
    lines.push("", `## Server: ${server.serverId}`);

    if (server.captureError) {
      lines.push(`Capture error: ${server.captureError}`);
    }

    if (server.tools.length === 0) {
      lines.push("No tools captured.");
      continue;
    }

    for (const tool of sortSnapshotTools(server.tools)) {
      lines.push(
        `- \`${tool.name}\`: ${tool.description?.trim() || "No description provided."}`,
      );

      if (mode !== "withoutSchemas" && tool.inputSchema !== undefined) {
        lines.push(`  inputSchema: ${minifyStableJson(tool.inputSchema)}`);
      }

      if (mode === "full" && tool.outputSchema !== undefined) {
        lines.push(`  outputSchema: ${minifyStableJson(tool.outputSchema)}`);
      }
    }
  }

  return lines.join("\n");
}

export function summarizeServerToolSnapshotCapture(
  snapshot: ServerToolSnapshot | undefined,
): ServerToolSnapshotCaptureResult {
  if (!snapshot) {
    return {
      status: "missing",
      serverCount: 0,
      toolCount: 0,
      failedServerCount: 0,
      failedServerIds: [],
    };
  }

  const failedServerIds = sortSnapshotServers(
    snapshot.servers.filter((server) => Boolean(server.captureError)),
  ).map((server) => server.serverId);

  return {
    status: failedServerIds.length > 0 ? "partial" : "complete",
    serverCount: snapshot.servers.length,
    toolCount: snapshot.servers.reduce(
      (sum, server) => sum + server.tools.length,
      0,
    ),
    failedServerCount: failedServerIds.length,
    failedServerIds,
  };
}

export function inferServerToolSnapshotFallbackReason(
  snapshot: ServerToolSnapshot | undefined,
): string | undefined {
  if (!snapshot) {
    return "tool_snapshot_missing";
  }
  if (snapshot.servers.some((server) => Boolean(server.captureError))) {
    return "tool_snapshot_partial_capture";
  }
  if (snapshot.servers.length === 0) {
    return "tool_snapshot_empty";
  }
  return undefined;
}

export function renderServerToolSnapshotSection(
  snapshot: ServerToolSnapshot | undefined,
  options?: { maxChars?: number },
): RenderedServerToolSnapshotSection {
  const maxChars = options?.maxChars ?? DEFAULT_TOOL_SNAPSHOT_PROMPT_MAX_CHARS;

  if (!snapshot || snapshot.servers.length === 0) {
    return {
      promptSection: undefined,
      truncated: false,
      maxChars,
    };
  }

  const full = renderPromptSectionVariant(snapshot, "full");
  if (full.length <= maxChars) {
    return {
      promptSection: full,
      truncated: false,
      maxChars,
    };
  }

  const withoutOutputSchemas = renderPromptSectionVariant(
    snapshot,
    "withoutOutputSchemas",
  );
  if (withoutOutputSchemas.length <= maxChars) {
    return {
      promptSection: withoutOutputSchemas,
      truncated: true,
      maxChars,
    };
  }

  const withoutSchemas = renderPromptSectionVariant(snapshot, "withoutSchemas");
  if (withoutSchemas.length <= maxChars) {
    return {
      promptSection: withoutSchemas,
      truncated: true,
      maxChars,
    };
  }

  return {
    promptSection:
      withoutSchemas.slice(0, Math.max(0, maxChars - 15)) + "\n...[truncated]",
    truncated: true,
    maxChars,
  };
}

export function buildServerToolSnapshotDebug(
  snapshot: ServerToolSnapshot | undefined,
  options?: { maxChars?: number },
): Record<string, unknown> {
  const rendered = renderServerToolSnapshotSection(snapshot, options);
  return {
    captureResult: summarizeServerToolSnapshotCapture(snapshot),
    promptSection: rendered.promptSection ?? null,
    promptSectionTruncated: rendered.truncated,
    promptSectionMaxChars: rendered.maxChars,
    fallbackReason: inferServerToolSnapshotFallbackReason(snapshot) ?? null,
    fullSnapshot: snapshot ?? null,
  };
}

export function flattenServerToolSnapshotTools(
  snapshot: ServerToolSnapshot | undefined,
): DiscoveredTool[] {
  if (!snapshot) {
    return [];
  }

  return sortSnapshotServers(snapshot.servers).flatMap((server) =>
    sortSnapshotTools(server.tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? {},
      outputSchema: tool.outputSchema,
      serverId: server.serverId,
    })),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Convex rejects any object field name that starts with `$` (e.g. JSON
// Schema's `$schema` / `$ref` / `$defs` / `$id`) at every nesting depth — the
// value is invalid the instant it crosses a Convex function-argument boundary,
// well before the backend's storage-time redaction can run. MCP tool schemas
// routinely carry these keywords, and every consumer of these snapshots (chat
// persist, connect inspection, eval authoring) forwards the result straight
// into a Convex action/mutation. So strip them here at the source. The drop is
// lossy but matches what the backend would store anyway — it mirrors
// `sanitizeConvexReservedKeys` in convex/lib/serverToolSnapshot.ts. `_`-prefixed
// nested keys stay (Convex only reserves `_` for top-level document fields, so
// MCP's `_meta` survives).
function stripConvexReservedKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripConvexReservedKeys(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key.startsWith("$")) {
        continue;
      }
      out[key] = stripConvexReservedKeys(entry);
    }
    return out as T;
  }
  return value;
}

function transformToolForSnapshot(tool: any): ServerToolSnapshotTool {
  const meta =
    tool._meta &&
    typeof tool._meta === "object" &&
    !Array.isArray(tool._meta)
      ? (tool._meta as Record<string, unknown>)
      : undefined;
  return {
    name: tool.name,
    ...(normalizeTrimmedString(tool.description)
      ? { description: normalizeTrimmedString(tool.description) }
      : {}),
    ...(tool.inputSchema !== undefined
      ? { inputSchema: stripConvexReservedKeys(tool.inputSchema) }
      : {}),
    ...(tool.outputSchema !== undefined
      ? { outputSchema: stripConvexReservedKeys(tool.outputSchema) }
      : {}),
    ...(meta && Object.keys(meta).length > 0
      ? { metadata: stripConvexReservedKeys(meta) }
      : {}),
  };
}

function readInitializeFromManager(
  manager: Manager,
  serverId: string,
): ServerToolSnapshotInitialize | undefined {
  let info: unknown;
  try {
    info = (manager as { getInitializationInfo?: (id: string) => unknown })
      .getInitializationInfo?.(serverId);
  } catch {
    return undefined;
  }
  if (!isRecord(info)) {
    return undefined;
  }

  const result: ServerToolSnapshotInitialize = {};

  const protocolVersion =
    typeof info.protocolVersion === "string"
      ? info.protocolVersion.trim()
      : undefined;
  if (protocolVersion) {
    result.protocolVersion = protocolVersion;
  }

  if (isRecord(info.serverInfo)) {
    const name =
      typeof info.serverInfo.name === "string"
        ? info.serverInfo.name.trim()
        : undefined;
    const version =
      typeof info.serverInfo.version === "string"
        ? info.serverInfo.version.trim()
        : undefined;
    if (name || version) {
      result.serverInfo = {
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
      };
    }
  }

  if (isRecord(info.capabilities)) {
    result.capabilities = stripConvexReservedKeys(info.capabilities);
  }

  if (typeof info.instructions === "string" && info.instructions.trim()) {
    result.instructions = info.instructions.trim();
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export async function exportConnectedServerToolSnapshotForEvalAuthoring(
  manager: Manager,
  serverIds: string[],
  options?: { logPrefix?: string },
): Promise<ServerToolSnapshot> {
  const logPrefix = options?.logPrefix ?? "evals";
  const servers = await Promise.all(
    [...new Set(serverIds)].map(async (serverId) => {
      try {
        const result = await manager.listTools(serverId);
        const tools = (result?.tools ?? []).map(transformToolForSnapshot);

        const initialize = readInitializeFromManager(manager, serverId);

        return {
          serverId,
          tools: sortSnapshotTools(tools),
          ...(initialize ? { initialize } : {}),
        } satisfies ServerToolSnapshotServer;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[${logPrefix}] Failed to export tools for eval authoring`,
          {
            serverId,
            error: message,
          },
        );
        return {
          serverId,
          tools: [],
          captureError: message,
        } satisfies ServerToolSnapshotServer;
      }
    }),
  );

  return {
    version: 1,
    capturedAt: Date.now(),
    servers: sortSnapshotServers(servers),
  };
}

/**
 * One-server inspection snapshot for the connect-time path.
 *
 * The manager is keyed by `managerKey` (display name in the connect path,
 * Convex Id in the eval path), but the snapshot's `serverId` carries
 * `snapshotServerId` so the backend's `normalizeId('servers', …)` resolves
 * correctly. Always returns a valid snapshot — failures land in
 * `captureError` rather than throwing — so callers can use this without an
 * outer try/catch.
 */
export async function exportSingleServerForInspection(
  manager: Manager,
  managerKey: string,
  snapshotServerId: string,
  options?: { logPrefix?: string },
): Promise<ServerToolSnapshot> {
  const logPrefix = options?.logPrefix ?? "inspection";
  let server: ServerToolSnapshotServer;
  try {
    const result = await manager.listTools(managerKey);
    const tools = (result?.tools ?? []).map(transformToolForSnapshot);
    const initialize = readInitializeFromManager(manager, managerKey);
    server = {
      serverId: snapshotServerId,
      tools: sortSnapshotTools(tools),
      ...(initialize ? { initialize } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[${logPrefix}] Failed to capture inspection snapshot`, {
      managerKey,
      snapshotServerId,
      error: message,
    });
    server = {
      serverId: snapshotServerId,
      tools: [],
      captureError: message,
    };
  }
  return {
    version: 1,
    capturedAt: Date.now(),
    servers: [server],
  };
}

export async function exportServer(manager: Manager, serverId: string) {
  const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
    manager.listTools(serverId),
    manager.listResources(serverId),
    manager.listPrompts(serverId),
  ]);

  const tools = toolsResult.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));

  const resources = resourcesResult.resources.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
  }));

  const prompts = promptsResult.prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments,
  }));

  return {
    serverId,
    exportedAt: new Date().toISOString(),
    tools,
    resources,
    prompts,
  };
}
