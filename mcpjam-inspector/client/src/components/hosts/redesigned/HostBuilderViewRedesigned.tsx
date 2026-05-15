import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { ReactFlowProvider } from "@xyflow/react";
import { Button } from "@mcpjam/design-system/button";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import { useHost, useHostList, useHostMutations } from "@/hooks/useHosts";
import { useProjectServers, useServerMutations } from "@/hooks/useProjects";
import { AddServerModal } from "@/components/connection/AddServerModal";
import type { ServerFormData } from "@/shared/types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  serverConnectionOverridesEqual,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import { getChatboxShellStyle } from "@/lib/chatbox-host-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { RedesignedHostCanvas } from "./canvas/RedesignedHostCanvas";
import { buildRedesignedHostCanvas } from "./canvas/canvasBuilder";
import { HostFocusPanel } from "./focus/HostFocusPanel";
import { useHostDraftValidation } from "./focus/useHostDraftValidation";
import {
  focusTabForNodeId,
  shortenSnapshotId,
  type HostFocusState,
  type HostFocusTabId,
} from "./types";

/** Matches the default host name seeded in `HostOverlayBar`. */
const DEFAULT_PROJECT_HOST_NAME = "MCPJam";

interface HostBuilderViewRedesignedProps {
  hostId: string;
  projectId: string;
  onBack: () => void;
  onSwitchHost?: (hostId: string) => void;
}

const CLOSED_FOCUS: HostFocusState = {
  open: false,
  tab: null,
  selectedServerId: null,
};

export function HostBuilderViewRedesigned({
  hostId,
  projectId,
  onBack,
  onSwitchHost,
}: HostBuilderViewRedesignedProps) {
  const { isAuthenticated } = useConvexAuth();
  const { host, isLoading: hostLoading } = useHost({
    isAuthenticated,
    hostId,
  });
  const { hosts: projectHosts, isLoading: hostListLoading } = useHostList({
    isAuthenticated,
    projectId,
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
  const [hostSwitchDialogOpen, setHostSwitchDialogOpen] = useState(false);
  const pendingSwitchHostRef = useRef<string | null>(null);

  // Seed draft state from the loaded host. The `host` reference changes
  // whenever Convex re-emits the host doc — after a save, that's the signal
  // that aligns draft state with persistence so `isDirty` resets.
  useEffect(() => {
    if (!host) return;
    setDraftName(host.name);
    setDraftConfig(hostConfigDtoToInput(host.config));
  }, [host]);

  const savedConfig = useMemo(
    () => (host ? hostConfigDtoToInput(host.config) : null),
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

  const availableServers = useMemo(
    () =>
      servers?.map((s) => ({
        id: s._id,
        name: s.name,
        url: s.url ?? null,
      })) ?? [],
    [servers],
  );

  const sortedProjectHosts = useMemo(() => {
    return [...projectHosts].sort((a, b) => {
      if (a.name === DEFAULT_PROJECT_HOST_NAME) return -1;
      if (b.name === DEFAULT_PROJECT_HOST_NAME) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [projectHosts]);

  const showHostSwitcher =
    Boolean(onSwitchHost) && sortedProjectHosts.length > 1;

  const availableServersForCanvas = useMemo(
    () =>
      (servers ?? []).map((s) => ({
        id: s._id,
        name: s.name,
        url: s.url ?? undefined,
      })),
    [servers],
  );

  const themeMode = usePreferencesStore((s) => s.themeMode);
  // Full brand shell — sets `--background`, `--foreground`, `--card`,
  // `--border`, etc. for the canvas subtree so sub-cards repaint to the
  // host's brand instead of the app theme.
  const canvasShellStyle = useMemo(
    () =>
      draftConfig?.hostStyle
        ? getChatboxShellStyle(draftConfig.hostStyle, themeMode)
        : undefined,
    [draftConfig?.hostStyle, themeMode],
  );

  const viewModel = useMemo(() => {
    const draft = draftConfig ?? emptyHostConfigInputV2();
    return buildRedesignedHostCanvas(
      {
        hostName: draftName,
        draft,
        savedSnapshotId: host?.config?.id ?? "",
        isDirty,
        projectServers: availableServersForCanvas,
      },
      attention,
    );
  }, [
    draftName,
    draftConfig,
    host?.config?.id,
    isDirty,
    availableServersForCanvas,
    attention,
  ]);

  const openFocus = useCallback(
    (tab: HostFocusTabId, selectedServerId: string | null = null) => {
      setFocusState({ open: true, tab, selectedServerId });
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
      if (target) openFocus(target.tab, target.selectedServerId);
    },
    [openFocus],
  );

  const handleSave = useCallback(async () => {
    if (!draftConfig) return;
    setIsSaving(true);
    try {
      await updateHost({
        hostId,
        name: draftName,
        input: draftConfig,
      });
      toast.success(
        `Snapshot saved · ${shortenSnapshotId(host?.config?.id ?? "")}`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save host",
      );
    } finally {
      setIsSaving(false);
    }
  }, [hostId, draftName, draftConfig, host?.config?.id, updateHost]);

  const requestSwitchToHost = useCallback(
    (nextHostId: string) => {
      if (!onSwitchHost || nextHostId === hostId) return;
      if (isDirty) {
        pendingSwitchHostRef.current = nextHostId;
        setHostSwitchDialogOpen(true);
        return;
      }
      onSwitchHost(nextHostId);
    },
    [hostId, isDirty, onSwitchHost],
  );

  const confirmPendingSwitchHost = useCallback(() => {
    const next = pendingSwitchHostRef.current;
    pendingSwitchHostRef.current = null;
    setHostSwitchDialogOpen(false);
    if (next && onSwitchHost) {
      onSwitchHost(next);
    }
  }, [onSwitchHost]);

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
        setDraftConfig((prev) =>
          prev
            ? {
                ...prev,
                serverIds: [...(prev.serverIds ?? []), serverId],
              }
            : prev,
        );
        setSelectedNodeId(`server-card:${serverId}`);
        openFocus("servers", serverId);
        toast.success(`Server "${formData.name}" added`);
      } catch (err) {
        toast.error(getBillingErrorMessage(err, "Failed to add server"));
      }
    },
    [createServer, projectId, openFocus],
  );

  if (hostLoading || !draftConfig) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const canSave = isDirty && !isSaving;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Chrome */}
      <div className="shrink-0 border-b border-border/40 px-8 py-2.5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onBack}
            aria-label="Return to hosts"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          {showHostSwitcher ? (
            <div className="min-w-[10rem] max-w-[14rem] shrink-0">
              <Select
                value={hostId}
                onValueChange={requestSwitchToHost}
                disabled={hostListLoading || sortedProjectHosts.length === 0}
              >
                <SelectTrigger
                  aria-label="Switch host"
                  size="sm"
                  data-testid="host-builder-host-select"
                  className={cn(
                    "h-8 w-full justify-between gap-2 border-0 bg-transparent px-2.5 shadow-none",
                    "text-sm font-medium text-foreground",
                    "hover:bg-muted/60 data-[state=open]:bg-muted/60",
                    "focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring/45",
                    "[&_svg:not([class*='text-'])]:opacity-55",
                  )}
                >
                  <SelectValue
                    placeholder={hostListLoading ? "Loading..." : "Select host"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {sortedProjectHosts.map((h) => (
                    <SelectItem key={h.hostId} value={h.hostId}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!canSave}
            variant={isDirty ? "default" : "ghost"}
            className={
              isDirty
                ? "ml-auto shrink-0"
                : "ml-auto shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-40"
            }
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {isDirty ? "Save snapshot" : "Saved"}
          </Button>
        </div>
      </div>

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
                  tab={focusState.tab}
                  onTabChange={(next) =>
                    setFocusState((prev) =>
                      prev.open ? { ...prev, tab: next } : prev,
                    )
                  }
                  initialSelectedServerId={focusState.selectedServerId}
                  hostDisplayName={draftName}
                  onHostDisplayNameChange={setDraftName}
                  draft={draftConfig}
                  onDraftChange={(updater) =>
                    setDraftConfig((prev) => (prev ? updater(prev) : prev))
                  }
                  attention={attention}
                  availableServers={availableServers}
                  onAddServer={() => setShowAddServer(true)}
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

      <AlertDialog
        open={hostSwitchDialogOpen}
        onOpenChange={(open) => {
          setHostSwitchDialogOpen(open);
          if (!open) {
            window.setTimeout(() => {
              pendingSwitchHostRef.current = null;
            }, 0);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have edits that are not saved. Switching hosts will discard
              them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmPendingSwitchHost();
              }}
            >
              Switch host
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
