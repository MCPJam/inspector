/**
 * Built-in tool factory registry.
 *
 * The backend `builtInTools` catalog is the source of truth for *what* built-in
 * tools exist; this registry is the source of truth for *how* to build each one
 * at runtime. Keys are catalog ids (which are also the AI SDK tool names the
 * model invokes). Adding a built-in tool = one catalog row (backend) + one
 * factory entry here.
 */
import { type ToolSet } from "ai";
import { buildExaWebSearchTool, WEB_SEARCH_TOOL_NAME } from "./exa-web-search.js";

/** Per-request context every factory receives to build its tool. */
export interface BuiltInToolContext {
  /** Bearer authorization header forwarded to Convex for billing/authz. */
  authHeader: string;
  /** Current project — required by Convex for billing authorization. */
  projectId: string;
  /** Optional chat session, used by Convex for idempotency namespacing. */
  chatSessionId?: string;
}

type BuiltInToolFactory = (ctx: BuiltInToolContext) => ToolSet[string];

/**
 * Registry keyed by catalog id. Each key MUST equal the catalog `id` (and thus
 * the AI SDK tool name) so resolution is a direct lookup.
 */
export const BUILT_IN_TOOL_FACTORIES: Record<string, BuiltInToolFactory> = {
  [WEB_SEARCH_TOOL_NAME]: buildExaWebSearchTool,
};

/**
 * Resolve catalog ids into an AI SDK `ToolSet`.
 *
 * Fails closed on an unknown id: the backend `validateBuiltInToolScope` already
 * proved every persisted id is in the catalog, so an id with no factory here is
 * a real registry gap (a catalog row added without a matching factory) and must
 * surface loudly — otherwise the UI shows a tool as "attached" while the model
 * never sees it.
 */
export function resolveBuiltInTools(
  ids: ReadonlyArray<string> | undefined,
  ctx: BuiltInToolContext,
): ToolSet {
  const out: ToolSet = {};
  for (const id of ids ?? []) {
    const factory = BUILT_IN_TOOL_FACTORIES[id];
    if (!factory) {
      throw new Error(
        `resolveBuiltInTools: no factory registered for built-in tool "${id}". ` +
          "Add it to BUILT_IN_TOOL_FACTORIES (server/utils/built-in-tools/registry.ts).",
      );
    }
    out[id] = factory(ctx);
  }
  return out;
}
