import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import type { ServerFormData } from "@/shared/types.js";
import type { RegistryServer } from "@/lib/registry-server-types";
import {
  fetchRegistryCatalog,
  starRegistryCard,
  unstarRegistryCard,
  mergeGuestRegistryStars,
  type RegistryCatalogCard,
} from "@/lib/apis/registry-http";
import { WebApiError } from "@/lib/apis/web/base";
import { HOSTED_MODE } from "@/lib/config";
import {
  clearGuestSession,
  getExistingGuestBearerToken,
} from "@/lib/guest-session";
import { resetTokenCache } from "@/lib/apis/web/context";
import { toast } from "sonner";

/**
 * Dev-only mock registry servers for local UI testing.
 * Set to `true` to bypass Convex and render sample cards.
 */
const DEV_MOCK_REGISTRY =
  import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK_REGISTRY === "true";

// Kill switch for the entire registry feature. The registry UI is gated
// behind an internal feature flag and isn't shipped to prod users yet, but
// the hook was still firing network requests (catalog fetch, guest-stars
// merge) for internal users with the flag on and producing visible errors.
// While `false`, the hook is fully inert: empty data, no fetches, no-op
// mutations. Flip to true once the registry backend is ready for real use.
const REGISTRY_FEATURE_ENABLED = false;

const MOCK_REGISTRY_SERVERS: RegistryServer[] = [
  {
    _id: "mock_asana",
    name: "com.asana.mcp",
    displayName: "Asana",
    description:
      "Connect to Asana to manage tasks, projects, and team workflows directly from your MCP client.",
    publisher: "MCPJam",
    publishStatus: "verified",
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
    publishStatus: "verified",
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
      "Access and manage Notion pages, databases, and content. Search, create, and update your project.",
    publisher: "MCPJam",
    publishStatus: "verified",
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
    publishStatus: "verified",
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
    publishStatus: "verified",
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
    publishStatus: "verified",
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
    publishStatus: "verified",
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
    publishStatus: "verified",
    category: "Finance",
    scope: "global",
    transport: { transportType: "http", url: "https://mcp.stripe.com/sse" },
    status: "approved",
    createdBy: "mock_user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

export type { RegistryServer };
export type { RegistryServerConnection } from "@/lib/registry-server-types";
import type { RegistryServerConnection } from "@/lib/registry-server-types";

export type RegistryConnectionStatus =
  | "not_connected"
  | "added"
  | "connected"
  | "connecting";

export interface EnrichedRegistryServer extends RegistryServer {
  connectionStatus: RegistryConnectionStatus;
}

/**
 * Consolidated registry card from the HTTP catalog API, enriched with project connection state.
 */
export interface EnrichedRegistryCatalogCard {
  registryCardKey: string;
  catalogSortOrder: number;
  variants: EnrichedRegistryServer[];
  starCount: number;
  isStarred: boolean;
  hasDualType: boolean;
}

/**
 * @deprecated Prefer EnrichedRegistryCatalogCard from the catalog HTTP API.
 */
export interface ConsolidatedRegistryServer {
  variants: EnrichedRegistryServer[];
  hasDualType: boolean;
}

/**
 * App before Text everywhere we list variants (badges, Connect dropdown, primary `variants[0]`).
 */
export function sortRegistryVariantsAppBeforeText<
  T extends { clientType?: "text" | "app" },
>(variants: T[]): T[] {
  return [...variants].sort((a, b) => {
    const rank = (v: T) => (v.clientType === "app" ? 0 : 1);
    return rank(a) - rank(b);
  });
}

/**
 * Groups registry servers by displayName. Variants are ordered app before text.
 * Used for dev mock data only; production catalog is consolidated by the backend.
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
    const ordered = sortRegistryVariantsAppBeforeText(variants);
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

function sortRawCatalogCards(
  cards: RegistryCatalogCard[],
): RegistryCatalogCard[] {
  return [...cards].sort((a, b) => {
    if (a.isStarred !== b.isStarred) return a.isStarred ? -1 : 1;
    return a.catalogSortOrder - b.catalogSortOrder;
  });
}

function sortCatalogCards(
  cards: EnrichedRegistryCatalogCard[],
): EnrichedRegistryCatalogCard[] {
  return [...cards].sort((a, b) => {
    if (a.isStarred !== b.isStarred) return a.isStarred ? -1 : 1;
    return a.catalogSortOrder - b.catalogSortOrder;
  });
}

function enrichCatalogCards(
  cards: RegistryCatalogCard[],
  connectedRegistryIds: Set<string>,
  liveServers?: Record<string, { connectionStatus: string }>,
): EnrichedRegistryCatalogCard[] {
  return cards.map((card) => {
    const mapped: EnrichedRegistryServer[] = card.variants.map((server) => {
      const isAddedToProject = connectedRegistryIds.has(server._id);
      const liveServer = liveServers?.[getRegistryServerName(server)];
      let connectionStatus: RegistryConnectionStatus = "not_connected";

      if (liveServer?.connectionStatus === "connected") {
        connectionStatus = "connected";
      } else if (liveServer?.connectionStatus === "connecting") {
        connectionStatus = "connecting";
      } else if (isAddedToProject) {
        connectionStatus = "added";
      }

      return { ...server, connectionStatus };
    });
    const variants = sortRegistryVariantsAppBeforeText(mapped);

    return {
      registryCardKey: card.registryCardKey,
      catalogSortOrder: card.catalogSortOrder,
      variants,
      starCount: card.starCount,
      isStarred: card.isStarred,
      hasDualType: variants.length > 1,
    };
  });
}

function buildMockCatalogCards(): RegistryCatalogCard[] {
  const enriched: EnrichedRegistryServer[] = MOCK_REGISTRY_SERVERS.map((s) => ({
    ...s,
    connectionStatus: "not_connected" as const,
  }));
  const consolidated = consolidateServers(enriched);
  return consolidated.map((c, i) => ({
    registryCardKey: `mock:${c.variants[0].displayName}:${i}`,
    catalogSortOrder: c.variants[0].sortOrder ?? i,
    variants: c.variants.map((v) => {
      const { connectionStatus: _, ...rest } = v;
      return rest;
    }),
    starCount: 0,
    isStarred: false,
  }));
}

function isMissingProjectConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Registry server is not connected to this project")
  );
}

/**
 * Hook for fetching registry servers and managing connections.
 *
 * Pattern follows useProjectMutations / useServerMutations in useProjects.ts.
 */
export function useRegistryServers({
  enabled: callerEnabled = true,
  projectId,
  isAuthenticated,
  liveServers,
  onConnect,
  onDisconnect,
}: {
  enabled?: boolean;
  projectId: string | null;
  isAuthenticated: boolean;
  liveServers?: Record<string, { connectionStatus: string }>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
}) {
  // Force-disable the hook regardless of caller while the registry feature
  // is gated. See REGISTRY_FEATURE_ENABLED above.
  const enabled = REGISTRY_FEATURE_ENABLED && callerEnabled;
  const [rawCatalog, setRawCatalog] = useState<RegistryCatalogCard[] | null>(
    () => (DEV_MOCK_REGISTRY ? buildMockCatalogCards() : null),
  );

  const mergeRanRef = useRef(false);
  const mergeInFlightRef = useRef(false);
  // Bumped after a transient merge failure to force the merge effect to
  // re-run (refs alone don't participate in effect deps). Bounded so a
  // persistent error doesn't loop forever.
  const [mergeRetryNonce, setMergeRetryNonce] = useState(0);
  const mergeAttemptCountRef = useRef(0);
  const MAX_MERGE_ATTEMPTS = 3;

  useEffect(() => {
    if (!isAuthenticated) {
      mergeRanRef.current = false;
      mergeAttemptCountRef.current = 0;
    }
  }, [isAuthenticated]);

  const loadCatalog = useCallback(async () => {
    if (DEV_MOCK_REGISTRY) {
      setRawCatalog(buildMockCatalogCards());
      return;
    }
    try {
      const cards = await fetchRegistryCatalog();
      setRawCatalog(cards);
    } catch (error) {
      const message =
        error instanceof WebApiError
          ? error.message
          : "Failed to load registry catalog";
      toast.error(message);
      setRawCatalog([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (DEV_MOCK_REGISTRY) return;
    void loadCatalog();
  }, [enabled, loadCatalog]);

  useEffect(() => {
    if (!enabled) return;
    if (!HOSTED_MODE || !isAuthenticated || DEV_MOCK_REGISTRY) return;
    if (mergeRanRef.current || mergeInFlightRef.current) return;
    if (mergeAttemptCountRef.current >= MAX_MERGE_ATTEMPTS) return;
    mergeInFlightRef.current = true;
    mergeAttemptCountRef.current += 1;
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        const guestToken = await getExistingGuestBearerToken();
        if (cancelled) return;
        // null here is a definitive "no guest exists" miss (HTTP 204 from
        // upstream); transient errors throw and are handled below so we
        // don't permanently latch the merge as done after a network blip.
        if (!guestToken) {
          mergeRanRef.current = true;
          return;
        }
        await mergeGuestRegistryStars(guestToken);
        if (cancelled) return;
        clearGuestSession();
        resetTokenCache();
        await loadCatalog();
        if (cancelled) return;
        mergeRanRef.current = true;
      } catch (error) {
        const message =
          error instanceof WebApiError
            ? error.message
            : "Could not merge guest stars";
        toast.error(message);
        // Schedule a retry by bumping the nonce, which is in this effect's
        // deps. Backoff grows with attempt count; capped by MAX_MERGE_ATTEMPTS.
        if (
          !cancelled &&
          mergeAttemptCountRef.current < MAX_MERGE_ATTEMPTS
        ) {
          const delayMs = 1_000 * 2 ** (mergeAttemptCountRef.current - 1);
          retryTimeout = setTimeout(() => {
            if (!cancelled) setMergeRetryNonce((n) => n + 1);
          }, delayMs);
        }
      } finally {
        mergeInFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimeout !== null) clearTimeout(retryTimeout);
    };
  }, [enabled, isAuthenticated, loadCatalog, mergeRetryNonce]);

  const connections = useQuery(
    "registryServers:getProjectRegistryConnections" as any,
    enabled && !DEV_MOCK_REGISTRY && isAuthenticated && projectId
      ? ({ projectId } as any)
      : "skip",
  ) as RegistryServerConnection[] | undefined;

  const connectMutation = useMutation(
    "registryServers:connectRegistryServer" as any,
  );
  const disconnectMutation = useMutation(
    "registryServers:disconnectRegistryServer" as any,
  );

  const connectedRegistryIds = useMemo(() => {
    if (!connections) return new Set<string>();
    return new Set(connections.map((c) => c.registryServerId));
  }, [connections]);

  const catalogCards = useMemo(() => {
    if (!enabled) return [];
    if (rawCatalog === null) return [];
    const enriched = enrichCatalogCards(
      rawCatalog,
      connectedRegistryIds,
      liveServers,
    );
    return sortCatalogCards(enriched);
  }, [enabled, rawCatalog, connectedRegistryIds, liveServers]);

  const categories = useMemo(() => {
    if (!enabled) return [];
    const cats = new Set<string>();
    for (const card of catalogCards) {
      for (const v of card.variants) {
        if (v.category) cats.add(v.category);
      }
    }
    return Array.from(cats).sort();
  }, [enabled, catalogCards]);

  const [pendingServerIds, setPendingServerIds] = useState<Map<string, string>>(
    new Map(),
  );

  useEffect(() => {
    if (!enabled) return;
    if (!isAuthenticated || !projectId || DEV_MOCK_REGISTRY) return;
    for (const [registryServerId, serverName] of pendingServerIds) {
      if (connectedRegistryIds.has(registryServerId)) {
        setPendingServerIds((prev) => {
          const next = new Map(prev);
          next.delete(registryServerId);
          return next;
        });
        continue;
      }

      const liveServer = liveServers?.[serverName];
      if (liveServer?.connectionStatus === "connected") {
        setPendingServerIds((prev) => {
          const next = new Map(prev);
          next.delete(registryServerId);
          return next;
        });
        connectMutation({
          registryServerId,
          projectId,
        } as any);
      }
    }
  }, [
    liveServers,
    pendingServerIds,
    isAuthenticated,
    projectId,
    enabled,
    connectMutation,
    connectedRegistryIds,
  ]);

  const connectionsAreLoading =
    enabled &&
    !DEV_MOCK_REGISTRY &&
    isAuthenticated &&
    !!projectId &&
    connections === undefined;

  const isLoading =
    enabled &&
    !DEV_MOCK_REGISTRY &&
    (rawCatalog === null || connectionsAreLoading);

  const toggleStar = useCallback(async (registryCardKey: string) => {
    if (DEV_MOCK_REGISTRY) return;

    const priorStarState: {
      current: { isStarred: boolean; starCount: number } | null;
    } = { current: null };

    setRawCatalog((prev) => {
      if (!prev) return prev;
      const card = prev.find((c) => c.registryCardKey === registryCardKey);
      if (!card) return prev;
      priorStarState.current = {
        isStarred: card.isStarred,
        starCount: card.starCount,
      };
      const nextStarred = !card.isStarred;
      const nextCount = Math.max(0, card.starCount + (nextStarred ? 1 : -1));
      return sortRawCatalogCards(
        prev.map((c) =>
          c.registryCardKey === registryCardKey
            ? {
                ...c,
                isStarred: nextStarred,
                starCount: nextCount,
              }
            : c,
        ),
      );
    });

    const snapshot = priorStarState.current;
    if (!snapshot) return;

    try {
      const result = snapshot.isStarred
        ? await unstarRegistryCard(registryCardKey)
        : await starRegistryCard(registryCardKey);
      setRawCatalog((prev) => {
        if (!prev) return prev;
        return sortRawCatalogCards(
          prev.map((c) =>
            c.registryCardKey === registryCardKey
              ? {
                  ...c,
                  isStarred: result.isStarred,
                  starCount: result.starCount,
                }
              : c,
          ),
        );
      });
    } catch (error) {
      setRawCatalog((prev) => {
        if (!prev) return prev;
        return sortRawCatalogCards(
          prev.map((c) =>
            c.registryCardKey === registryCardKey
              ? {
                  ...c,
                  isStarred: snapshot.isStarred,
                  starCount: snapshot.starCount,
                }
              : c,
          ),
        );
      });
      const message =
        error instanceof WebApiError ? error.message : "Could not update star";
      toast.error(message);
    }
  }, []);

  async function connect(server: RegistryServer) {
    const serverName = getRegistryServerName(server);
    setPendingServerIds((prev) => new Map(prev).set(server._id, serverName));

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

    if (!DEV_MOCK_REGISTRY && isAuthenticated && projectId) {
      try {
        await disconnectMutation({
          registryServerId: server._id,
          projectId,
        } as any);
      } catch (error) {
        if (!isMissingProjectConnectionError(error)) {
          disconnectError = error;
        }
      }
    }

    onDisconnect?.(serverName);

    if (disconnectError) {
      throw disconnectError;
    }
  }

  /** Flat list of enriched servers for legacy callers / tests */
  const registryServers = useMemo(
    () => (enabled ? catalogCards.flatMap((c) => c.variants) : []),
    [enabled, catalogCards],
  );

  return {
    catalogCards,
    registryServers,
    categories,
    isLoading,
    connect,
    disconnect,
    toggleStar,
    refetchCatalog: loadCatalog,
  };
}
