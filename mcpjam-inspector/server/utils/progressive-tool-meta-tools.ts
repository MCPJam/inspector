/**
 * Progressive discovery meta-tools: `search_mcp_tools` and `load_mcp_tools`.
 *
 * Both tools are pure functions over the per-turn catalog + discovery state.
 * They never call into the MCPClientManager and never touch credentials, so
 * they're approval-free even when the user has `requireToolApproval` set:
 * exposing them under the same approval gate as real MCP tools would make
 * progressive discovery itself require N approvals per turn, which defeats
 * the point.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  META_TOOL_LOAD,
  META_TOOL_SEARCH,
  formatToolSearchMatch,
  searchToolCatalog,
  type ToolCatalogEntry,
  type ToolDiscoveryPolicy,
  type ToolDiscoveryState,
  type ToolSearchMatch,
} from "@/shared/progressive-tool-discovery";

const SEARCH_DESCRIPTION =
  "Search the available MCP tools by keyword and return concise matches. " +
  "Use this first when many tools are available so you can find the right " +
  "one without loading every descriptor. Returns the tool id, name, server, " +
  "description, and field summary for up to `limit` matches.";

const LOAD_DESCRIPTION =
  "Load the full definitions for one or more MCP tools by id. After loading, " +
  "the tools become available to call in the next step. Call this with the " +
  "ids returned by search_mcp_tools before invoking the underlying tool.";

const searchSchema = z.object({
  query: z
    .string()
    .describe(
      "Free-text search across tool names, descriptions, and field names.",
    ),
  serverIds: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict matches to these server ids. Omit to search across all connected servers.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum matches to return. Defaults to 8."),
});

const loadSchema = z.object({
  toolIds: z
    .array(z.string())
    .min(1)
    .describe(
      "Stable tool ids (from search_mcp_tools) to make callable on the next step.",
    ),
});

export interface SearchMcpToolsResult {
  matches: ToolSearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface LoadMcpToolsResult {
  loaded: { toolId: string; name: string; serverId: string | null }[];
  notFound: string[];
}

export interface ProgressiveMetaToolsConfig {
  /** Always returns the *current* catalog so late connections are reflected. */
  getCatalog: () => ToolCatalogEntry[];
  /** Mutated by load_mcp_tools; orchestrator reads after each step. */
  state: ToolDiscoveryState;
  policy: ToolDiscoveryPolicy;
}

/**
 * Build the meta-tools as an AI SDK ToolSet partial. The tools mutate the
 * supplied `state` object — the orchestrator reads it after each step to
 * decide which tools are active for the next one.
 *
 * Important: do NOT set `needsApproval` here. The meta-tools must run even
 * when the user has approval enabled — see the module docstring.
 */
export function createProgressiveMetaTools(
  config: ProgressiveMetaToolsConfig,
): ToolSet {
  const { getCatalog, state, policy } = config;
  const result: ToolSet = {};
  result[META_TOOL_SEARCH] = tool({
    description: SEARCH_DESCRIPTION,
    inputSchema: searchSchema,
    execute: async ({ query, serverIds, limit }): Promise<SearchMcpToolsResult> => {
      // Clamp caller-supplied limit. Zod only checks positive-int; a model
      // (or a tampered/injected one) can ask for `limit: 10_000` and force
      // serialization of an oversized tool-result payload. We allow up to
      // 4× the policy default so power users can still widen the window
      // when needed, but never beyond a fixed ceiling — bounded payloads
      // are part of progressive discovery's whole point.
      const MAX_SEARCH_LIMIT = Math.max(policy.searchLimit * 4, 32);
      const effectiveLimit = Math.min(
        limit ?? policy.searchLimit,
        MAX_SEARCH_LIMIT,
      );
      const catalog = getCatalog();
      const matches = searchToolCatalog(catalog, query, {
        serverIds,
        limit: effectiveLimit,
      });
      return {
        matches: matches.map(formatToolSearchMatch),
        totalMatches: matches.length,
        truncated: matches.length === effectiveLimit,
      };
    },
  });
  result[META_TOOL_LOAD] = tool({
    description: LOAD_DESCRIPTION,
    inputSchema: loadSchema,
    execute: async ({ toolIds }): Promise<LoadMcpToolsResult> => {
      const catalog = getCatalog();
      const byId = new Map<string, ToolCatalogEntry>();
      for (const entry of catalog) byId.set(entry.toolId, entry);
      const loaded: LoadMcpToolsResult["loaded"] = [];
      const notFound: string[] = [];
      for (const id of toolIds) {
        const entry = byId.get(id);
        if (!entry) {
          notFound.push(id);
          continue;
        }
        // newlyLoadedToolIds is the staging set the orchestrator promotes
        // into loadedToolIds when it prepares the next step.
        state.newlyLoadedToolIds.add(id);
        loaded.push({
          toolId: entry.toolId,
          name: entry.modelName,
          serverId: entry.serverId,
        });
      }
      return { loaded, notFound };
    },
  });
  return result;
}
