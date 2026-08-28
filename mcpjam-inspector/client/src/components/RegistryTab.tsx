import { useCallback, useState, useEffect } from "react";
import {
  Package,
  KeyRound,
  ShieldOff,
  CheckCircle2,
  Loader2,
  MoreVertical,
  Unplug,
  BadgeCheck,
  Building2,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import { Card } from "@mcpjam/design-system/card";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { EmptyState } from "./ui/empty-state";
import { SearchInput } from "./ui/search-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { type RegistryConnectionStatus } from "@/hooks/useRegistryServers";
import {
  useServerDirectory,
  useDirectoryServerDetail,
  requiresEndpointChoice,
  requiresPreregisteredClient,
  normalizeDirectoryConnectError,
  describeExistingConnection,
  describeUnavailable,
  isConnectableDirectoryRow,
  sourceHasTiers,
  DIRECTORY_SOURCES,
  DIRECTORY_SOURCE_LABELS,
  DEFAULT_DIRECTORY_SOURCE,
  directorySourceBadge,
  DIRECTORY_TIERS,
  type DirectoryServer,
  type DirectorySource,
  type DirectoryTier,
} from "@/hooks/useServerDirectory";
import {
  useOrgRegistryServers,
  type EnrichedOrgRegistryServer,
  type OrgRegistrySubmission,
} from "@/hooks/useOrgRegistryServers";
import { DirectoryEndpointDialog } from "./registry/DirectoryEndpointDialog";
import { DirectoryDetailDialog } from "./registry/DirectoryDetailDialog";
import {
  OrgRegistryServerDialog,
  type OrgRegistryDialogSeed,
} from "./registry/OrgRegistryServerDialog";
import { OrgRegistryRemoveDialog } from "./registry/OrgRegistryRemoveDialog";
import { ErrorBoundary } from "./ui/error-boundary";
import { toast } from "@/lib/toast";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  clearPendingQuickConnect,
  readPendingQuickConnect,
  type PendingQuickConnectState,
} from "@/lib/quick-connect-pending";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  ConnectRegistryServerInspectorCommand,
  SearchRegistryDirectoryInspectorCommand,
} from "@/shared/inspector-command.js";

/** Drop stale registry pending when OAuth was abandoned (browser closed) without a terminal callback. */
const REGISTRY_PENDING_OAUTH_STALE_MS = 45 * 60 * 1000;

/**
 * Is the directory showing anything other than its default view?
 *
 * ONE definition, used by both the section (which hides itself when nothing is
 * loaded and nothing was asked) and the screen-level empty state. Two copies
 * drifted apart the moment a fourth control was added, and the drift is
 * invisible: the section would vanish while the empty state insisted the
 * screen was filtered, or the reverse.
 */
function isDirectoryFiltered(
  directory: Pick<
    ReturnType<typeof useServerDirectory>,
    "query" | "tier" | "connectableOnly" | "source"
  >
): boolean {
  return (
    directory.query.trim().length > 0 ||
    directory.tier !== "all" ||
    directory.connectableOnly ||
    directory.source !== DEFAULT_DIRECTORY_SOURCE
  );
}

/** Cap the agent snapshot's directory list — a state overview, not a dump. */
const AGENT_SNAPSHOT_MAX_DIRECTORY = 15;

/**
 * How the agent addresses a DIRECTORY entry: its display name ("Asana") or
 * its minted catalog name ("com.mcpjam/anthropic-asana-1a2b3c4d"). Exact
 * (case-insensitive) matches only — an unknown name must become
 * `unknown_server`, never a fuzzy guess.
 */
function matchesDirectoryServerName(
  item: DirectoryServer,
  serverName: string
): boolean {
  const wanted = serverName.trim().toLowerCase();
  return (
    item.displayName.toLowerCase() === wanted ||
    item.serverName.toLowerCase() === wanted
  );
}

function readDirectoryTier(value: unknown): DirectoryTier | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (DIRECTORY_TIERS as readonly string[]).includes(value)
  ) {
    return value as DirectoryTier;
  }
  throw createInspectorCommandClientError(
    "invalid_request",
    `'tier' must be one of ${DIRECTORY_TIERS.join(", ")} when provided.`
  );
}

function readDirectorySource(value: unknown): DirectorySource | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (DIRECTORY_SOURCES as readonly string[]).includes(value)
  ) {
    return value as DirectorySource;
  }
  throw createInspectorCommandClientError(
    "invalid_request",
    `'source' must be one of ${DIRECTORY_SOURCES.join(", ")} when provided.`
  );
}

const TIER_LABELS: Record<DirectoryTier, string> = {
  all: "All tiers",
  anthropic: "Anthropic",
  partner: "Partner",
  community: "Community",
};

interface RegistryTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
  onNavigate?: (tab: string) => void;
  servers?: Record<string, ServerWithName>;
}

export function RegistryTab({
  projectId,
  isAuthenticated,
  onConnect,
  onDisconnect,
  onNavigate,
  servers,
}: RegistryTabProps) {
  // isAuthenticated is passed through to the hooks for Convex mutation gating,
  // but the registry is always browsable without auth.
  const [pendingQuickConnect, setPendingQuickConnect] =
    useState<PendingQuickConnectState | null>(() => readPendingQuickConnect());

  const directory = useServerDirectory({
    projectId,
    isAuthenticated,
    onConnect,
  });

  // Which directory row the endpoint dialog is asking about, and the choices
  // to offer. `options`/`pattern` are seeded from the card and REPLACED by
  // whatever `endpoint_url_required` carried — the error is authoritative,
  // the row may predate the last sync.
  const [endpointPrompt, setEndpointPrompt] = useState<{
    server: DirectoryServer;
    options?: string[];
    pattern?: string;
    error?: string | null;
  } | null>(null);
  const [connectingDirectoryIds, setConnectingDirectoryIds] = useState<
    Set<string>
  >(new Set());

  // The directory card whose detail dialog is open. The body (tool names,
  // publisher, permissions) is fetched only while a card is open — the list
  // stays blob-free.
  const [detailServer, setDetailServer] = useState<DirectoryServer | null>(
    null
  );
  const detailServerDetail = useDirectoryServerDetail(
    detailServer?._id ?? null
  );
  const [orgShelfState, setOrgShelfState] = useState<{
    hasContent: boolean;
    isLoading: boolean;
  } | null>(null);
  const handleOrgShelfState = useCallback(
    (next: { hasContent: boolean; isLoading: boolean }) => {
      setOrgShelfState((previous) =>
        previous?.hasContent === next.hasContent &&
        previous?.isLoading === next.isLoading
          ? previous
          : next
      );
    },
    []
  );

  // Auto-redirect to App Builder when a pending server becomes connected.
  // We persist in localStorage to survive OAuth redirects (page remounts).
  useEffect(() => {
    const pending = pendingQuickConnect;
    if (!pending || pending.sourceTab !== "registry") return;
    const liveServer =
      servers?.[pending.serverName] ??
      Object.entries(servers ?? {}).find(
        ([name, server]) =>
          server.connectionStatus === "connected" &&
          name.startsWith(`${pending.displayName} (`)
      )?.[1];
    if (liveServer?.connectionStatus === "connected") {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
      onNavigate?.("playground");
    }
  }, [pendingQuickConnect, servers, onNavigate]);

  // `useRegistryServers.connect` returns after dispatching OAuth; pending stays for redirect UX.
  // Mirror ServersTab: clear when auth fails or the server is disconnected so the card does not
  // show "Connecting" forever (localStorage would otherwise keep matching pending).
  useEffect(() => {
    if (pendingQuickConnect?.sourceTab !== "registry") return;

    const pending = pendingQuickConnect;
    const pendingServer = servers?.[pending.serverName];
    const age = Date.now() - pending.createdAt;

    if (pendingServer) {
      if (
        pendingServer.connectionStatus === "failed" ||
        pendingServer.connectionStatus === "disconnected"
      ) {
        clearPendingQuickConnect();
        setPendingQuickConnect(null);
        return;
      }
      if (
        pendingServer.connectionStatus === "oauth-flow" &&
        age > REGISTRY_PENDING_OAUTH_STALE_MS
      ) {
        clearPendingQuickConnect();
        setPendingQuickConnect(null);
      }
      return;
    }

    if (age > 48 * 60 * 60 * 1000) {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    }
  }, [pendingQuickConnect, servers]);

  /**
   * Install a directory entry, and put the dialog up when it needs a URL.
   *
   * The mutation is the authority on whether an endpoint is required and on
   * which endpoints exist: an `options` row rendered before the last sync can
   * be listing a region that no longer resolves. So the card's own values only
   * SEED the first attempt; `endpoint_url_required` re-seeds from the error.
   */
  const runDirectoryConnect = useCallback(
    async (server: DirectoryServer, endpointUrl?: string) => {
      setConnectingDirectoryIds((prev) => new Set(prev).add(server._id));
      try {
        const result = await directory.connect(server, endpointUrl);
        // The hook wrote the marker to localStorage (it has to survive an
        // OAuth redirect); mirror it into state so THIS session's effects —
        // auto-navigate on connect, stale cleanup — see it too, exactly as
        // they do for a directory connect.
        setPendingQuickConnect(result.pending);
        setEndpointPrompt(null);
        // The workspace already talks to this endpoint through the other
        // directory's row. Saying so beats a silent no-op that looks like a
        // click that did nothing.
        const reused = describeExistingConnection(result);
        if (reused) toast.info(reused);
        return { ok: true as const };
      } catch (rawError) {
        const error = normalizeDirectoryConnectError(rawError);
        switch (error.code) {
          case "endpoint_url_required":
            // Not a failure the user should read as one: the row simply
            // cannot be connected without a choice only they can make.
            setEndpointPrompt({
              server,
              options: error.options ?? server.remoteUrlOptions,
              pattern: error.pattern ?? server.remoteUrlRegex,
              error: null,
            });
            break;
          case "endpoint_url_invalid":
          case "endpoint_url_not_allowed":
          case "endpoint_url_not_configurable":
            // Keep the dialog open with the refusal inline — the user is one
            // correction away, and a toast would take the context with it.
            setEndpointPrompt((prev) =>
              prev && prev.server._id === server._id
                ? { ...prev, error: error.message }
                : {
                    server,
                    options: error.options ?? server.remoteUrlOptions,
                    pattern: error.pattern ?? server.remoteUrlRegex,
                    error: error.message,
                  }
            );
            break;
          case "already_connected_to_different_endpoint":
            setEndpointPrompt(null);
            toast.error(
              error.connectedUrl
                ? `${server.displayName} is already connected to ${error.connectedUrl}.`
                : error.message
            );
            break;
          default:
            setEndpointPrompt(null);
            toast.error(error.message);
            break;
        }
        return { ok: false as const, error };
      } finally {
        setConnectingDirectoryIds((prev) => {
          const next = new Set(prev);
          next.delete(server._id);
          return next;
        });
      }
    },
    [directory]
  );

  const handleDirectoryConnect = useCallback(
    async (server: DirectoryServer) => {
      // Ask FIRST for a row we already know needs a choice, rather than
      // spending a round trip to be told so. The mutation still decides.
      if (requiresEndpointChoice(server)) {
        setEndpointPrompt({
          server,
          options: server.remoteUrlOptions,
          pattern: server.remoteUrlRegex,
          error: null,
        });
        return;
      }
      await runDirectoryConnect(server);
    },
    [runDirectoryConnect]
  );

  /**
   * The card's state, from the two facts that answer it.
   *
   * `added` comes from the connection rows the mutation writes; everything
   * after that comes from the LIVE servers map, because a mutation success
   * means installed, never connected.
   */
  const directoryStatusFor = useCallback(
    (server: DirectoryServer): RegistryConnectionStatus | "error" => {
      if (connectingDirectoryIds.has(server._id)) return "connecting";
      const connection = directory.connections.find(
        (c) => c.catalogServerId === server._id
      );
      const liveName = connection?.serverName ?? null;
      const live = liveName ? servers?.[liveName] : undefined;
      if (live?.connectionStatus === "connected") return "connected";
      if (
        live?.connectionStatus === "connecting" ||
        live?.connectionStatus === "oauth-flow"
      ) {
        return "connecting";
      }
      if (live?.connectionStatus === "failed") return "error";
      // Coming back from an OAuth redirect, `connectingDirectoryIds` is gone
      // (the component remounted) and the live map has not caught up yet — so
      // without this the card would briefly offer Connect again on a server
      // the user has just authorized. This is what `catalogServerId` on the
      // pending marker is for; localStorage is the only thing that survived
      // the navigation.
      if (
        pendingQuickConnect?.sourceTab === "registry" &&
        pendingQuickConnect.catalogServerId === server._id
      ) {
        return "connecting";
      }
      return connection ? "added" : "not_connected";
    },
    [
      connectingDirectoryIds,
      directory.connections,
      pendingQuickConnect,
      servers,
    ]
  );

  /**
   * Answer a connect command for a DIRECTORY entry, or `null` if none matches.
   *
   * Every outcome is a report, never a redirect. Two honest refusals:
   *
   *   endpoint_choice_required — an `options` or `tenant` row. The URL is the
   *     user's to pick or type; a model guessing a region (or inventing a
   *     tenant hostname) would connect them somewhere they did not ask for.
   *
   *   authorization_required — the row is not KNOWN to be authless. Mirrors
   *     `connectCatalogServer`'s own posture: absent means "expect auth". A
   *     directory connect runs `authMethod: "auto"`, so even a surprise 401
   *     asks before redirecting — but queuing that prompt behind the model's
   *     back is not better than saying so.
   */
  const resolveDirectoryCommandTarget = useCallback(
    (rawName: unknown) => {
      if (typeof rawName !== "string" || rawName.trim().length === 0) {
        return null;
      }
      const item = directory.items.find((candidate) =>
        matchesDirectoryServerName(candidate, rawName)
      );
      if (!item) return null;

      const serverName = item.displayName;
      if (!isConnectableDirectoryRow(item)) {
        // Keyed on the row, not on the kind: `none` means "a local desktop
        // extension" on one source and "a hosted server whose endpoint the
        // directory will not publish" on the other, and the model relays this
        // text to a person who would go looking for an installer.
        return {
          status: "not_connectable",
          serverName,
          message: describeUnavailable(item),
          ...(item.unavailableReason ? { reason: item.unavailableReason } : {}),
        };
      }
      const status = directoryStatusFor(item);
      if (status === "connected") {
        return { status: "already_connected", serverName };
      }
      if (status === "connecting") return { status: "connecting", serverName };
      if (requiresEndpointChoice(item)) {
        return {
          status: "endpoint_choice_required",
          serverName,
          endpointKind: item.endpointKind,
          message:
            item.endpointKind === "options"
              ? "This connector publishes several endpoints. Ask the user to click Connect on its card and pick one — do not guess."
              : "This connector runs on the user's own instance. Ask the user to click Connect on its card and enter their URL — do not invent one.",
        };
      }
      if (item.isAuthless !== true) {
        return {
          status: "authorization_required",
          serverName,
          message:
            "This connector expects authorization, which redirects the browser and would end this turn. Ask the user to click Connect on its card and authorize on screen.",
        };
      }
      void handleDirectoryConnect(item);
      return { status: "connecting", serverName };
    },
    [directory.items, directoryStatusFor, handleDirectoryConnect]
  );

  // Agent bridge: the registry tool group plus this screen's command
  // handlers and snapshot. Connect resolves against the directory on this
  // screen — the hand-curated catalog is retired.
  useSurfaceAgentBridge({
    surfaceId: "registry",
    handlers: {
      connectRegistryServer: async (command) => {
        const { payload } = command as ConnectRegistryServerInspectorCommand;
        const directoryMatch = resolveDirectoryCommandTarget(
          payload.serverName
        );
        if (directoryMatch) return directoryMatch;

        if (typeof payload.serverName !== "string" || !payload.serverName.trim()) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Missing required 'serverName' string."
          );
        }
        if (directory.items.length === 0) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "The connector directory is empty or unavailable right now — no servers to act on."
          );
        }
        throw createInspectorCommandClientError(
          "unknown_server",
          `No registry server matches "${payload.serverName}". Use a name from the directory on this screen.`
        );
      },
      disconnectRegistryServer: async () => {
        throw createInspectorCommandClientError(
          "unsupported_in_mode",
          "Disconnect a project server with ui_disconnect_server. The curated registry catalog is gone."
        );
      },
      toggleRegistryStar: async () => {
        throw createInspectorCommandClientError(
          "unsupported_in_mode",
          "Stars belonged to the retired curated registry catalog."
        );
      },
      searchRegistryDirectory: async (command) => {
        const { payload } = command as SearchRegistryDirectoryInspectorCommand;
        if (payload.query !== undefined && typeof payload.query !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'query' must be a string when provided."
          );
        }
        const tier = readDirectoryTier(payload.tier);
        const source = readDirectorySource(payload.source);
        // DRIVES the screen's own controls rather than running a private
        // query: what the model reads back is what the person is looking at,
        // and the follow-up connect resolves against the same rows.
        directory.setQuery(payload.query ?? "");

        // A TIER ONLY MEANS SOMETHING ON A SOURCE THAT PUBLISHES ONE.
        //
        // Two ways that bites. Switching to a tier-less source clears the tier
        // the screen was showing, so a response echoing `directory.tier` would
        // report a filter that had just been dropped — this render's closure
        // still holds the old value. And applying a tier to a tier-less source
        // parks an inert value in state that springs back the moment the user
        // switches to a source that does publish tiers, silently narrowing a
        // view they never filtered.
        //
        // So the effective tier is computed once, from the source that will be
        // in force, and it is what gets both applied and reported.
        const nextSource = source ?? directory.source;
        const sourceTakesTiers = sourceHasTiers(nextSource);
        const nextTier = sourceTakesTiers ? tier ?? directory.tier : "all";

        // Source first: on a source that DOES take tiers it clears nothing, and
        // ordering it after `setTier` would let the switch wipe a tier that
        // arrived in the same call.
        if (source) directory.setSource(source);
        if (tier && sourceTakesTiers) directory.setTier(tier);
        return {
          status: "searching",
          query: payload.query ?? "",
          source: nextSource,
          tier: nextTier,
          note: "Results are debounced — read them from ui_snapshot_app's `directory` block.",
        };
      },
    },
    // Redacted STATE, not payloads: names and statuses only — no transport
    // URLs, no OAuth internals, no tokens.
    snapshot: () => ({
      isLoading: directory.isLoadingFirstPage,
      ...(pendingQuickConnect?.sourceTab === "registry"
        ? { pendingConnect: { serverName: pendingQuickConnect.serverName } }
        : {}),
      // Same redaction rule as `servers` above: names and statuses, never a
      // transport URL. A directory row's URL is the one field that would turn
      // this snapshot into an endpoint list, and `endpointKind` says what the
      // model actually needs (whether a choice is required) without it.
      directory: {
        query: directory.query,
        source: directory.source,
        tier: directory.tier,
        loadedCount: directory.items.length,
        hasMore: directory.canLoadMore,
        ...(directory.lastSyncedAt
          ? { asOf: new Date(directory.lastSyncedAt).toISOString() }
          : {}),
        visible: directory.items
          .slice(0, AGENT_SNAPSHOT_MAX_DIRECTORY)
          .map((item) => ({
            name: item.displayName,
            ...(item.verifiedTier ? { tier: item.verifiedTier } : {}),
            status: directoryStatusFor(item),
            requiresEndpointChoice: requiresEndpointChoice(item),
            // So the model does not offer to install something that cannot be
            // installed. The REASON travels too: "endpoint not published" and
            // "local extension" call for different things to say.
            ...(isConnectableDirectoryRow(item)
              ? {}
              : {
                  connectable: false as const,
                  ...(item.unavailableReason
                    ? { unavailableReason: item.unavailableReason }
                    : {}),
                }),
          })),
      },
    }),
  });

  // Per-SECTION emptiness, not per-screen. The public directory and the
  // organization's own shelf have independent backends. Only when BOTH are
  // empty and none is still loading is there genuinely nothing to show.
  const directoryEmpty =
    !directory.isLoadingFirstPage && directory.items.length === 0;
  const directoryFiltered = isDirectoryFiltered(directory);
  const orgShelfEmpty =
    orgShelfState !== null &&
    !orgShelfState.isLoading &&
    !orgShelfState.hasContent;

  if (directory.isLoadingFirstPage && orgShelfState?.isLoading !== false) {
    return <LoadingSkeleton />;
  }

  if (directoryEmpty && orgShelfEmpty && !directoryFiltered) {
    return (
      <EmptyState
        icon={Package}
        title="No servers available"
        description="Share a server with your organization, or search a connector directory."
      />
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="space-y-8 p-8">
        {/* Header */}
        <div>
          <h2 className="text-lg font-semibold">Registry</h2>
          <p className="text-sm text-muted-foreground">
            Servers your organization has shared, plus connector directories you
            can connect from.
          </p>
        </div>

        {/*
          The organization's own shelf, above the directories: it is the
          smaller list and the one a team put there on purpose.

          Behind its OWN boundary. This section is the only part of the tab
          that reads functions the deployed backend may not have yet — a
          browser can outlive a rollback, and `useQuery` for a missing function
          throws during render. Without the boundary that takes the entire
          Registry tab, directory included, down with it.
        */}
        <ErrorBoundary name="org-registry-section" fallback={null}>
          <OrgRegistrySectionContainer
            projectId={projectId}
            isAuthenticated={isAuthenticated}
            liveServers={servers}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onState={handleOrgShelfState}
          />
        </ErrorBoundary>

        <ServerDirectorySection
          directory={directory}
          statusFor={directoryStatusFor}
          onConnect={handleDirectoryConnect}
          onOpenDetail={setDetailServer}
        />
      </div>

      {detailServer && (
        <DirectoryDetailDialog
          open
          onOpenChange={(open) => {
            if (!open) setDetailServer(null);
          }}
          server={detailServer}
          detail={detailServerDetail}
          badges={<DirectoryBadges server={detailServer} />}
          action={
            <DirectoryAction
              status={directoryStatusFor(detailServer)}
              onConnect={() => {
                // Hand off to the card's connect flow — and get out of its
                // way: the endpoint dialog (or an OAuth redirect) may be
                // about to take over, and a detail dialog underneath it
                // would fight for focus.
                const server = detailServer;
                setDetailServer(null);
                void handleDirectoryConnect(server);
              }}
            />
          }
        />
      )}
      {endpointPrompt && (
        <DirectoryEndpointDialog
          open
          onOpenChange={(open) => {
            if (!open) setEndpointPrompt(null);
          }}
          displayName={endpointPrompt.server.displayName}
          options={endpointPrompt.options}
          pattern={endpointPrompt.pattern}
          error={endpointPrompt.error ?? null}
          submitting={connectingDirectoryIds.has(endpointPrompt.server._id)}
          onSubmit={(endpointUrl) => {
            void runDirectoryConnect(endpointPrompt.server, endpointUrl);
          }}
        />
      )}
    </div>
  );
}

/**
 * Keeps every Convex-backed org-registry query and mutation below the section
 * boundary. A missing function or provider throws during render, so the hook
 * itself must be a descendant of the ErrorBoundary rather than a sibling.
 */
function OrgRegistrySectionContainer({
  projectId,
  isAuthenticated,
  liveServers,
  onConnect,
  onDisconnect,
  onState,
}: {
  projectId: string | null;
  isAuthenticated: boolean;
  liveServers?: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
  onState: (state: { hasContent: boolean; isLoading: boolean }) => void;
}) {
  const orgRegistry = useOrgRegistryServers({
    projectId,
    isAuthenticated,
    liveServers,
    onConnect,
    onDisconnect,
  });
  const [orgDialog, setOrgDialog] = useState<{
    seed: OrgRegistryDialogSeed | null;
  } | null>(null);
  const [orgRemoveTarget, setOrgRemoveTarget] =
    useState<EnrichedOrgRegistryServer | null>(null);
  const [orgRemoving, setOrgRemoving] = useState(false);

  useEffect(() => {
    onState({
      hasContent:
        Boolean(orgRegistry.organizationId) &&
        (orgRegistry.servers.length > 0 || orgRegistry.canAdd),
      isLoading: orgRegistry.isLoading,
    });
  }, [
    onState,
    orgRegistry.canAdd,
    orgRegistry.isLoading,
    orgRegistry.organizationId,
    orgRegistry.servers.length,
  ]);

  const handleOrgSubmit = useCallback(
    async (submission: OrgRegistrySubmission) => {
      if (submission.registryServerId) {
        await orgRegistry.update(submission);
        toast.success("Registry entry updated");
        return;
      }
      await orgRegistry.add(submission);
      toast.success("Added to your organization's registry");
    },
    [orgRegistry]
  );

  const handleOrgConnect = useCallback(
    async (server: EnrichedOrgRegistryServer) => {
      try {
        await orgRegistry.connect(server);
      } catch (error) {
        const message =
          error instanceof Error &&
          /already exists in this workspace/i.test(error.message)
            ? `A server named "${server.displayName}" already exists in this project. Rename it, or rename the registry entry.`
            : error instanceof Error
            ? error.message
            : "Could not connect this server.";
        toast.error(message);
      }
    },
    [orgRegistry]
  );

  const handleOrgDisconnect = useCallback(
    async (server: EnrichedOrgRegistryServer) => {
      try {
        await orgRegistry.disconnect(server);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not disconnect this server."
        );
      }
    },
    [orgRegistry]
  );

  const handleOrgRemoveConfirmed = useCallback(async () => {
    if (!orgRemoveTarget) return;
    setOrgRemoving(true);
    try {
      await orgRegistry.remove(orgRemoveTarget._id);
      toast.success("Removed from your organization's registry");
      setOrgRemoveTarget(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove this entry."
      );
    } finally {
      setOrgRemoving(false);
    }
  }, [orgRegistry, orgRemoveTarget]);

  return (
    <>
      <OrgRegistrySection
        registry={orgRegistry}
        onAdd={() => setOrgDialog({ seed: null })}
        onEdit={(server) =>
          setOrgDialog({
            seed: {
              registryServerId: server._id,
              displayName: server.displayName,
              description: server.description,
              url: server.transport.url ?? "",
              useOAuth: server.transport.useOAuth,
              oauthScopes: server.transport.oauthScopes,
              derived: server.derived,
            },
          })
        }
        onRemove={setOrgRemoveTarget}
        onConnect={handleOrgConnect}
        onDisconnect={handleOrgDisconnect}
      />
      {orgRemoveTarget && (
        <OrgRegistryRemoveDialog
          open
          onOpenChange={(open) => {
            if (!open && !orgRemoving) setOrgRemoveTarget(null);
          }}
          displayName={orgRemoveTarget.displayName}
          isRemoving={orgRemoving}
          onConfirm={() => void handleOrgRemoveConfirmed()}
        />
      )}
      {orgDialog && (
        <OrgRegistryServerDialog
          open
          onOpenChange={(open) => {
            if (!open) setOrgDialog(null);
          }}
          projectId={projectId}
          seed={orgDialog.seed}
          onSubmit={handleOrgSubmit}
        />
      )}
    </>
  );
}

/**
 * The organization's own shelf.
 *
 * Renders nothing at all for a project outside an organization, or for
 * somebody who is neither a member nor looking at any entries — an empty
 * "Your organization" heading over a project that has no organization is
 * noise, not information. It DOES render for a member with an empty shelf,
 * because that is the state the invitation to add belongs in.
 *
 * The cards carry no star control. Stars are the identity of a consolidated
 * PUBLIC card (`registryCardKey`), an org entry has none, and the backend's
 * star mutation refuses a synthetic key outright — so a star here would be a
 * button that cannot work.
 */
function OrgRegistrySection({
  registry,
  onAdd,
  onEdit,
  onRemove,
  onConnect,
  onDisconnect,
}: {
  registry: ReturnType<typeof useOrgRegistryServers>;
  onAdd: () => void;
  onEdit: (server: EnrichedOrgRegistryServer) => void;
  onRemove: (server: EnrichedOrgRegistryServer) => void | Promise<void>;
  onConnect: (server: EnrichedOrgRegistryServer) => void | Promise<void>;
  onDisconnect: (server: EnrichedOrgRegistryServer) => void | Promise<void>;
}) {
  const { servers, isLoading, organizationId, canAdd } = registry;

  if (!organizationId) return null;
  if (!canAdd && servers.length === 0 && !isLoading) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Your organization
          </h3>
          <p className="text-xs text-muted-foreground">
            Servers your team has shared. Visible in every project in this
            organization.
          </p>
        </div>
        {canAdd && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={onAdd}
          >
            <Plus className="h-3.5 w-3.5" />
            Add a server
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <Card className="px-4 py-6 text-center">
          <p className="text-sm font-medium">Nothing shared yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Paste a remote server&rsquo;s address and we&rsquo;ll read the rest
            off it — or share one you already have connected from its menu on
            the Servers tab.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {servers.map((server) => (
            <OrgRegistryServerCard
              key={server._id}
              server={server}
              canManage={canAdd}
              onEdit={() => onEdit(server)}
              onRemove={() => void onRemove(server)}
              onConnect={() => void onConnect(server)}
              onDisconnect={() => void onDisconnect(server)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One org entry.
 *
 * Deliberately a sibling of `RegistryServerCard` rather than a prop on it. The
 * curated card REQUIRES star props and a `registryCardKey`, and an org row has
 * neither; threading "no stars" through it would leave a component whose two
 * modes disagree about what identifies a card. The shapes are close enough to
 * read as one family and different enough that one component would be lying.
 */
function OrgRegistryServerCard({
  server,
  canManage,
  onEdit,
  onRemove,
  onConnect,
  onDisconnect,
}: {
  server: EnrichedOrgRegistryServer;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const version = server.derived?.serverVersion ?? server.version;
  const authRequired =
    server.derived?.authRequired ?? server.transport.useOAuth ?? false;
  /**
   * Same rule the directory badge uses: only a server that demands auth AND
   * resolved no way to register a client dynamically needs one in advance. An
   * entry with no probe snapshot says nothing rather than making a claim the
   * probe never backed.
   */
  const needsPreregisteredClient =
    authRequired &&
    server.derived !== undefined &&
    !server.derived.supportsDcr &&
    !server.derived.supportsCimd;

  return (
    <Card className="px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
          <Building2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold truncate">
            {server.displayName}
          </h3>
          <p className="text-xs text-muted-foreground truncate">
            {server.transport.url}
          </p>
        </div>
        <div className="flex-shrink-0 flex items-center gap-1">
          <TopRightAction
            status={server.connectionStatus}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label={`Manage ${server.displayName}`}
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit entry
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove from registry
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {version && (
          <Badge variant="secondary" className="text-[10px]">
            v{version}
          </Badge>
        )}
        <AuthBadge useOAuth={authRequired} />
        {needsPreregisteredClient && (
          <Badge variant="outline" className="text-[10px]">
            Requires pre-registered client
          </Badge>
        )}
      </div>

      {server.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {server.description}
        </p>
      )}
    </Card>
  );
}

/**
 * The mirrored upstream directories.
 *
 * Thousands of entries per source, so it is search-first: no all-at-once grid,
 * a debounced query, a source facet, a tier filter, and an explicit Load more.
 *
 * ONE SOURCE AT A TIME (Claude by default). Cross-directory listing overlap
 * stays visible when someone switches — a connector listed in both is a
 * signal, not a duplicate to hide — and only CONNECT collapses the two, in the
 * backend.
 */
function ServerDirectorySection({
  directory,
  statusFor,
  onConnect,
  onOpenDetail,
}: {
  directory: ReturnType<typeof useServerDirectory>;
  statusFor: (server: DirectoryServer) => RegistryConnectionStatus | "error";
  onConnect: (server: DirectoryServer) => void;
  onOpenDetail: (server: DirectoryServer) => void;
}) {
  const { items, query, setQuery, tier, setTier, source, setSource } =
    directory;
  const filtering = isDirectoryFiltered(directory);

  // Nothing loaded and nothing asked for: the section stays out of the way
  // rather than advertising an empty directory (the gated-off case).
  if (!filtering && items.length === 0 && !directory.isLoadingFirstPage) {
    return null;
  }

  return (
    <section className="space-y-4" data-testid="server-directory-section">
      <div>
        <h3 className="text-sm font-semibold">Connector directories</h3>
        <p className="text-xs text-muted-foreground">
          Connectors mirrored from a public directory. Search to find one, then
          connect it into this project.
          {directory.lastSyncedAt ? (
            <>
              {" "}
              <span data-testid="directory-as-of">
                {DIRECTORY_SOURCE_LABELS[source]} as of{" "}
                {new Date(directory.lastSyncedAt).toLocaleDateString()}.
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={`Search the ${DIRECTORY_SOURCE_LABELS[source]}…`}
          className="w-full sm:w-72"
        />
        <Select
          value={source}
          onValueChange={(value) => setSource(value as DirectorySource)}
        >
          <SelectTrigger
            data-testid="directory-source-filter"
            className="h-8 w-[min(100%,11rem)] text-xs"
            aria-label="Choose which directory to browse"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIRECTORY_SOURCES.map((value) => (
              <SelectItem key={value} value={value}>
                {DIRECTORY_SOURCE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={directory.connectableOnly ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          aria-pressed={directory.connectableOnly}
          data-testid="directory-connectable-filter"
          onClick={() =>
            directory.setConnectableOnly(!directory.connectableOnly)
          }
        >
          Connectable only
        </Button>
        {/* Verification tiers are a Claude concept. Rendering the filter for a
            source that publishes none would offer a control that can only ever
            empty the list. */}
        {sourceHasTiers(source) && (
          <Select
            value={tier}
            onValueChange={(value) => setTier(value as DirectoryTier)}
          >
            <SelectTrigger
              data-testid="directory-tier-filter"
              className="h-8 w-[min(100%,9rem)] text-xs"
              aria-label="Filter the directory by tier"
            >
              <SelectValue placeholder="All tiers" />
            </SelectTrigger>
            <SelectContent>
              {DIRECTORY_TIERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {TIER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {directory.isLoadingFirstPage ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No directory connectors match that search.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map((item) => (
            <DirectoryServerCard
              key={item._id}
              server={item}
              status={statusFor(item)}
              onConnect={() => onConnect(item)}
              onOpenDetail={() => onOpenDetail(item)}
            />
          ))}
        </div>
      )}

      {directory.canLoadMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => directory.loadMore()}
          >
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function DirectoryServerCard({
  server,
  status,
  onConnect,
  onOpenDetail,
}: {
  server: DirectoryServer;
  status: RegistryConnectionStatus | "error";
  onConnect: () => void;
  onOpenDetail: () => void;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const showIcon = Boolean(server.iconUrl) && !iconFailed;
  const connectable = isConnectableDirectoryRow(server);
  const unavailable = connectable ? null : describeUnavailable(server);

  return (
    <Card
      className="px-4 py-3 flex flex-col gap-2 cursor-pointer transition-colors hover:border-muted-foreground/30"
      // The whole card opens the detail dialog; the Connect button inside
      // stops propagation so the two targets never fight. A real <button>
      // cannot wrap another button, hence the ARIA affordance.
      role="button"
      tabIndex={0}
      aria-label={`View details for ${server.displayName}`}
      data-testid="directory-server-card"
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <div className="flex items-center gap-3">
        {showIcon ? (
          <img
            src={server.iconUrl}
            alt=""
            // Third-party image on someone else's CDN: lazy so a long list
            // does not fetch 2,000 of them, no referrer so browsing the
            // directory does not tell every publisher which page you are on,
            // and a fallback because a dead icon must not leave a hole.
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setIconFailed(true)}
            className="h-8 w-8 rounded-md object-contain flex-shrink-0"
          />
        ) : (
          <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
            <Package className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold truncate flex items-center gap-1">
            <span className="truncate">{server.displayName}</span>
            {server.verifiedTier === "anthropic" && <VerifiedBadge />}
          </h4>
          {/* PROVENANCE, not endorsement: "Listed in ChatGPT" says OpenAI
              accepted a submission, which is not a tier of ours. */}
          <p className="text-xs text-muted-foreground">
            {directorySourceBadge(server.source)}
          </p>
        </div>
        <div
          className="flex-shrink-0"
          onClick={(event) => event.stopPropagation()}
        >
          {connectable ? (
            <DirectoryAction status={status} onConnect={onConnect} />
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs cursor-default"
              disabled
              title={unavailable ?? undefined}
            >
              Not connectable
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <DirectoryBadges server={server} />
      </div>

      {/* Why, in the row's own terms. A hidden hosted endpoint and a desktop
          extension are different situations and were both `endpointKind:
          'none'`; one line of wrong copy here sends someone hunting for an
          installer that does not exist. */}
      {unavailable && (
        <p
          className="text-xs text-muted-foreground italic"
          data-testid="directory-unavailable-reason"
        >
          {unavailable}
        </p>
      )}

      {server.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {server.description}
        </p>
      )}
    </Card>
  );
}

/** The tier + endpoint chips, identical on the card and the detail dialog. */
function DirectoryBadges({ server }: { server: DirectoryServer }) {
  return (
    <>
      <TierBadge tier={server.verifiedTier} />
      {requiresEndpointChoice(server) && (
        <Badge
          variant="outline"
          className="text-[11px] px-1.5 py-0.5 gap-1 border-muted-foreground/30 text-muted-foreground"
        >
          {server.endpointKind === "options"
            ? "Choose endpoint"
            : "Your instance"}
        </Badge>
      )}
      {/* A probe FACT, not upstream metadata: this server's authorization
          server answered and offers neither DCR nor CIMD, so connecting will
          need credentials issued by the vendor. Only `resolved` verdicts
          badge — see `requiresPreregisteredClient`. */}
      {requiresPreregisteredClient(server) && (
        <Badge
          variant="outline"
          className="text-[11px] px-1.5 py-0.5 gap-1 border-warning/30 text-warning"
        >
          <KeyRound className="h-3 w-3" />
          Requires pre-registered client
        </Badge>
      )}
    </>
  );
}

function TierBadge({ tier }: { tier?: string }) {
  if (!tier) return null;
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);
  // Semantic tokens, not literal colors: these badges have to stay legible in
  // both themes, and a hex here would only be right in one of them.
  const className =
    tier === "anthropic"
      ? "border-primary/30 text-primary"
      : tier === "partner"
      ? "border-success/30 text-success"
      : "border-muted-foreground/30 text-muted-foreground";
  return (
    <Badge
      variant="outline"
      className={`text-[11px] px-1.5 py-0.5 gap-1 ${className}`}
    >
      {label}
    </Badge>
  );
}

function DirectoryAction({
  status,
  onConnect,
}: {
  status: RegistryConnectionStatus | "error";
  onConnect: () => void;
}) {
  switch (status) {
    case "connected":
      return (
        <Button
          size="sm"
          className="h-7 text-xs bg-primary/10 hover:bg-primary/10 text-primary border border-primary/20 cursor-default"
          tabIndex={-1}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Connected
        </Button>
      );
    case "connecting":
      return (
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Connecting
        </Button>
      );
    case "error":
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs text-destructive border-destructive/30"
          onClick={onConnect}
        >
          Retry
        </Button>
      );
    case "added":
      return (
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={onConnect}
          title="Server is in your project — click to connect"
        >
          Connect
        </Button>
      );
    default:
      return (
        <Button size="sm" className="h-7 text-xs" onClick={onConnect}>
          Connect
        </Button>
      );
  }
}

/**
 * The verified check, shared by a curated card's verified publisher and a
 * directory card's Anthropic tier.
 *
 * The fill was a literal `#ae5630`, which is a light-theme brand color pasted
 * into a component that renders in both themes — it does not track the token
 * it was copied from, and it does not darken. `fill-primary` is the same mark
 * in both themes and moves with the palette.
 */
function VerifiedBadge() {
  return (
    <span className="inline-flex shrink-0" title="Verified publisher">
      <BadgeCheck
        className="h-4 w-4 shrink-0 [&>path:first-of-type]:fill-primary [&>path:first-of-type]:stroke-none [&>path:last-of-type]:stroke-background [&>path:last-of-type]:stroke-[2.5] [&>path:last-of-type]:[stroke-linecap:round] [&>path:last-of-type]:[stroke-linejoin:round]"
        aria-label="Verified publisher"
      />
    </span>
  );
}
function AuthBadge({ useOAuth }: { useOAuth?: boolean }) {
  if (useOAuth) {
    return (
      <Badge
        variant="outline"
        className="text-[11px] px-1.5 py-0.5 gap-1 border-success/30 text-success"
      >
        <KeyRound className="h-3 w-3" />
        OAuth
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[11px] px-1.5 py-0.5 gap-1 border-warning/30 text-warning"
    >
      <ShieldOff className="h-3 w-3" />
      No auth
    </Badge>
  );
}

function TopRightAction({
  status,
  onConnect,
  onDisconnect,
}: {
  status: RegistryConnectionStatus;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  switch (status) {
    case "connected":
      return (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-7 text-xs bg-primary/10 hover:bg-primary/10 text-primary border border-primary/20 cursor-default"
            tabIndex={-1}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected
          </Button>
          <OverflowMenu onDisconnect={onDisconnect} label="Disconnect" />
        </div>
      );
    case "connecting":
      return (
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Connecting
        </Button>
      );
    case "added":
      return (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={onConnect}
            title="Server is in your project — click to connect"
          >
            Connect
          </Button>
          <OverflowMenu onDisconnect={onDisconnect} label="Remove" />
        </div>
      );
    default:
      return (
        <Button size="sm" className="h-7 text-xs" onClick={onConnect}>
          Connect
        </Button>
      );
  }
}

function OverflowMenu({
  onDisconnect,
  label,
}: {
  onDisconnect: () => void;
  label: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDisconnect}>
          <Unplug className="h-3.5 w-3.5 mr-2" />
          {label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-5 p-8">
      <div>
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-12 rounded-full" />
        <Skeleton className="h-7 w-28 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
