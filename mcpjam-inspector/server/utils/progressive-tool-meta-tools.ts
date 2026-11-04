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
import { needsApprovalFor } from "@/shared/tool-approval";
import { z } from "zod";
import {
  META_TOOL_LOAD,
  META_TOOL_SEARCH,
  formatToolSearchMatch,
  readLoadRequest,
  resolveLoadTarget,
  searchToolCatalog,
  type ToolCatalogEntry,
  type ToolDiscoveryPolicy,
  type ToolDiscoveryState,
  type ToolSearchMatch,
} from "@/shared/progressive-tool-discovery";

const SEARCH_DESCRIPTION =
  "Search the available MCP tools by keyword and return concise matches. " +
  "Use this first when many tools are available so you can find the right " +
  "one without loading every descriptor. Returns the tool name, description, " +
  "and field summary for up to `limit` matches.";

const LOAD_DESCRIPTION =
  "Load the full definitions for one or more MCP tools by name. After " +
  "loading, the tools become available to call in the next step. Call this " +
  "with the names returned by search_mcp_tools, then call each tool by that " +
  "exact name.";

const searchSchema = z.object({
  query: z
    .string()
    .describe(
      "Free-text search across tool names, descriptions, and field names."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum matches to return. Defaults to 8."),
});

// `toolIds` is the pre-name-only key. It stays accepted, undocumented, so a
// model copying an older chat's history is not refused by the schema — a
// refused meta-tool call is itself a dead end on the hosted path.
const loadSchema = z
  .object({
    names: z
      .array(z.string())
      .optional()
      .describe(
        "Tool names (from search_mcp_tools) to make callable on the next step."
      ),
    toolIds: z.array(z.string()).optional(),
  })
  .refine((input) => readLoadRequest(input).length > 0, {
    message: "Provide at least one tool name in `names`.",
  });

export interface SearchMcpToolsResult {
  matches: ToolSearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface LoadMcpToolsResult {
  loaded: { name: string }[];
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
 * The meta-tools declare a `never` floor: gating discovery itself behind N
 * approvals defeats the point, so they run even when the user has approval
 * enabled — see the module docstring. Stated rather than left to silence,
 * because every engine now reads the declaration and "nobody set it" is not
 * distinguishable from "somebody decided".
 */
export function createProgressiveMetaTools(
  config: ProgressiveMetaToolsConfig
): ToolSet {
  const { getCatalog, state, policy } = config;
  const result: ToolSet = {};
  result[META_TOOL_SEARCH] = tool({
    description: SEARCH_DESCRIPTION,
    inputSchema: searchSchema,
    needsApproval: needsApprovalFor("never", false),
    execute: async ({ query, limit }): Promise<SearchMcpToolsResult> => {
      // Clamp caller-supplied limit. Zod only checks positive-int; a model
      // (or a tampered/injected one) can ask for `limit: 10_000` and force
      // serialization of an oversized tool-result payload. We allow up to
      // 4× the policy default so power users can still widen the window
      // when needed, but never beyond a fixed ceiling — bounded payloads
      // are part of progressive discovery's whole point.
      const MAX_SEARCH_LIMIT = Math.max(policy.searchLimit * 4, 32);
      const effectiveLimit = Math.min(
        limit ?? policy.searchLimit,
        MAX_SEARCH_LIMIT
      );
      const catalog = getCatalog();
      // Rank the full match list first so `totalMatches` reflects the true
      // count and `truncated` only fires when we actually dropped results.
      // Otherwise the model sees `totalMatches === matches.length` and can't
      // tell whether to refine the query.
      const allMatches = searchToolCatalog(catalog, query, {
        limit: Number.MAX_SAFE_INTEGER,
      });
      const matches = allMatches.slice(0, effectiveLimit);
      return {
        matches: matches.map(formatToolSearchMatch),
        totalMatches: allMatches.length,
        truncated: allMatches.length > effectiveLimit,
      };
    },
  });
  result[META_TOOL_LOAD] = tool({
    description: LOAD_DESCRIPTION,
    inputSchema: loadSchema,
    needsApproval: needsApprovalFor("never", false),
    execute: async (input): Promise<LoadMcpToolsResult> => {
      const catalog = getCatalog();
      const byId = new Map<string, ToolCatalogEntry>();
      for (const entry of catalog) byId.set(entry.toolId, entry);
      const loaded: LoadMcpToolsResult["loaded"] = [];
      const notFound: string[] = [];
      for (const requested of readLoadRequest(input)) {
        const id = resolveLoadTarget(catalog, requested);
        const entry = id ? byId.get(id) : undefined;
        if (!id || !entry) {
          notFound.push(requested);
          continue;
        }
        // newlyLoadedToolIds is the staging set the orchestrator promotes
        // into loadedToolIds when it prepares the next step.
        state.newlyLoadedToolIds.add(id);
        loaded.push({ name: entry.modelName });
      }
      return { loaded, notFound };
    },
  });
  return result;
}
