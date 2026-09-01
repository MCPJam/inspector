/**
 * The host's tools, as an MCP catalog Codex can publish.
 *
 * Two concerns, both about names.
 *
 * MCPJam names a projected MCP tool `mcp__<server>__<tool>`. Codex qualifies
 * every MCP tool with ITS server name, so publishing that name verbatim would
 * put `mcp__mcpjam__mcp__weather__get_forecast` in front of the model: long,
 * and doubly prefixed for no reason. The catalog publishes the stripped alias
 * and keeps a reverse map, so what reaches the stream is the name the host
 * declared and `parseHarnessToolName` attributes it with no special case.
 *
 * MCP requires an object JSON Schema for every tool. A host tool whose schema
 * is missing or not an object gets a permissive one rather than being dropped:
 * a tool the model cannot see is a silent capability loss, and the host
 * validates the input when it executes anyway.
 */
import { buildHostToolAliases } from "../shared/tool-names.js";

export type HostToolWire = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type HostToolCatalog = {
  descriptors: McpToolDescriptor[];
  /** Alias published to Codex → the host's own tool name. */
  aliasToCanonical: Map<string, string>;
};

const PERMISSIVE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

function asObjectSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { ...PERMISSIVE_SCHEMA };
  const candidate = schema as Record<string, unknown>;
  if (candidate.type === "object") return candidate;
  return { ...PERMISSIVE_SCHEMA };
}

export function buildHostToolCatalog(
  tools: readonly HostToolWire[],
): HostToolCatalog {
  const { aliasToCanonical, canonicalToAlias } = buildHostToolAliases(
    tools.map((tool) => tool.name),
  );
  const descriptors = tools.map((tool) => ({
    name: canonicalToAlias.get(tool.name) ?? tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: asObjectSchema(tool.inputSchema),
  }));
  return { descriptors, aliasToCanonical };
}
