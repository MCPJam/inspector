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
};

export type ServerToolSnapshotServer = {
  serverId: string;
  tools: ServerToolSnapshotTool[];
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
        const tools = (result?.tools ?? []).map((tool: any) => ({
          name: tool.name,
          ...(normalizeTrimmedString(tool.description)
            ? { description: normalizeTrimmedString(tool.description) }
            : {}),
          ...(tool.inputSchema !== undefined
            ? { inputSchema: tool.inputSchema }
            : {}),
          ...(tool.outputSchema !== undefined
            ? { outputSchema: tool.outputSchema }
            : {}),
        }));

        return {
          serverId,
          tools: sortSnapshotTools(tools),
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
