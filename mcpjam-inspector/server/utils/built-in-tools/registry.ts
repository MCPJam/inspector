/**
 * Built-in tool registry: HostConfig v2 `builtInToolIds` → AI SDK ToolSet.
 *
 * Built-in tools are server-side tools the inspector defines itself (no MCP
 * server involved) whose `execute` proxies to a Convex HTTP action that owns
 * the external API key and the billing. Today that's just `web_search`
 * (Exa, billed as MCPJam credits against the project's organization — see
 * `exa-web-search.ts`).
 *
 * `resolveExecutionContext` surfaces the resolved id list off a hostConfig
 * record; this module turns ids into runnable tools. The split keeps the
 * resolver pure (no auth concerns) and gives every engine — chat-v2 routes,
 * the eval runners, sessionSimulation — one construction path, so the tool
 * the model sees is identical across surfaces.
 *
 * Auth context is required because every built-in tool bills via Convex:
 * paths with no Convex auth (local BYOK eval runs) must omit the tools
 * entirely rather than advertise a tool whose execute can only fail —
 * that's what `safeResolveBuiltInTools(ids, null)` encodes.
 */
import type { ToolSet } from "ai";
import { logger } from "../logger.js";
import {
  buildExaWebSearchTool,
  WEB_SEARCH_TOOL_NAME,
} from "./exa-web-search.js";

export interface BuiltInToolContext {
  /** Bearer authorization forwarded to Convex. "Bearer " prefix optional. */
  authHeader: string;
  /** Project the built-in tool's usage bills against. */
  projectId: string;
  /** Optional chat session, used by Convex for idempotency namespacing. */
  chatSessionId?: string;
}

function normalizeAuthHeader(raw: string): string {
  return raw.startsWith("Bearer ") ? raw : `Bearer ${raw}`;
}

/**
 * Build the ToolSet for a resolved `builtInToolIds` list. Unknown ids are
 * skipped with a warn (a newer backend catalog may advertise ids this
 * inspector build doesn't implement yet — degrading to "tool absent" is the
 * same behavior the model would see if the host never enabled it).
 */
export function resolveBuiltInTools(
  ids: ReadonlyArray<string> | undefined,
  ctx: BuiltInToolContext,
): ToolSet {
  const out: ToolSet = {};
  for (const id of ids ?? []) {
    if (id === WEB_SEARCH_TOOL_NAME) {
      out[WEB_SEARCH_TOOL_NAME] = buildExaWebSearchTool({
        authHeader: normalizeAuthHeader(ctx.authHeader),
        projectId: ctx.projectId,
        ...(ctx.chatSessionId ? { chatSessionId: ctx.chatSessionId } : {}),
      });
    } else {
      logger.warn("[built-in-tools] unknown builtInToolId; skipping", { id });
    }
  }
  return out;
}

/**
 * Null-context-tolerant wrapper for call sites where Convex auth may be
 * absent (e.g. local BYOK eval iterations). Returns `undefined` — i.e.
 * "pass nothing to `prepareChatV2`" — when there's nothing to resolve or
 * no auth to resolve it with.
 */
export function safeResolveBuiltInTools(
  ids: ReadonlyArray<string> | undefined,
  ctx: BuiltInToolContext | null,
): ToolSet | undefined {
  if (!ids || ids.length === 0) return undefined;
  if (!ctx) {
    logger.debug(
      "[built-in-tools] builtInToolIds requested without Convex auth context; omitting",
      { ids: [...ids] },
    );
    return undefined;
  }
  const tools = resolveBuiltInTools(ids, ctx);
  return Object.keys(tools).length > 0 ? tools : undefined;
}
