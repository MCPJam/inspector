import { useMemo, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import type { ServerFormData } from "@/shared/types.js";

/**
 * Dev-only mock registry servers for local UI testing.
 * Set to `true` to bypass Convex and render sample cards.
 */
const DEV_MOCK_REGISTRY =
  import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK_REGISTRY === "true";

const MOCK_REGISTRY_SERVERS: RegistryServer[] = [
  {
    _id: "mock_asana",
    slug: "asana",
    displayName: "Asana",
    description:
      "Connect to Asana to manage tasks, projects, and team workflows directly from your MCP client.",
    publisher: "MCPJam",
    category: "Project Management",
    iconUrl: "https://cdn.worldvectorlogo.com/logos/asana-logo.svg",
    transport: {
      type: "http",
      url: "https://mcp.asana.com/v2/mcp",
      useOAuth: true,
      oauthScopes: ["default"],
    },
    approved: true,
    featured: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_linear",
    slug: "linear",
    displayName: "Linear",
    description:
      "Interact with Linear issues, projects, and cycles. Create, update, and search issues with natural language.",
    publisher: "MCPJam",
    category: "Project Management",
    iconUrl: "https://asset.brandfetch.io/iduDa181eM/idYoMflFma.png",
    transport: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      useOAuth: true,
      oauthScopes: ["read", "write"],
    },
    approved: true,
    featured: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_notion",
    slug: "notion",
    displayName: "Notion",
    description:
      "Access and manage Notion pages, databases, and content. Search, create, and update your workspace.",
    publisher: "MCPJam",
    category: "Productivity",
    iconUrl:
      "https://upload.wikimedia.org/wikipedia/commons/4/45/Notion_app_logo.png",
    transport: {
      type: "http",
      url: "https://mcp.notion.com/mcp",
      useOAuth: true,
      oauthScopes: ["read_content", "update_content"],
    },
    approved: true,
    featured: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_slack",
    slug: "slack",
    displayName: "Slack",
    description:
      "Send messages, search conversations, and manage Slack channels directly through MCP.",
    publisher: "MCPJam",
    category: "Communication",
    iconUrl: "https://cdn.worldvectorlogo.com/logos/slack-new-logo.svg",
    transport: {
      type: "http",
      url: "https://mcp.slack.com/sse",
      useOAuth: true,
    },
    approved: true,
    featured: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_github",
    slug: "github",
    displayName: "GitHub",
    description:
      "Manage repositories, pull requests, issues, and code reviews. Automate your GitHub workflows.",
    publisher: "MCPJam",
    category: "Developer Tools",
    transport: {
      type: "http",
      url: "https://mcp.github.com/sse",
      useOAuth: true,
      oauthScopes: ["repo", "read:org"],
    },
    approved: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_jira",
    slug: "jira",
    displayName: "Jira",
    description:
      "Create and manage Jira issues, sprints, and boards. Track project progress with natural language.",
    publisher: "MCPJam",
    category: "Project Management",
    transport: {
      type: "http",
      url: "https://mcp.atlassian.com/jira/sse",
      useOAuth: true,
    },
    approved: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_google_drive",
    slug: "google-drive",
    displayName: "Google Drive",
    description:
      "Search, read, and organize files in Google Drive. Access documents, spreadsheets, and presentations.",
    publisher: "MCPJam",
    category: "Productivity",
    transport: {
      type: "http",
      url: "https://mcp.googleapis.com/drive/sse",
      useOAuth: true,
    },
    approved: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_stripe",
    slug: "stripe",
    displayName: "Stripe",
    description:
      "Query payments, subscriptions, and customer data. Monitor your Stripe business metrics.",
    publisher: "MCPJam",
    category: "Finance",
    transport: { type: "http", url: "https://mcp.stripe.com/sse" },
    approved: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

/**
 * Shape of a registry server document from the Convex backend.
 * Matches the `registryServers` table schema.
 */
export interface RegistryServer {
  _id: string;
  slug: string;
  displayName: string;
  description: string;
  publisher: string;
  category: string;
  iconUrl?: string;
  transport: {
    type: "http";
    url: string;
    useOAuth?: boolean;
    oauthScopes?: string[];
    clientId?: string;
  };
  approved: boolean;
  featured?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Shape of a registry server connection from `registryServerConnections`.
 */
export interface RegistryServerConnection {
  _id: string;
  registryServerId: string;
  workspaceId: string;
  connectedAt: number;
}

export type RegistryConnectionStatus =
  | "not_connected"
  | "added"
  | "connected"
  | "connecting";

export interface EnrichedRegistryServer extends RegistryServer {
  connectionStatus: RegistryConnectionStatus;
}

/**
 * Hook for fetching registry servers and managing connections.
 *
 * Pattern follows useWorkspaceMutations / useServerMutations in useWorkspaces.ts.
 */
export function useRegistryServers({
  workspaceId,
  isAuthenticated,
  liveServers,
  onConnect,
  onDisconnect,
}: {
  workspaceId: string | null;
  isAuthenticated: boolean;
  /** Live MCP connection state from the app, keyed by server name */
  liveServers?: Record<string, { connectionStatus: string }>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
}) {
  // Fetch all approved registry servers (public — no auth required)
  const remoteRegistryServers = useQuery(
    "registryServers:listRegistryServers" as any,
    DEV_MOCK_REGISTRY ? "skip" : ({} as any),
  ) as RegistryServer[] | undefined;
  const registryServers = DEV_MOCK_REGISTRY
    ? MOCK_REGISTRY_SERVERS
    : remoteRegistryServers;

  // Fetch workspace-level connections
  const connections = useQuery(
    "registryServers:getWorkspaceRegistryConnections" as any,
    !DEV_MOCK_REGISTRY && isAuthenticated && workspaceId
      ? ({ workspaceId } as any)
      : "skip",
  ) as RegistryServerConnection[] | undefined;

  const connectMutation = useMutation(
    "registryServers:connectRegistryServer" as any,
  );
  const disconnectMutation = useMutation(
    "registryServers:disconnectRegistryServer" as any,
  );

  // Set of registry server IDs that have a persistent connection in this workspace
  const connectedRegistryIds = useMemo(() => {
    if (!connections) return new Set<string>();
    return new Set(connections.map((c) => c.registryServerId));
  }, [connections]);

  // Enrich servers with connection status
  const enrichedServers = useMemo<EnrichedRegistryServer[]>(() => {
    if (!registryServers) return [];

    return registryServers.map((server) => {
      const isAddedToWorkspace = connectedRegistryIds.has(server._id);
      const liveServer = liveServers?.[server.displayName];
      let connectionStatus: RegistryConnectionStatus = "not_connected";

      if (liveServer?.connectionStatus === "connected") {
        connectionStatus = "connected";
      } else if (liveServer?.connectionStatus === "connecting") {
        connectionStatus = "connecting";
      } else if (isAddedToWorkspace) {
        connectionStatus = "added";
      }

      return { ...server, connectionStatus };
    });
  }, [registryServers, connectedRegistryIds, liveServers]);

  // Extract unique categories
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const s of enrichedServers) {
      if (s.category) cats.add(s.category);
    }
    return Array.from(cats).sort();
  }, [enrichedServers]);

  const connectionsAreLoading =
    !DEV_MOCK_REGISTRY &&
    isAuthenticated &&
    !!workspaceId &&
    connections === undefined;

  const isLoading =
    !DEV_MOCK_REGISTRY &&
    (registryServers === undefined || connectionsAreLoading);

  async function connect(server: RegistryServer) {
    // 1. Record the connection in Convex (only when authenticated with a workspace)
    if (!DEV_MOCK_REGISTRY && isAuthenticated && workspaceId) {
      await connectMutation({
        registryServerId: server._id,
        workspaceId,
      } as any);
    }

    // 2. Trigger the local MCP connection
    onConnect({
      name: server.displayName,
      type: "http",
      url: server.transport.url,
      useOAuth: server.transport.useOAuth,
      oauthScopes: server.transport.oauthScopes,
      clientId: server.transport.clientId,
      registryServerId: server._id,
    });
  }

  async function disconnect(server: RegistryServer) {
    // 1. Remove the connection from Convex (only when authenticated with a workspace)
    if (!DEV_MOCK_REGISTRY && isAuthenticated && workspaceId) {
      await disconnectMutation({
        registryServerId: server._id,
        workspaceId,
      } as any);
    }

    // 2. Trigger the local MCP disconnection
    onDisconnect?.(server.displayName);
  }

  return {
    registryServers: enrichedServers,
    categories,
    isLoading,
    connect,
    disconnect,
  };
}
