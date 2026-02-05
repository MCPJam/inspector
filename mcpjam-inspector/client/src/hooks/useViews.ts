import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";

// Type definitions matching backend
export type ViewProtocol = "mcp-apps" | "openai-apps";

export type DisplayContext = {
  theme?: "light" | "dark";
  displayMode?: "inline" | "pip" | "fullscreen";
  deviceType?: "mobile" | "tablet" | "desktop";
  viewport?: { width: number; height: number };
  locale?: string;
  timeZone?: string;
  capabilities?: { hover: boolean; touch: boolean };
  safeAreaInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
};

export type WidgetCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type ServerInfo = {
  name: string;
  iconUrl?: string;
};

// Base view type
export interface ViewBase {
  _id: string;
  workspaceId: string;
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
  workspaceId,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
}) {
  const enableQuery = isAuthenticated && !!workspaceId;

  const views = useQuery(
    "views:listAllByWorkspace" as any,
    enableQuery ? ({ workspaceId } as any) : "skip",
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
  // MCP mutations
  const createMcpView = useMutation("mcpAppViews:create" as any);
  const updateMcpView = useMutation("mcpAppViews:update" as any);
  const removeMcpView = useMutation("mcpAppViews:remove" as any);
  const generateMcpUploadUrl = useMutation(
    "mcpAppViews:generateUploadUrl" as any,
  );

  // OpenAI mutations
  const createOpenaiView = useMutation("openaiAppViews:create" as any);
  const updateOpenaiView = useMutation("openaiAppViews:update" as any);
  const removeOpenaiView = useMutation("openaiAppViews:remove" as any);
  const generateOpenaiUploadUrl = useMutation(
    "openaiAppViews:generateUploadUrl" as any,
  );

  return {
    // MCP
    createMcpView,
    updateMcpView,
    removeMcpView,
    generateMcpUploadUrl,
    // OpenAI
    createOpenaiView,
    updateOpenaiView,
    removeOpenaiView,
    generateOpenaiUploadUrl,
  };
}

// Hook to get servers for a workspace (for server ID resolution)
export function useWorkspaceServers({
  isAuthenticated,
  workspaceId,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
}) {
  const enableQuery = isAuthenticated && !!workspaceId;

  const servers = useQuery(
    "servers:getWorkspaceServers" as any,
    enableQuery ? ({ workspaceId } as any) : "skip",
  ) as
    | Array<{
        _id: string;
        name: string;
        workspaceId: string;
        transportType: "stdio" | "http";
      }>
    | undefined;

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

// Server mutation for creating servers
export function useServerMutations() {
  const createServer = useMutation("servers:createServer" as any);

  return {
    createServer,
  };
}
