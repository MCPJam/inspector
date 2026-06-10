import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { ReactFlowProvider } from "@xyflow/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import { Button } from "@mcpjam/design-system/button";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useHost, useHostMutations } from "@/hooks/useClients";
import { useProjectServers, useServerMutations } from "@/hooks/useProjects";
import { useAutoConnectProjectServers } from "@/hooks/useAutoConnectProjectServers";
import { useSharedAppState } from "@/state/app-state-context";
import { AddServerModal } from "@/components/connection/AddServerModal";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import type { ServerFormData } from "@/shared/types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  serverConnectionOverridesEqual,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { RedesignedHostCanvas } from "./canvas/RedesignedHostCanvas";
import { buildRedesignedHostCanvas } from "./canvas/canvasBuilder";
import { HostFocusPanel } from "./focus/HostFocusPanel";
import {
  hasBlockingErrors,
  useHostDraftValidation,
} from "./focus/useHostDraftValidation";
import {
  focusTabForNodeId,
  type HostFocusState,
  type HostFocusTabId,
  type SandboxConfigSubKey,
} from "./types";

interface HostBuilderViewRedesignedProps {
  hostId: string;
  projectId: string;
}

const CLOSED_FOCUS: HostFocusState = {
  open: false,
  tab: null,
  selectedServerId: null,
};

export function HostBuilderViewRedesigned({
  hostId,
  projectId,
}: HostBuilderViewRedesignedProps) {
  const navigate = useNavigate();
  const posthog = usePostHog();
  const { isAuthenticated } = useConvexAuth();
  const { host } = useHost({
    isAuthenticated,
    hostId,
  });
  const { servers } = useProjectServers({ projectId, isAuthenticated });
  const { updateHost } = useHostMutations();
  const { createServer } = useServerMutations();

  const [draftName, setDraftName] = useState("");
  const [draftConfig, setDraftConfig] = useState<HostConfigInputV2 | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showAddServer, setShowAddServer] = useState(false);
  const [focusState, setFocusState] = useState<HostFocusState>(CLOSED_FOCUS);
  // Diff snapshot — populated for ONE render after a host switch so the
  // canvas can mark changed leaves/fields. Cleared after the flash
  // duration so subsequent in-place edits don't keep re-firing the
  // animation. Captured from the outgoing draft *before* it's reseeded.
  const [prevHostSnapshot, setPrevHostSnapshot] = useState<{
    hostName: string;
    draft: HostConfigInputV2;
  } | null>(null);
  const lastSeededHostIdRef = useRef<string | null>(null);
  // Carry the previous host's snapshot id across the brief window where
  // `useHost(hostId)` re-fires and returns `undefined` — keeps the canvas
  // chip from blinking blank during in-place host swaps.
  const lastSnapshotIdRef = useRef<string>("");

  // Seed draft state from the loaded host. The `host` reference changes
  // whenever Convex re-emits the host doc — after a save, that's the signal
  // that aligns draft state with persistence so `isDirty` resets.
  //
  // `optionalServerIds` is retired under the "all project servers attach"
  // rule. Normalize to `[]` on both the draft and the saved comparison so
  // existing hosts (saved with a non-empty optional list under the old model)
  // don't surface a phantom unsaved diff.
  useEffect(() => {
    if (!host) return;
    if (
      lastSeededHostIdRef.current &&
      lastSeededHostIdRef.current !== hostId &&
      draftConfig
    ) {
      // Host switch — capture the OUTGOING draft as the diff baseline
      // before we overwrite it. Reset to null first so React schedules a
      // commit even when the same outgoing host reappears (back-and-forth
      // toggles between two hosts should still flash each time).
      setPrevHostSnapshot({ hostName: draftName, draft: draftConfig });
    }
    lastSeededHostIdRef.current = hostId;
    setDraftName(host.name);
    setDraftConfig({
      ...hostConfigDtoToInput(host.config),
      optionalServerIds: [],
    });
    // draftName / draftConfig intentionally excluded: keying the effect on
    // them would re-fire the diff capture on every keystroke and mark the
    // user's own edits as "diff from previous host," which is wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, hostId]);

  // Fire once per *loaded* host for builder-view adoption. Gating on `host`
  // (not just `hostId`) means a stale/deleted deep link to /clients/:hostId
  // — which HostsTab eventually reconciles by clearing the selection —
  // never logs a phantom view for a client the user didn't actually open.
  // The ref dedupes across Convex re-emits of the same host doc so we get
  // one capture per hostId, not one per subscription tick. Telemetry is
  // best-effort: a posthog throw must not trip the nearest error boundary.
  const capturedBuilderHostIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hostId || !host) return;
    if (capturedBuilderHostIdRef.current === hostId) return;
    capturedBuilderHostIdRef.current = hostId;
    try {
      posthog.capture("client_builder_viewed", {
        ...standardEventProps("client_builder"),
        client_id: hostId,
      });
    } catch {
      // swallow — analytics must not break the builder view
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, host]);

  // Clear the diff snapshot ~1.5s after a host switch so subsequent
  // in-place edits don't keep re-firing the morph animation. Matches the
  // CSS flash duration in RedesignedHostCanvas.
  useEffect(() => {
    if (!prevHostSnapshot) return;
    const t = window.setTimeout(() => setPrevHostSnapshot(null), 1500);
    return () => window.clearTimeout(t);
  }, [prevHostSnapshot]);

  const savedConfig = useMemo(
    () =>
      host
        ? { ...hostConfigDtoToInput(host.config), optionalServerIds: [] }
        : null,
    [host],
  );

  const isDirty = useMemo(() => {
    if (!host || !draftConfig || !savedConfig) return false;
    return (
      draftName !== host.name ||
      !hostConfigInputsEqual(draftConfig, savedConfig) ||
      !serverConnectionOverridesEqual(
        draftConfig.serverConnectionOverrides,
        savedConfig.serverConnectionOverrides,
      )
    );
  }, [host, draftName, draftConfig, savedConfig]);

  // Validation: recompute issues whenever draft or host display name changes.
  const attention = useHostDraftValidation(
    draftConfig ?? emptyHostConfigInputV2(),
    draftName,
  );

  // Runtime connection state lives in `appState.servers` keyed by server
  // name, not in the persisted Convex row. Mirror it into the host builder
  // so both the canvas card dot and the Servers-tab row dot reflect the
  // same state the Connect/Servers tab shows — without this they'd be
  // unconditionally emerald even when the server is disconnected.
  const sharedAppState = useSharedAppState();
  const connectionStatusByName = sharedAppState.servers;

  // Auto-connect this host's REQUIRED servers once per session. Optional
  // servers stay disconnected until the user manually flips them — we
  // don't connect anything the host's saved config doesn't claim to need.
  // Resolve saved `serverIds` (Convex ids) to runtime names via the
  // project servers list. Using the SAVED config (not the draft) means
  // unsaved checkbox toggles in the Servers tab don't trigger a fresh
  // batch; saving the host re-fires the dedupe key once and only once.
  const requiredServerNames = useMemo(() => {
    const requiredIds = host?.config?.serverIds ?? [];
    if (requiredIds.length === 0 || !servers) return [];
    const byId = new Map(servers.map((s) => [s._id, s.name] as const));
    return requiredIds
      .map((id) => byId.get(id))
      .filter((name): name is string => !!name);
  }, [host?.config?.serverIds, servers]);
  useAutoConnectProjectServers({
    projectId,
    hostScopeKey: hostId,
    requiredServerNames,
  });

  // `availableServers` (the focus-panel-shaped catalog) was retired
  // alongside the per-host Servers tab — server selection lives in
  // Project Settings → Servers now. The canvas still needs the
  // catalog for layout, so `availableServersForCanvas` stays.
  const availableServersForCanvas = useMemo(
    () =>
      (servers ?? []).map((s) => ({
        id: s._id,
        name: s.name,
        url: s.url ?? undefined,
        connectionStatus:
          connectionStatusByName[s.name]?.connectionStatus ?? "disconnected",
      })),
    [servers, connectionStatusByName],
  );

  const themeMode = usePreferencesStore((s) => s.themeMode);
  // Brand shell on the canvas subtree only (not the top tab chrome) so the
  // tab row matches the global Header background.
  const canvasShellStyle = useMemo(
    () =>
      draftConfig?.hostStyle
        ? getChatboxShellStyle(
            draftConfig.hostStyle,
            themeMode,
            draftConfig.chatUiOverride,
          )
        : undefined,
    [draftConfig?.hostStyle, draftConfig?.chatUiOverride, themeMode],
  );
  const liveSnapshotId = host?.config?.id ?? "";
  if (liveSnapshotId) lastSnapshotIdRef.current = liveSnapshotId;
  const savedSnapshotId = liveSnapshotId || lastSnapshotIdRef.current;

  const viewModel = useMemo(() => {
    const draft = draftConfig ?? emptyHostConfigInputV2();
    return buildRedesignedHostCanvas(
      {
        hostName: draftName,
        draft,
        savedSnapshotId,
        isDirty,
        projectServers: availableServersForCanvas,
        prev: prevHostSnapshot ?? undefined,
      },
      attention,
    );
  }, [
    draftName,
    draftConfig,
    savedSnapshotId,
    isDirty,
    availableServersForCanvas,
    attention,
    prevHostSnapshot,
  ]);

  const openFocus = useCallback(
    (
      tab: HostFocusTabId,
      selectedServerId: string | null = null,
      focusSubKey?: SandboxConfigSubKey,
    ) => {
      setFocusState({
        open: true,
        tab,
        selectedServerId,
        ...(focusSubKey ? { focusSubKey } : {}),
      });
    },
    [],
  );

  const closeFocus = useCallback(() => {
    setFocusState(CLOSED_FOCUS);
  }, []);

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      const target = focusTabForNodeId(nodeId);
      if (target)
        openFocus(target.tab, target.selectedServerId, target.focusSubKey);
    },
    [openFocus],
  );

  const handleSave = useCallback(async () => {
    if (!draftConfig) return;
    setIsSaving(true);
    try {
      const changedFields = savedConfig
        ? (Object.keys(draftConfig) as Array<keyof HostConfigInputV2>).filter(
            (key) =>
              JSON.stringify(draftConfig[key]) !==
              JSON.stringify(savedConfig[key]),
          )
        : [];
      const { hostConfigId } = await updateHost({
        hostId,
        name: draftName,
        input: draftConfig,
      });
      // The freshly persisted snapshot id arrives via the Convex
      // subscription on the next tick; don't include it in this toast
      // because `host?.config?.id` is still the *previous* snapshot here.
      toast.success("Snapshot saved");
      // Telemetry is best-effort: a posthog throw must not bubble into the
      // shared catch and surface "Failed to save host" after the snapshot
      // has already been persisted.
      try {
        posthog.capture("client_config_saved", {
          ...standardEventProps("client_builder"),
          client_id: hostId,
          client_config_id: hostConfigId,
          server_count: draftConfig.serverIds?.length ?? 0,
          changed_fields: changedFields,
        });
      } catch {
        // swallow — analytics must not block the success path
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save host",
      );
    } finally {
      setIsSaving(false);
    }
  }, [hostId, draftName, draftConfig, savedConfig, updateHost, posthog]);

  const handleAddServer = useCallback(
    async (formData: ServerFormData) => {
      try {
        const serverId = (await createServer({
          projectId,
          name: formData.name,
          enabled: true,
          transportType: formData.type === "stdio" ? "stdio" : "http",
          url: formData.url,
          headers: formData.headers,
          timeout: formData.requestTimeout,
          useOAuth: formData.useOAuth,
          oauthScopes: formData.oauthScopes,
          clientId: formData.clientId,
        })) as string;
        // Per the project-scoped server config rollout: the host draft
        // no longer owns serverIds — `projects.serverIds` does, and the
        // backend fan-out re-materializes every host's hostConfigId.
        // We intentionally do NOT append to draftConfig.serverIds here
        // (that's the bypass the audit flagged) and we do NOT open the
        // now-removed Servers focus tab. The new server lands in the
        // project catalog; if Auto-connect is ON on the Servers tab,
        // toggle OFF/ON to refresh and include the new server.
        setSelectedNodeId(`server-card:${serverId}`);
        toast.success(`Server "${formData.name}" added`);
      } catch (err) {
        toast.error(getBillingErrorMessage(err, "Failed to add server"));
      }
    },
    [createServer, projectId],
  );

  // Only show the skeleton on the very first mount when there's nothing
  // to paint. On host swaps `useHost(hostId)` briefly returns `undefined`,
  // but `draftConfig` still holds the previous host — keep rendering it so
  // the canvas morphs in place instead of flashing a loader, and the diff
  // animation has an old→new transition to play against.
  if (!draftConfig) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Block save on any blocking-level validation error. The user still sees
  // attention badges on the offending sub-nodes/tabs; without this gate the
  // Save button would happily submit (e.g. empty host name, blank model id,
  // non-positive timeout) and the write would only fail at the backend.
  const canSave = isDirty && !isSaving && !hasBlockingErrors(attention);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="relative shrink-0 border-b border-border/40 px-8 py-2.5">
        <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!canSave}
            variant={isDirty ? "default" : "ghost"}
            className={
              isDirty
                ? "shrink-0"
                : "shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-40"
            }
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {isDirty ? "Save host" : "Saved"}
          </Button>
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto">
            <ViewModeSelector
              value="host"
              ariaLabel="Connect view"
              onChange={(next) => {
                if (next === "servers") {
                  // Skip `onBack()` (which would push `/hosts` first via
                  // the parent's handleSelectHost) and just navigate.
                  // The URL→state sync in HostsRoute will clear the
                  // selected host when /servers takes over.
                  navigate("/servers");
                } else if (next === "compare") {
                  navigate("/host-compare");
                }
              }}
              options={[
                { value: "servers", label: "Servers" },
                { value: "host", label: "Host" },
                { value: "compare", label: "Compare" },
              ]}
            />
          </div>
        </div>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
        style={canvasShellStyle}
      >
      {/* Canvas + side focus panel (mirrors the ChatboxBuilderView layout:
          left = canvas, right = setup/focus rail). Resizable so the user
          can grow the editor without losing the canvas context. */}
      <div className="min-h-0 flex-1 p-4">
        {/*
          Remount when the right pane mounts/unmounts so react-resizable-panels
          recomputes layout. Otherwise defaultSize only applies on first mount
          and the focus panel can render at ~0 width after opening.
        */}
        <ResizablePanelGroup
          key={focusState.open ? "host-builder-split" : "host-builder-canvas"}
          direction="horizontal"
          className="h-full"
        >
          <ResizablePanel
            defaultSize={focusState.open ? 55 : 100}
            minSize={30}
          >
            <div className="h-full min-h-0 pr-2">
              <ReactFlowProvider>
                <RedesignedHostCanvas
                  viewModel={viewModel}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={handleSelectNode}
                  onClearSelection={() => setSelectedNodeId(null)}
                  onAddServer={() => setShowAddServer(true)}
                  shellStyle={canvasShellStyle}
                />
              </ReactFlowProvider>
            </div>
          </ResizablePanel>
          {focusState.open ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={45} minSize={35} maxSize={70}>
                <HostFocusPanel
                  hostId={hostId}
                  tab={focusState.tab}
                  onTabChange={(next) =>
                    setFocusState((prev) =>
                      prev.open ? { ...prev, tab: next } : prev,
                    )
                  }
                  focusSubKey={focusState.focusSubKey}
                  hostDisplayName={draftName}
                  onHostDisplayNameChange={setDraftName}
                  draft={draftConfig}
                  onDraftChange={(updater) =>
                    setDraftConfig((prev) => (prev ? updater(prev) : prev))
                  }
                  attention={attention}
                  onClose={closeFocus}
                />
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>

      {showAddServer && (
        <AddServerModal
          isOpen={showAddServer}
          onClose={() => setShowAddServer(false)}
          onSubmit={handleAddServer}
        />
      )}
      </div>
    </div>
  );
}
