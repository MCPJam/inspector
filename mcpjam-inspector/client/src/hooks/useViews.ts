import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId, type RemoteServer } from "./useProjects";

// Type definitions matching backend
export type ViewProtocol = "mcp-apps" | "openai-apps";

// Re-exported from the shared module so the playground hook, eval
// fanout, and synthetic runner all reference the same definitions.
// See `shared/widget-snapshot.ts` for the source of truth. The
// `import type` brings the names into local scope so type references
// below (`defaultContext: DisplayContext`, `widgetCsp?: WidgetCsp`)
// resolve — `export type { ... }` alone is a pure re-export and does
// not create a local binding.
import type {
  SharedChatWidgetDisplayContext as DisplayContext,
  SharedChatWidgetCsp as WidgetCsp,
} from "@/shared/widget-snapshot";

export type { DisplayContext, WidgetCsp };

export type ServerInfo = {
  name: string;
  iconUrl?: string;
};

// Base view type
export interface ViewBase {
  _id: string;
  projectId: string;
  serverId: string;
  name: string;
  description?: string;
  toolName: string;
  toolState: "output-available" | "output-error";
  toolInput: unknown;
  toolOutputBlob: string;
  toolOutputUrl: string | null;
  toolErrorText?: string;
  toolMetadata?: unknown;
  prefersBorder?: boolean;
  tags?: string[];
  category?: string;
  defaultContext?: DisplayContext;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Whether the cached widget HTML blob (`widgetHtmlUrl`) was
   * captured with the OpenAI Apps SDK `window.openai` shim injected.
   * Surfaced from the backend `mcpAppViews` / `openaiAppViews` row.
   * Absent on pre-feature rows (`undefined` → renderer falls back to
   * the live host's compat flag for non-cached fetches).
   */
  injectedOpenAiCompat?: boolean;
}

// MCP-specific view
export interface McpAppView extends ViewBase {
  protocol: "mcp-apps";
  resourceUri: string;
  toolsMetadata?: unknown;
  widgetCsp?: WidgetCsp;
  widgetPermissions?: unknown;
  widgetPermissive?: boolean;
  /** URL to cached widget HTML for offline rendering */
  widgetHtmlUrl?: string | null;
}

// OpenAI-specific view
export interface OpenaiAppView extends ViewBase {
  protocol: "openai-apps";
  outputTemplate: string;
  serverInfo?: ServerInfo;
  widgetState?: unknown;
  /** URL to cached widget HTML for offline rendering */
  widgetHtmlUrl?: string | null;
}

// Union type for any view
export type AnyView = McpAppView | OpenaiAppView;

// Query hook for fetching views
export function useViewQueries({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}) {
  const enableQuery = isAuthenticated && shouldQueryProjectId(projectId);
  const queryProjectId = projectId?.trim() ?? "";

  const views = useQuery(
    "views:listAllByProject" as any,
    enableQuery ? ({ projectId: queryProjectId } as any) : "skip",
  ) as AnyView[] | undefined;

  const isLoading = enableQuery && views === undefined;

  // Sort by updatedAt (most recent first)
  const sortedViews = useMemo(() => {
    if (!views) return [];
    return [...views].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [views]);

  // Group views by server
  const viewsByServer = useMemo(() => {
    if (!views) return new Map<string, AnyView[]>();
    const grouped = new Map<string, AnyView[]>();
    for (const view of views) {
      const existing = grouped.get(view.serverId) || [];
      grouped.set(view.serverId, [...existing, view]);
    }
    return grouped;
  }, [views]);

  // Group views by category
  const viewsByCategory = useMemo(() => {
    if (!views) return new Map<string, AnyView[]>();
    const grouped = new Map<string, AnyView[]>();
    for (const view of views) {
      const category = view.category || "Uncategorized";
      const existing = grouped.get(category) || [];
      grouped.set(category, [...existing, view]);
    }
    return grouped;
  }, [views]);

  // Group views by protocol
  const viewsByProtocol = useMemo(() => {
    if (!views)
      return { mcp: [] as McpAppView[], openai: [] as OpenaiAppView[] };
    return {
      mcp: views.filter((v): v is McpAppView => v.protocol === "mcp-apps"),
      openai: views.filter(
        (v): v is OpenaiAppView => v.protocol === "openai-apps",
      ),
    };
  }, [views]);

  return {
    views,
    sortedViews,
    viewsByServer,
    viewsByCategory,
    viewsByProtocol,
    isLoading,
    hasViews: (views?.length ?? 0) > 0,
  };
}

// Mutation hook for view operations
export function useViewMutations() {
  // MCP mutations — canonical write path per SEP-1865. All saved views
  // live in mcpAppViews after the Phase B backfill; the legacy
  // openaiAppViews table is being dropped in backend Phase C2.
  const createMcpView = useMutation("mcpAppViews:create" as any);
  const updateMcpView = useMutation("mcpAppViews:update" as any);
  const removeMcpView = useMutation("mcpAppViews:remove" as any);
  const generateMcpUploadUrl = useMutation(
    "mcpAppViews:generateUploadUrl" as any,
  );

  return {
    createMcpView,
    updateMcpView,
    removeMcpView,
    generateMcpUploadUrl,
  };
}

// Hook to get servers for a project (for server ID resolution)
export function useProjectServers({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}) {
  const isUserReady = useDbUserReady();
  const enableQuery =
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId);
  const queryProjectId = projectId?.trim() ?? "";

  const servers = useQuery(
    "servers:getProjectServers" as any,
    enableQuery ? ({ projectId: queryProjectId } as any) : "skip",
  ) as RemoteServer[] | undefined;

  const isLoading = enableQuery && servers === undefined;

  // Create a map for quick lookup by name
  const serversByName = useMemo(() => {
    if (!servers) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const server of servers) {
      map.set(server.name, server._id);
    }
    return map;
  }, [servers]);

  // Create a map for reverse lookup by ID
  const serversById = useMemo(() => {
    if (!servers) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const server of servers) {
      map.set(server._id, server.name);
    }
    return map;
  }, [servers]);

  return {
    servers,
    serversByName,
    serversById,
    isLoading,
  };
}

export function useProjectServerAttachments({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}) {
  const isUserReady = useDbUserReady();
  const enableQuery =
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId);
  const queryProjectId = projectId?.trim() ?? "";

  const serverAttachments = useQuery(
    "serverAttachments:listServerAttachments" as any,
    enableQuery ? ({ projectId: queryProjectId } as any) : "skip",
  ) as Array<{
    _id: string;
    name: string;
    serverIds: string[];
    resolvedServerNames: string[];
    createdAt: number;
    updatedAt: number;
  }> | undefined;

  const isLoading = enableQuery && serverAttachments === undefined;

  return { serverAttachments: serverAttachments ?? [], isLoading };
}

// Server mutation for creating servers
export function useServerMutations() {
  const createServer = useMutation("servers:createServer" as any);

  return {
    createServer,
  };
}
