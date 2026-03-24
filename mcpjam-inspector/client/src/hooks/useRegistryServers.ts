import { useMemo, useCallback, useState, useEffect } from "react";
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
    name: "com.asana.mcp",
    displayName: "Asana",
    description:
      "Connect to Asana to manage tasks, projects, and team workflows directly from your MCP client.",
    publisher: "MCPJam",
    category: "Project Management",
    iconUrl: "https://cdn.simpleicons.org/asana",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.asana.com/v2/mcp",
      useOAuth: true,
      oauthScopes: ["default"],
    },
    status: "approved",
    sortOrder: 1,
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_linear",
    name: "app.linear.mcp",
    displayName: "Linear",
    description:
      "Interact with Linear issues, projects, and cycles. Create, update, and search issues with natural language.",
    publisher: "MCPJam",
    category: "Project Management",
    iconUrl: "https://cdn.simpleicons.org/linear",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.linear.app/mcp",
      useOAuth: true,
      oauthScopes: ["read", "write"],
    },
    status: "approved",
    sortOrder: 2,
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_notion",
    name: "com.notion.mcp",
    displayName: "Notion",
    description:
      "Access and manage Notion pages, databases, and content. Search, create, and update your workspace.",
    publisher: "MCPJam",
    category: "Productivity",
    iconUrl:
      "https://upload.wikimedia.org/wikipedia/commons/4/45/Notion_app_logo.png",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.notion.com/mcp",
      useOAuth: true,
      oauthScopes: ["read_content", "update_content"],
    },
    status: "approved",
    sortOrder: 3,
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_slack",
    name: "com.slack.mcp",
    displayName: "Slack",
    description:
      "Send messages, search conversations, and manage Slack channels directly through MCP.",
    publisher: "MCPJam",
    category: "Communication",
    iconUrl: "https://cdn.worldvectorlogo.com/logos/slack-new-logo.svg",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.slack.com/sse",
      useOAuth: true,
    },
    status: "approved",
    sortOrder: 4,
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_github",
    name: "com.github.mcp",
    displayName: "GitHub",
    description:
      "Manage repositories, pull requests, issues, and code reviews. Automate your GitHub workflows.",
    publisher: "MCPJam",
    category: "Developer Tools",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.github.com/sse",
      useOAuth: true,
      oauthScopes: ["repo", "read:org"],
    },
    status: "approved",
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_jira",
    name: "com.atlassian.jira.mcp",
    displayName: "Jira",
    description:
      "Create and manage Jira issues, sprints, and boards. Track project progress with natural language.",
    publisher: "MCPJam",
    category: "Project Management",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.atlassian.com/jira/sse",
      useOAuth: true,
    },
    status: "approved",
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_google_drive",
    name: "com.google.drive.mcp",
    displayName: "Google Drive",
    description:
      "Search, read, and organize files in Google Drive. Access documents, spreadsheets, and presentations.",
    publisher: "MCPJam",
    category: "Productivity",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.googleapis.com/drive/sse",
      useOAuth: true,
    },
    status: "approved",
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    _id: "mock_stripe",
    name: "com.stripe.mcp",
    displayName: "Stripe",
    description:
      "Query payments, subscriptions, and customer data. Monitor your Stripe business metrics.",
    publisher: "MCPJam",
    category: "Finance",
    scope: "global",
    transport: { transportType: "http", url: "https://mcp.stripe.com/sse" },
    status: "approved",
    createdBy: "mock_user",
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
  // Identity
  name: string; // Reverse-DNS: "com.acme.internal-tools"
  displayName: string;
  description?: string;
  iconUrl?: string;
  // Client type: "text" for any MCP client, "app" for rich-UI clients
  clientType?: "text" | "app";
  // Scope & ownership
  scope: "global" | "organization";
  organizationId?: string;
  // Transport config
  transport: {
    transportType: "stdio" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
    oauthScopes?: string[];
    oauthCredentialKey?: string;
    clientId?: string;
    timeout?: number;
  };
  // Curation
  category?: string;
  tags?: string[];
  version?: string;
  publisher?: string;
  repositoryUrl?: string;
  sortOrder?: number;
  // Governance
  status: "approved" | "pending_review" | "deprecated";
  meta?: unknown;
  // Tracking
  createdBy: string;
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
  serverId: string; // the actual servers row
  connectedBy: string;
  connectedAt: number;
  configOverridden?: boolean;
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
 * Registry servers grouped by displayName, with variants ordered app-first.
 */
export interface ConsolidatedRegistryServer {
  /** All variants ordered: app before text. */
  variants: EnrichedRegistryServer[];
  /** True when both "text" and "app" variants exist. */
  hasDualType: boolean;
}

/**
 * Groups registry servers by displayName. Variants are ordered app before text.
 */
export function consolidateServers(
  servers: EnrichedRegistryServer[],
): ConsolidatedRegistryServer[] {
  const groups = new Map<string, EnrichedRegistryServer[]>();

  for (const server of servers) {
    const key = server.displayName;
    const group = groups.get(key);
    if (group) {
      group.push(server);
    } else {
      groups.set(key, [server]);
    }
  }

  const result: ConsolidatedRegistryServer[] = [];

  for (const variants of groups.values()) {
    // App before text
    const ordered = [...variants].sort((a) =>
      a.clientType === "app" ? -1 : 1,
    );
    result.push({ variants: ordered, hasDualType: variants.length > 1 });
  }

  return result;
}

/**
 * Returns the server name that matches what Convex creates (with (App)/(Text) suffix).
 */
export function getRegistryServerName(server: RegistryServer): string {
  if (server.clientType === "app") return `${server.displayName} (App)`;
  if (server.clientType === "text") return `${server.displayName} (Text)`;
  return server.displayName;
}

function isMissingWorkspaceConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Registry server is not connected to this workspace")
  );
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
  // Fetch all approved registry servers (requires Convex auth identity)
  const remoteRegistryServers = useQuery(
    "registryServers:listRegistryServers" as any,
    !DEV_MOCK_REGISTRY && isAuthenticated ? ({} as any) : "skip",
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
      const liveServer = liveServers?.[getRegistryServerName(server)];
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

  // Track registry server IDs that are pending connection (waiting for OAuth / handshake)
  const [pendingServerIds, setPendingServerIds] = useState<
    Map<string, string>
  >(new Map()); // registryServerId → suffixed server name

  // Record the Convex connection only after the server actually connects
  useEffect(() => {
    if (!isAuthenticated || !workspaceId || DEV_MOCK_REGISTRY) return;
    for (const [registryServerId, serverName] of pendingServerIds) {
      const liveServer = liveServers?.[serverName];
      if (liveServer?.connectionStatus === "connected") {
        setPendingServerIds((prev) => {
          const next = new Map(prev);
          next.delete(registryServerId);
          return next;
        });
        connectMutation({
          registryServerId,
          workspaceId,
        } as any);
      }
    }
  }, [
    liveServers,
    pendingServerIds,
    isAuthenticated,
    workspaceId,
    connectMutation,
  ]);

  const connectionsAreLoading =
    !DEV_MOCK_REGISTRY &&
    isAuthenticated &&
    !!workspaceId &&
    connections === undefined;

  const isLoading =
    !DEV_MOCK_REGISTRY &&
    (registryServers === undefined || connectionsAreLoading);

  async function connect(server: RegistryServer) {
    const serverName = getRegistryServerName(server);
    // Track this server as pending — Convex record will be created when it actually connects
    setPendingServerIds((prev) => new Map(prev).set(server._id, serverName));

    // Trigger the local MCP connection
    onConnect({
      name: serverName,
      type: server.transport.transportType,
      url: server.transport.url,
      useOAuth: server.transport.useOAuth,
      oauthScopes: server.transport.oauthScopes,
      oauthCredentialKey: server.transport.oauthCredentialKey,
      clientId: server.transport.clientId,
      registryServerId: server._id,
    });
  }

  async function disconnect(server: RegistryServer) {
    const serverName = getRegistryServerName(server);
    let disconnectError: unknown;

    // 1. Remove the connection from Convex (only when authenticated with a workspace)
    if (!DEV_MOCK_REGISTRY && isAuthenticated && workspaceId) {
      try {
        await disconnectMutation({
          registryServerId: server._id,
          workspaceId,
        } as any);
      } catch (error) {
        if (!isMissingWorkspaceConnectionError(error)) {
          disconnectError = error;
        }
      }
    }

    // 2. Trigger the local MCP disconnection
    onDisconnect?.(serverName);

    if (disconnectError) {
      throw disconnectError;
    }
  }

  return {
    registryServers: enrichedServers,
    categories,
    isLoading,
    connect,
    disconnect,
  };
}
