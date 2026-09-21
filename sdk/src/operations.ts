/**
 * Pure MCP operations and lifecycle helpers.
 *
 * Each operation is a thin wrapper around MCPClientManager methods that
 * normalizes inputs/outputs (default empty arrays, stringify prompt arguments,
 * etc.) without introducing any framework-specific dependencies.
 */

import { MCPClientManager } from "./mcp-client-manager/index.js";
import type {
  CacheMode,
  ListToolsResult,
  MCPPrompt,
  MCPResource,
  MCPResourceTemplate,
  MCPServerConfig,
  RpcLogger,
  RetryPolicy,
} from "./mcp-client-manager/index.js";
import { isMethodUnavailableError } from "./mcp-client-manager/index.js";
import type { SkillEntry } from "./mcp-client-manager/index.js";

/**
 * Per-call cache disposition threaded to the underlying cacheable verbs
 * (SEP-2549). Absent ⇒ upstream default `"use"`. Raw-evidence callers
 * (snapshot/doctor/conformance) pass `"bypass"` so their reads never resolve
 * from a cached body. See {@link CacheMode}.
 */
type WithCacheMode = { cacheMode?: CacheMode };

/** Build the read options object, omitting it entirely when no cacheMode is set. */
function cacheOptions(
  cacheMode?: CacheMode
): { cacheMode: CacheMode } | undefined {
  return cacheMode ? { cacheMode } : undefined;
}

// ── Param types ─────────────────────────────────────────────────────

export interface ListResourcesParams extends WithCacheMode {
  serverId: string;
  cursor?: string;
}

export interface ReadResourceParams extends WithCacheMode {
  serverId: string;
  uri: string;
}

export interface ListPromptsParams extends WithCacheMode {
  serverId: string;
  cursor?: string;
}

export interface ListPromptsMultiParams {
  serverIds: string[];
}

export interface GetPromptParams {
  serverId: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ListToolsParams extends WithCacheMode {
  serverId: string;
  cursor?: string;
}

export interface ListAllToolsParams extends WithCacheMode {
  serverId: string;
}

export interface ListAllToolsResult {
  tools: ListToolsResult["tools"];
  toolsMetadata: Record<string, unknown>;
}

export interface ListAllResourcesParams extends WithCacheMode {
  serverId: string;
}

export interface ListAllResourcesResult {
  resources: MCPResource[];
}

export interface ListAllPromptsParams extends WithCacheMode {
  serverId: string;
}

export interface ListAllPromptsResult {
  prompts: MCPPrompt[];
}

export interface ListAllResourceTemplatesParams extends WithCacheMode {
  serverId: string;
}

export interface ListAllResourceTemplatesResult {
  resourceTemplates: MCPResourceTemplate[];
  unsupported?: boolean;
}

export interface ListAllServerSkillsParams extends WithCacheMode {
  serverId: string;
}

export interface ListAllServerSkillsResult {
  skills: SkillEntry[];
  /**
   * SEP-2549 caching attributes from the LAST page, when the server sent them.
   * Preserved rather than dropped: a drained listing is still a cacheable
   * artifact, and the capture coordinator uses the TTL to decide how long a
   * capture stays fresh.
   */
  ttlMs?: number;
  cacheScope?: string;
  /**
   * Skill URIs the server listed MORE THAN ONCE across the drained pages.
   *
   * A self-contradictory listing is a server bug the debugger surfaces, not
   * one it resolves. Both copies stay in `skills` so a caller can show what
   * was actually sent; the capture path rejects BOTH (never last-wins) and
   * names the URI from here.
   */
  duplicateUris: string[];
}

const MAX_PAGINATION_PAGES = 1000;

export interface WithEphemeralClientOptions {
  /** Override the serverId (default: "__ephemeral__") */
  serverId?: string;
  /** Client name reported to the MCP server (default: "mcpjam-sdk") */
  clientName?: string;
  /** Request timeout in ms (default: 30_000) */
  timeout?: number;
  /** Optional RPC logger for request/response tracing. */
  rpcLogger?: RpcLogger;
  /** Retry policy for the ephemeral manager and initial connect. */
  retryPolicy?: RetryPolicy;
  /**
   * Runs against the freshly-constructed manager BEFORE the initial
   * `connectToServer`. Use it to register per-server state that must be present
   * on the connect envelope — e.g. an MRTR input collector via
   * `setMrtrInputCollector`, which only advertises `elicitation` when registered
   * pre-connect (a 2026-07-28 server checks declared client capabilities before
   * embedding an elicitation).
   */
  beforeConnect?: (
    manager: MCPClientManager,
    serverId: string
  ) => void | Promise<void>;
}

// ── Resources ───────────────────────────────────────────────────────

export async function listResources(
  manager: MCPClientManager,
  params: ListResourcesParams
) {
  const result = await manager.listResources(
    params.serverId,
    // Presence, not truthiness: `""` is a valid continuation cursor.
    params.cursor !== undefined ? { cursor: params.cursor } : undefined,
    cacheOptions(params.cacheMode)
  );
  return {
    resources: result.resources ?? [],
    nextCursor: result.nextCursor,
  };
}

export async function readResource(
  manager: MCPClientManager,
  params: ReadResourceParams
) {
  const content = await manager.readResource(
    params.serverId,
    { uri: params.uri },
    cacheOptions(params.cacheMode)
  );
  return { content };
}

// ── Prompts ─────────────────────────────────────────────────────────

export async function listPrompts(
  manager: MCPClientManager,
  params: ListPromptsParams
) {
  const result = await manager.listPrompts(
    params.serverId,
    // Presence, not truthiness: `""` is a valid continuation cursor.
    params.cursor !== undefined ? { cursor: params.cursor } : undefined,
    cacheOptions(params.cacheMode)
  );
  return {
    prompts: result.prompts ?? [],
    nextCursor: result.nextCursor,
  };
}

export async function listPromptsMulti(
  manager: MCPClientManager,
  params: ListPromptsMultiParams
) {
  const promptsByServer: Record<string, unknown[]> = {};
  const errors: Record<string, string> = {};

  await Promise.all(
    params.serverIds.map(async (serverId) => {
      try {
        const { prompts } = await manager.listPrompts(serverId);
        promptsByServer[serverId] = prompts ?? [];
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors[serverId] = errorMessage;
        promptsByServer[serverId] = [];
      }
    })
  );

  const payload: Record<string, unknown> = { prompts: promptsByServer };
  if (Object.keys(errors).length > 0) {
    payload.errors = errors;
  }
  return payload;
}

export async function getPrompt(
  manager: MCPClientManager,
  params: GetPromptParams
) {
  const promptArguments = params.arguments
    ? Object.fromEntries(
        Object.entries(params.arguments).map(([key, value]) => [
          key,
          String(value),
        ])
      )
    : undefined;

  const content = await manager.getPrompt(params.serverId, {
    name: params.name,
    arguments: promptArguments,
  });
  return { content };
}

// ── Tools ───────────────────────────────────────────────────────────

export async function listTools(
  manager: MCPClientManager,
  params: ListToolsParams
) {
  const result = await manager.listTools(
    params.serverId,
    // Presence, not truthiness: `""` is a valid continuation cursor.
    params.cursor !== undefined ? { cursor: params.cursor } : undefined,
    cacheOptions(params.cacheMode)
  );
  return {
    tools: result.tools ?? [],
    nextCursor: result.nextCursor,
  };
}

/**
 * `listAll*` (this one and its `listAllResources` / `listAllPrompts` /
 * `listAllResourceTemplates` siblings below) manually walk pages via
 * `drainPaginatedList`, including its own repeated-cursor guard and
 * `MAX_PAGINATION_PAGES` cap. On beta.4 that manual walk is largely
 * redundant for the common case: the underlying `@modelcontextprotocol/
 * client` `Client.listTools()` (etc.) already auto-aggregates every page
 * when called with no `cursor` — which is exactly how these helpers make
 * their first `fetchPage(undefined)` call. `drainPaginatedList`'s loop only
 * runs a second iteration if that first call still returns a `nextCursor`,
 * which the client's own aggregate never does (see
 * `pagination-parity.integration.test.ts` for the verified wire evidence,
 * including the surprising case: a server that returns a repeated `nextCursor`
 * makes the CLIENT's internal walk stop silently and return a partial
 * aggregate — not throw — so `drainPaginatedList`'s repeated-cursor guard
 * never even fires for that case either).
 *
 * Kept as public API regardless (no removals) — a `MCPClientManager` built
 * without the official SDK's auto-aggregation (or a future client whose
 * `listMaxPages` behavior differs) still needs this manual walk to be
 * correct, and callers already depend on this exact function signature.
 */
export async function listAllTools(
  manager: MCPClientManager,
  params: ListAllToolsParams
): Promise<ListAllToolsResult> {
  const tools = await drainPaginatedList<
    Awaited<ReturnType<typeof listTools>>["tools"][number],
    Awaited<ReturnType<typeof listTools>>
  >(
    async (cursor) =>
      listTools(manager, {
        serverId: params.serverId,
        cursor,
        cacheMode: params.cacheMode,
      }),
    "tools/list",
    (page) => page.tools ?? []
  );

  const toolsMetadata: Record<string, unknown> = {};
  for (const tool of tools) {
    const metadata = tool._meta;
    if (metadata !== undefined) {
      toolsMetadata[tool.name] = metadata;
    }
  }

  return { tools, toolsMetadata };
}

export async function listAllResources(
  manager: MCPClientManager,
  params: ListAllResourcesParams
): Promise<ListAllResourcesResult> {
  const resources = await drainPaginatedList<
    Awaited<ReturnType<typeof listResources>>["resources"][number],
    Awaited<ReturnType<typeof listResources>>
  >(
    async (cursor) =>
      listResources(manager, {
        serverId: params.serverId,
        cursor,
        cacheMode: params.cacheMode,
      }),
    "resources/list",
    (page) => page.resources ?? []
  );

  return { resources };
}

export async function listAllPrompts(
  manager: MCPClientManager,
  params: ListAllPromptsParams
): Promise<ListAllPromptsResult> {
  const prompts = await drainPaginatedList<
    Awaited<ReturnType<typeof listPrompts>>["prompts"][number],
    Awaited<ReturnType<typeof listPrompts>>
  >(
    async (cursor) =>
      listPrompts(manager, {
        serverId: params.serverId,
        cursor,
        cacheMode: params.cacheMode,
      }),
    "prompts/list",
    (page) => page.prompts ?? []
  );

  return { prompts };
}

export async function listAllResourceTemplates(
  manager: MCPClientManager,
  params: ListAllResourceTemplatesParams
): Promise<ListAllResourceTemplatesResult> {
  let unsupported = false;
  const resourceTemplates = await drainPaginatedList<
    MCPResourceTemplate,
    {
      resourceTemplates: MCPResourceTemplate[];
      nextCursor?: string;
    }
  >(
    async (cursor) => {
      let result;
      try {
        result = await manager.listResourceTemplates(
          params.serverId,
          // Presence, not truthiness: `""` is a valid continuation cursor.
          cursor !== undefined ? { cursor } : undefined,
          cacheOptions(params.cacheMode)
        );
      } catch (error) {
        if (
          isMethodUnavailableError(error, "resources/templates") ||
          isUnsupportedMethodError(error, "resources/templates")
        ) {
          unsupported = true;
          return {
            resourceTemplates: [] as MCPResourceTemplate[],
            nextCursor: undefined,
          };
        }
        throw error;
      }
      return {
        resourceTemplates: result.resourceTemplates ?? [],
        nextCursor: result.nextCursor,
      };
    },
    "resources/templates/list",
    (page) => page.resourceTemplates ?? []
  );

  return unsupported
    ? { resourceTemplates, unsupported: true }
    : { resourceTemplates };
}

// ── Skills (io.modelcontextprotocol/skills, SEP-2640) ───────────────

/**
 * Drains `skills/list` across every page.
 *
 * Reuses `drainPaginatedList` for the repeated-cursor and page-count guards —
 * an untrusted server must not be able to spin this loop forever. Unlike the
 * resource/prompt drains, this one also observes the pages themselves, because
 * two facts only exist ACROSS pages: the SEP-2549 caching attributes (taken
 * from the last page that carried them) and duplicate URIs.
 *
 * IMPORTANT: a drained listing is still not proof of absence. SEP-2640 says a
 * listing MAY be partial, so "captured before, missing from this drain" means
 * only "ask `skills/get`" — never "deleted".
 */
export async function listAllServerSkills(
  manager: MCPClientManager,
  params: ListAllServerSkillsParams
): Promise<ListAllServerSkillsResult> {
  let ttlMs: number | undefined;
  let cacheScope: string | undefined;

  const skills = await drainPaginatedList<
    SkillEntry,
    { skills: SkillEntry[]; nextCursor?: string }
  >(
    async (cursor) => {
      const page = await manager.listServerSkills(
        params.serverId,
        // Presence, not truthiness: `""` is a valid continuation cursor.
        cursor !== undefined ? { cursor } : undefined,
        cacheOptions(params.cacheMode)
      );
      if (page.ttlMs !== undefined) ttlMs = page.ttlMs;
      if (page.cacheScope !== undefined) cacheScope = page.cacheScope;
      return page.nextCursor !== undefined
        ? { skills: page.skills, nextCursor: page.nextCursor }
        : { skills: page.skills };
    },
    "skills/list",
    (page) => page.skills ?? []
  );

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.uri)) duplicates.add(skill.uri);
    seen.add(skill.uri);
  }

  return {
    skills,
    duplicateUris: [...duplicates],
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(cacheScope !== undefined ? { cacheScope } : {}),
  };
}

// ── Lifecycle Helpers ───────────────────────────────────────────────

export async function withEphemeralClient<T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: WithEphemeralClientOptions
): Promise<T> {
  const serverId = options?.serverId ?? "__ephemeral__";
  const manager = new MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 30_000,
      defaultClientName: options?.clientName ?? "mcpjam-sdk",
      lazyConnect: true,
      retryPolicy: options?.retryPolicy,
      ...(options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}),
    }
  );

  try {
    if (options?.beforeConnect) {
      await options.beforeConnect(manager, serverId);
    }
    await manager.connectToServer(serverId, config);
    return await fn(manager, serverId);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
      // Best effort cleanup for the ephemeral connection lifecycle.
    }
  }
}

export async function withDisposableManager<T>(
  managerOrPromise: MCPClientManager | Promise<MCPClientManager>,
  fn: (manager: MCPClientManager) => Promise<T>
): Promise<T> {
  const manager = await managerOrPromise;
  try {
    return await fn(manager);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
      // Best effort cleanup for the disposable manager lifecycle.
    }
  }
}

async function drainPaginatedList<TItem, TPage extends { nextCursor?: string }>(
  fetchPage: (cursor?: string) => Promise<TPage>,
  methodName: string,
  pickItems: (page: TPage) => TItem[]
): Promise<TItem[]> {
  const items: TItem[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    pagesFetched += 1;
    if (pagesFetched > MAX_PAGINATION_PAGES) {
      throw new Error(
        `Exceeded ${MAX_PAGINATION_PAGES} pages while draining ${methodName}.`
      );
    }

    const page = await fetchPage(cursor);
    items.push(...pickItems(page));

    const nextCursor =
      typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    // ABSENCE ends the walk, not emptiness. MCP 2026-07-28
    // `server/utilities/pagination` states that a client "MUST NOT" decide
    // anything from a cursor's value beyond whether a non-null one was
    // provided, and that "an empty string is a valid cursor and thus MUST NOT
    // be treated as the end of results".
    //
    // That cuts both ways, and it is why there is no repeated-cursor guard
    // here. Comparing two cursors for equality IS a determination based on
    // cursor value. Nothing requires a server to change its token between
    // pages — one holding its state server-side may legally return a single
    // constant handle — and a server whose constant handle is `""` is exactly
    // the case the rule above exists to protect. The page cap is the bound
    // instead: it limits OUR work rather than interpreting somebody else's
    // token, and it bounds the adversarial server (which would emit distinct
    // cursors forever, defeating any equality check) identically.
    if (nextCursor === undefined) {
      break;
    }

    cursor = nextCursor;
  }

  return items;
}

function isUnsupportedMethodError(error: unknown, method: string): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : "";
  const lower = message.toLowerCase();
  const normalizedMethod = method.toLowerCase();

  return (
    lower.includes(normalizedMethod) &&
    (lower.includes("not found") ||
      lower.includes("not implemented") ||
      lower.includes("unsupported") ||
      lower.includes("unavailable") ||
      lower.includes("does not support"))
  );
}
