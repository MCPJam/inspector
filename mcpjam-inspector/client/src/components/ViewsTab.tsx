import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { Layers } from "lucide-react";
import { toast } from "sonner";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  useViewQueries,
  useViewMutations,
  useWorkspaceServers,
  type AnyView,
} from "@/hooks/useViews";
import { useSharedAppState } from "@/state/app-state-context";
import { ViewsListSidebar } from "./views/ViewsListSidebar";
import { ViewEditorPanel } from "./views/ViewEditorPanel";
import { executeToolApi } from "@/lib/apis/mcp-tools-api";
import {
  useCurrentDisplayContext,
  areDisplayContextsEqual,
} from "@/lib/display-context-utils";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { PlaygroundMain } from "./ui-playground/PlaygroundMain";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";

interface ViewsTabProps {
  selectedServer?: string;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
}

interface EditSignatures {
  toolInput: string;
  toolOutput: string;
  widgetState: string;
}

function safeSerializeForCompare(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return `__nonserializable__:${Object.prototype.toString.call(value)}`;
  }
}

export function ViewsTab({
  selectedServer,
  onWorkspaceShared,
  onLeaveWorkspace,
}: ViewsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const posthog = usePostHog();
  const appState = useSharedAppState();

  // Get the Convex workspace ID from the active workspace
  const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
  const workspaceId = activeWorkspace?.sharedWorkspaceId ?? null;

  // View state
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [deletingViewId, setDeletingViewId] = useState<string | null>(null);
  const [duplicatingViewId, setDuplicatingViewId] = useState<string | null>(
    null,
  );

  // Live editing state for toolInput/toolOutput
  const [liveToolInput, setLiveToolInput] = useState<unknown>(null);
  const [liveToolOutput, setLiveToolOutput] = useState<unknown>(null);
  const [liveWidgetState, setLiveWidgetState] = useState<unknown>(null);
  const [originalToolOutput, setOriginalToolOutput] = useState<unknown>(null);
  const [toolOutputError, setToolOutputError] = useState<string | null>(null);
  const [isLoadingToolOutput, setIsLoadingToolOutput] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [pendingExecution, setPendingExecution] = useState<{
    toolName: string;
    params: Record<string, unknown>;
    result: unknown;
    toolMeta: Record<string, unknown> | undefined;
    state?: "output-available" | "output-error";
    errorText?: string;
    renderOverride?: ToolRenderOverride;
    toolCallId?: string;
    replaceExisting?: boolean;
  } | null>(null);
  const [toolRenderOverrides, setToolRenderOverrides] = useState<
    Record<string, ToolRenderOverride>
  >({});
  const [liveToolOutputVersion, setLiveToolOutputVersion] = useState(0);
  const [baselineSignatures, setBaselineSignatures] = useState<EditSignatures>({
    toolInput: safeSerializeForCompare(null),
    toolOutput: safeSerializeForCompare(null),
    widgetState: safeSerializeForCompare(null),
  });
  const [currentSignatures, setCurrentSignatures] = useState<EditSignatures>({
    toolInput: safeSerializeForCompare(null),
    toolOutput: safeSerializeForCompare(null),
    widgetState: safeSerializeForCompare(null),
  });

  // Get current display context from UI Playground store
  const currentDisplayContext = useCurrentDisplayContext();

  // Get widgets map from debug store for saving (keyed by preview tool call ID)
  const widgetsMap = useWidgetDebugStore((s) => s.widgets);

  // Track the view ID we loaded output for to avoid stale data
  const loadedToolOutputForViewId = useRef<string | null>(null);
  const lastInjectedViewSignature = useRef<string | null>(null);
  const lastUploadedWidgetHtmlRef = useRef<string | null>(null);

  const setSelectedProtocol = useUIPlaygroundStore(
    (s) => s.setSelectedProtocol,
  );
  const setDeviceType = useUIPlaygroundStore((s) => s.setDeviceType);
  const setCustomViewport = useUIPlaygroundStore((s) => s.setCustomViewport);
  const updateGlobal = useUIPlaygroundStore((s) => s.updateGlobal);
  const setCapabilities = useUIPlaygroundStore((s) => s.setCapabilities);
  const setSafeAreaInsets = useUIPlaygroundStore((s) => s.setSafeAreaInsets);

  const buildSignatures = useCallback(
    (
      toolInput: unknown,
      toolOutput: unknown,
      widgetState: unknown,
      protocol: AnyView["protocol"] | undefined,
    ): EditSignatures => ({
      toolInput: safeSerializeForCompare(toolInput),
      toolOutput: safeSerializeForCompare(toolOutput),
      widgetState:
        protocol === "openai-apps"
          ? safeSerializeForCompare(widgetState ?? null)
          : safeSerializeForCompare(null),
    }),
    [],
  );

  const setLiveToolOutputAndBumpVersion = useCallback((value: unknown) => {
    setLiveToolOutput(value);
    setLiveToolOutputVersion((v) => v + 1);
  }, []);

  // Fetch views
  const { sortedViews, isLoading: isViewsLoading } = useViewQueries({
    isAuthenticated,
    workspaceId,
  });

  // Fetch workspace servers to resolve server IDs to names
  const { serversById, serversByName } = useWorkspaceServers({
    isAuthenticated,
    workspaceId,
  });

  // Get the server ID from the selected server name
  const selectedServerId = selectedServer
    ? serversByName.get(selectedServer)
    : undefined;

  // Filter views by selected server (via header tabs)
  const filteredViews = useMemo(() => {
    if (!selectedServerId) return [];
    return sortedViews.filter((view) => view.serverId === selectedServerId);
  }, [sortedViews, selectedServerId]);

  // Check if filtered list has views
  const hasFilteredViews = filteredViews.length > 0;

  // Clear selection when selected server changes and selected view doesn't belong to filtered set
  useEffect(() => {
    if (selectedViewId && selectedServerId) {
      const viewStillExists = filteredViews.some(
        (v) => v._id === selectedViewId,
      );
      if (!viewStillExists) {
        setSelectedViewId(null);
        setIsEditing(false);
        // Reset live editing state
        setLiveToolInput(null);
        setLiveToolOutput(null);
        setLiveWidgetState(null);
        setOriginalToolOutput(null);
        setToolOutputError(null);
        setIsLoadingToolOutput(false);
        loadedToolOutputForViewId.current = null;
      }
    }
  }, [selectedServerId, selectedViewId, filteredViews]);

  // Get connection status for a specific server - use appState.servers which has runtime state
  const getServerConnectionStatus = useCallback(
    (serverName: string | undefined) => {
      if (!serverName) return undefined;
      return appState.servers[serverName]?.connectionStatus;
    },
    [appState.servers],
  );

  // Mutations
  const {
    createMcpView,
    createOpenaiView,
    updateMcpView,
    updateOpenaiView,
    removeMcpView,
    removeOpenaiView,
    generateMcpUploadUrl,
    generateOpenaiUploadUrl,
  } = useViewMutations();

  // Get selected view (from filtered list)
  const selectedView = useMemo(() => {
    if (!selectedViewId) return null;
    return filteredViews.find((v) => v._id === selectedViewId) ?? null;
  }, [selectedViewId, filteredViews]);

  useEffect(() => {
    setPendingExecution(null);
    setToolRenderOverrides({});
    lastInjectedViewSignature.current = null;
    lastUploadedWidgetHtmlRef.current = null;
  }, [selectedView?._id]);

  // Keep playground protocol and display context aligned to selected view
  useEffect(() => {
    if (!selectedView) return;
    setSelectedProtocol(
      selectedView.protocol === "mcp-apps"
        ? UIType.MCP_APPS
        : UIType.OPENAI_SDK,
    );
    if (!selectedView.defaultContext) return;
    const ctx = selectedView.defaultContext;
    if (ctx.deviceType) setDeviceType(ctx.deviceType);
    if (ctx.viewport) setCustomViewport(ctx.viewport);
    if (ctx.locale) updateGlobal("locale", ctx.locale);
    if (ctx.timeZone) updateGlobal("timeZone", ctx.timeZone);
    if (ctx.capabilities) setCapabilities(ctx.capabilities);
    if (ctx.safeAreaInsets) setSafeAreaInsets(ctx.safeAreaInsets);
  }, [
    selectedView,
    setSelectedProtocol,
    setDeviceType,
    setCustomViewport,
    updateGlobal,
    setCapabilities,
    setSafeAreaInsets,
  ]);

  // Load toolOutput from blob when view is selected
  useEffect(() => {
    if (!selectedView) {
      // Reset live state when no view selected
      setLiveToolInput(null);
      setLiveToolOutputAndBumpVersion(null);
      setLiveWidgetState(null);
      setOriginalToolOutput(null);
      setToolOutputError(null);
      setIsLoadingToolOutput(false);
      loadedToolOutputForViewId.current = null;
      const resetSigs = buildSignatures(null, null, null, undefined);
      setBaselineSignatures(resetSigs);
      setCurrentSignatures(resetSigs);
      return;
    }

    // Skip if we already loaded for this view
    if (loadedToolOutputForViewId.current === selectedView._id) {
      return;
    }

    const viewId = selectedView._id;
    const controller = new AbortController();
    let isActive = true;

    // SYNCHRONOUSLY reset live state BEFORE async load to prevent stale data from old view
    // This ensures the UI immediately reflects the new view's data (or loading state)
    setLiveToolInput(selectedView.toolInput);
    setLiveToolOutputAndBumpVersion(null);
    setLiveWidgetState(
      selectedView.protocol === "openai-apps"
        ? (selectedView.widgetState ?? null)
        : null,
    );
    setOriginalToolOutput(null);
    setToolOutputError(null);
    // Set loading state immediately if there's a URL to fetch
    const hasOutputToLoad = !!selectedView.toolOutputUrl;
    setIsLoadingToolOutput(hasOutputToLoad);
    const initialSigs = buildSignatures(
      selectedView.toolInput,
      null,
      selectedView.protocol === "openai-apps"
        ? (selectedView.widgetState ?? null)
        : null,
      selectedView.protocol,
    );
    setBaselineSignatures(initialSigs);
    setCurrentSignatures(initialSigs);

    async function loadToolOutput() {
      if (!selectedView?.toolOutputUrl) {
        // No blob to load - toolInput already set above
        loadedToolOutputForViewId.current = viewId;
        return;
      }
      try {
        const response = await fetch(selectedView.toolOutputUrl, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch output: ${response.status}`);
        }
        const data = await response.json();
        if (!isActive) return;
        setLiveToolOutputAndBumpVersion(data);
        setOriginalToolOutput(data);
        const loadedSigs = buildSignatures(
          selectedView.toolInput,
          data,
          selectedView.protocol === "openai-apps"
            ? (selectedView.widgetState ?? null)
            : null,
          selectedView.protocol,
        );
        setBaselineSignatures(loadedSigs);
        setCurrentSignatures(loadedSigs);
        loadedToolOutputForViewId.current = viewId;
      } catch (err) {
        if (!isActive) return;
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        console.error("Failed to load toolOutput:", err);
        // Keep liveToolOutput as null on error
        setToolOutputError(
          err instanceof Error ? err.message : "Failed to load output",
        );
        loadedToolOutputForViewId.current = viewId;
      } finally {
        if (isActive) {
          setIsLoadingToolOutput(false);
        }
      }
    }

    loadToolOutput();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [selectedView, buildSignatures, setLiveToolOutputAndBumpVersion]);

  // Seed PlaygroundMain with the selected view's saved execution so the right pane
  // uses the exact same chat+renderer surface as App Builder.
  useEffect(() => {
    if (!selectedView || isLoadingToolOutput || !!toolOutputError) return;
    const isErrorView = selectedView.toolState === "output-error";
    if (
      !isErrorView &&
      (liveToolOutput === null || liveToolOutput === undefined)
    )
      return;

    const serverNameForView = serversById.get(selectedView.serverId);
    if (!serverNameForView) return;

    const signature = isErrorView
      ? `${selectedView._id}:error:${selectedView.toolErrorText ?? ""}`
      : `${selectedView._id}:output-v${liveToolOutputVersion}`;
    if (lastInjectedViewSignature.current === signature) return;
    lastInjectedViewSignature.current = signature;

    setPendingExecution({
      toolName: selectedView.toolName,
      params: (liveToolInput ?? selectedView.toolInput ?? {}) as Record<
        string,
        unknown
      >,
      result: liveToolOutput,
      toolMeta:
        (selectedView.toolMetadata as Record<string, unknown> | undefined) ??
        undefined,
      state:
        selectedView.toolState === "output-error"
          ? "output-error"
          : "output-available",
      errorText: selectedView.toolErrorText,
      renderOverride: {
        serverId: serverNameForView || selectedView.serverId,
        isOffline: getServerConnectionStatus(serverNameForView) !== "connected",
        cachedWidgetHtmlUrl: selectedView.widgetHtmlUrl ?? undefined,
        initialWidgetState:
          selectedView.protocol === "openai-apps"
            ? (liveWidgetState ?? selectedView.widgetState)
            : undefined,
        resourceUri:
          selectedView.protocol === "mcp-apps"
            ? selectedView.resourceUri
            : undefined,
        toolMetadata:
          (selectedView.toolMetadata as Record<string, unknown> | undefined) ??
          undefined,
      },
      toolCallId: `view-preview-${selectedView._id}`,
      replaceExisting: true,
    });
  }, [
    selectedView,
    isLoadingToolOutput,
    toolOutputError,
    liveToolOutput,
    liveToolInput,
    liveWidgetState,
    liveToolOutputVersion,
    serversById,
    getServerConnectionStatus,
  ]);

  // Track views tab viewed
  useEffect(() => {
    posthog.capture("views_tab_viewed", {
      location: "views_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, [posthog]);

  // Handle view selection
  const handleSelectView = useCallback(
    (viewId: string) => {
      setSelectedViewId(viewId);
      // Reset loaded flag to trigger reload
      loadedToolOutputForViewId.current = null;

      posthog.capture("view_selected", {
        location: "views_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    },
    [posthog],
  );

  // Handle delete
  const handleDeleteView = useCallback(
    async (view: AnyView) => {
      setDeletingViewId(view._id);
      try {
        if (view.protocol === "mcp-apps") {
          await removeMcpView({ viewId: view._id });
        } else {
          await removeOpenaiView({ viewId: view._id });
        }

        toast.success(`View "${view.name}" deleted`);

        posthog.capture("view_deleted", {
          location: "views_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
        });

        // Clear selection if deleted view was selected
        if (selectedViewId === view._id) {
          setSelectedViewId(null);
        }
      } catch (error) {
        console.error("Failed to delete view:", error);
        toast.error("Failed to delete view");
      } finally {
        setDeletingViewId(null);
      }
    },
    [selectedViewId, removeMcpView, removeOpenaiView, posthog],
  );

  // Handle edit
  const handleEditView = useCallback(
    (view: AnyView) => {
      setSelectedViewId(view._id);
      setIsEditing(true);
      // Reset loaded flag to trigger reload
      loadedToolOutputForViewId.current = null;

      posthog.capture("view_edit_started", {
        location: "views_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    },
    [posthog],
  );

  // Handle rename
  const handleRenameView = useCallback(
    async (view: AnyView, newName: string) => {
      try {
        const updates = {
          viewId: view._id,
          name: newName,
        };

        if (view.protocol === "mcp-apps") {
          await updateMcpView(updates);
        } else {
          await updateOpenaiView(updates);
        }

        toast.success(`View renamed to "${newName}"`);

        posthog.capture("view_renamed", {
          location: "views_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
        });
      } catch (error) {
        console.error("Failed to rename view:", error);
        toast.error("Failed to rename view");
        throw error; // Re-throw so the sidebar knows to keep editing mode
      }
    },
    [updateMcpView, updateOpenaiView, posthog],
  );

  // Handle duplicate
  const handleDuplicateView = useCallback(
    async (view: AnyView) => {
      if (!workspaceId) return;

      setDuplicatingViewId(view._id);
      try {
        // Fetch the toolOutput blob if it exists
        let toolOutputBlobId: string | undefined;
        if (view.toolOutputUrl) {
          // Fetch the original toolOutput
          const response = await fetch(view.toolOutputUrl);
          if (response.ok) {
            const data = await response.json();
            // Upload as a new blob
            const uploadUrl =
              view.protocol === "mcp-apps"
                ? await generateMcpUploadUrl()
                : await generateOpenaiUploadUrl();

            const uploadResponse = await fetch(uploadUrl, {
              method: "POST",
              body: JSON.stringify(data),
              headers: { "Content-Type": "application/json" },
            });

            if (uploadResponse.ok) {
              const { storageId } = await uploadResponse.json();
              toolOutputBlobId = storageId;
            }
          }
        }

        // Copy widget HTML blob if it exists
        let widgetHtmlBlobId: string | undefined;
        if (view.widgetHtmlUrl) {
          const response = await fetch(view.widgetHtmlUrl);
          if (response.ok) {
            const htmlContent = await response.text();
            const uploadUrl =
              view.protocol === "mcp-apps"
                ? await generateMcpUploadUrl()
                : await generateOpenaiUploadUrl();

            const uploadResponse = await fetch(uploadUrl, {
              method: "POST",
              body: htmlContent,
              headers: { "Content-Type": "text/html" },
            });

            if (uploadResponse.ok) {
              const { storageId } = await uploadResponse.json();
              widgetHtmlBlobId = storageId;
            }
          }
        }

        // Create the duplicate view
        const baseName = view.name.replace(/ \(copy( \d+)?\)$/, "");
        const existingCopies = filteredViews.filter(
          (v) =>
            v.name.startsWith(baseName) && v.name.match(/ \(copy( \d+)?\)$/),
        );
        const copyNumber = existingCopies.length + 1;
        const newName =
          copyNumber === 1
            ? `${baseName} (copy)`
            : `${baseName} (copy ${copyNumber})`;

        if (view.protocol === "mcp-apps") {
          await createMcpView({
            workspaceId,
            serverId: view.serverId,
            name: newName,
            description: view.description,
            resourceUri: (view as any).resourceUri,
            toolName: view.toolName,
            toolState: view.toolState,
            toolInput: view.toolInput,
            toolOutputBlobId,
            widgetHtmlBlobId,
            toolErrorText: view.toolErrorText,
            toolMetadata: view.toolMetadata,
            prefersBorder: view.prefersBorder,
            tags: view.tags,
            category: view.category,
            defaultContext: view.defaultContext,
          });
        } else {
          await createOpenaiView({
            workspaceId,
            serverId: view.serverId,
            name: newName,
            description: view.description,
            outputTemplate: (view as any).outputTemplate,
            toolName: view.toolName,
            toolState: view.toolState,
            toolInput: view.toolInput,
            toolOutputBlobId,
            widgetHtmlBlobId,
            toolErrorText: view.toolErrorText,
            toolMetadata: view.toolMetadata,
            prefersBorder: view.prefersBorder,
            tags: view.tags,
            category: view.category,
            defaultContext: view.defaultContext,
            serverInfo: (view as any).serverInfo,
            widgetState: view.widgetState,
          });
        }

        toast.success(`View duplicated as "${newName}"`);

        posthog.capture("view_duplicated", {
          location: "views_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
        });
      } catch (error) {
        console.error("Failed to duplicate view:", error);
        toast.error("Failed to duplicate view");
      } finally {
        setDuplicatingViewId(null);
      }
    },
    [
      workspaceId,
      filteredViews,
      createMcpView,
      createOpenaiView,
      generateMcpUploadUrl,
      generateOpenaiUploadUrl,
      posthog,
    ],
  );

  // Handle live data changes from editor (for real-time preview)
  const handleEditorDataChange = useCallback(
    (data: {
      toolInput: unknown;
      toolOutput: unknown;
      widgetState?: unknown;
    }) => {
      setLiveToolInput(data.toolInput);
      setLiveToolOutputAndBumpVersion(data.toolOutput);
      if ("widgetState" in data) {
        setLiveWidgetState(data.widgetState);
      }
      setCurrentSignatures((prev) => ({
        ...prev,
        toolInput: safeSerializeForCompare(data.toolInput),
        toolOutput: safeSerializeForCompare(data.toolOutput),
        widgetState:
          selectedView?.protocol === "openai-apps"
            ? safeSerializeForCompare(data.widgetState ?? null)
            : prev.widgetState,
      }));
    },
    [selectedView?.protocol, setLiveToolOutputAndBumpVersion],
  );

  // Check if there are unsaved changes in the live editor
  const hasLiveUnsavedChanges = useMemo(() => {
    if (!selectedView) return false;

    const toolInputChanged =
      currentSignatures.toolInput !== baselineSignatures.toolInput;
    const toolOutputChanged =
      currentSignatures.toolOutput !== baselineSignatures.toolOutput;
    const contextChanged = !areDisplayContextsEqual(
      currentDisplayContext,
      selectedView.defaultContext,
    );
    const widgetStateChanged =
      selectedView.protocol === "openai-apps" &&
      currentSignatures.widgetState !== baselineSignatures.widgetState;

    return (
      toolInputChanged ||
      toolOutputChanged ||
      contextChanged ||
      widgetStateChanged
    );
  }, [
    selectedView,
    currentSignatures,
    baselineSignatures,
    currentDisplayContext,
  ]);

  // Handle save from editor (with blob upload if toolOutput changed)
  const handleEditorSave = useCallback(async () => {
    if (!selectedView || !hasLiveUnsavedChanges) return;

    setIsSaving(true);
    try {
      const toolInputChanged =
        currentSignatures.toolInput !== baselineSignatures.toolInput;
      const toolOutputChanged =
        currentSignatures.toolOutput !== baselineSignatures.toolOutput;
      const contextChanged = !areDisplayContextsEqual(
        currentDisplayContext,
        selectedView.defaultContext,
      );
      const widgetStateChanged =
        selectedView.protocol === "openai-apps" &&
        currentSignatures.widgetState !== baselineSignatures.widgetState;

      let toolOutputBlobId: string | undefined;
      let widgetHtmlBlobId: string | undefined;

      if (toolOutputChanged && liveToolOutput !== null) {
        // Upload new toolOutput as JSON blob
        const uploadUrl =
          selectedView.protocol === "mcp-apps"
            ? await generateMcpUploadUrl()
            : await generateOpenaiUploadUrl();

        const response = await fetch(uploadUrl, {
          method: "POST",
          body: JSON.stringify(liveToolOutput),
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Failed to upload toolOutput: ${response.status}`);
        }

        const { storageId } = await response.json();
        toolOutputBlobId = storageId;
      }

      // Get the current widget HTML from the debug store (captured by the renderer)
      const previewToolCallId = `view-preview-${selectedView._id}`;
      const previewWidgetDebugInfo = widgetsMap.get(previewToolCallId);
      const widgetHtml = previewWidgetDebugInfo?.widgetHtml;
      if (widgetHtml && widgetHtml !== lastUploadedWidgetHtmlRef.current) {
        // Upload new widget HTML blob
        const uploadUrl =
          selectedView.protocol === "mcp-apps"
            ? await generateMcpUploadUrl()
            : await generateOpenaiUploadUrl();

        const response = await fetch(uploadUrl, {
          method: "POST",
          body: widgetHtml,
          headers: { "Content-Type": "text/html" },
        });

        if (!response.ok) {
          throw new Error(`Failed to upload widget HTML: ${response.status}`);
        }

        const { storageId } = await response.json();
        widgetHtmlBlobId = storageId;
        lastUploadedWidgetHtmlRef.current = widgetHtml;
      }

      // Update view with toolInput and optionally new toolOutputBlobId/widgetHtmlBlobId
      const updates: Record<string, unknown> = {
        viewId: selectedView._id,
        ...(toolInputChanged ? { toolInput: liveToolInput } : {}),
      };

      if (toolOutputBlobId) {
        updates.toolOutputBlobId = toolOutputBlobId;
      }

      if (widgetHtmlBlobId) {
        updates.widgetHtmlBlobId = widgetHtmlBlobId;
      }

      if (contextChanged) {
        updates.defaultContext = currentDisplayContext;
      }

      if (selectedView.protocol === "openai-apps") {
        if (widgetStateChanged) {
          updates.widgetState = liveWidgetState ?? null;
        } else if (previewWidgetDebugInfo !== undefined) {
          updates.widgetState = previewWidgetDebugInfo.widgetState;
        }
      }

      if (selectedView.protocol === "mcp-apps") {
        await updateMcpView(updates);
      } else {
        await updateOpenaiView(updates);
      }

      // Update original values to reflect saved state
      setOriginalToolOutput(liveToolOutput);
      setBaselineSignatures(currentSignatures);

      toast.success("View saved successfully");

      posthog.capture("view_saved", {
        location: "views_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      console.error("Failed to save view:", error);
      toast.error("Failed to save view");
    } finally {
      setIsSaving(false);
    }
  }, [
    selectedView,
    hasLiveUnsavedChanges,
    liveToolInput,
    liveToolOutput,
    liveWidgetState,
    currentSignatures,
    baselineSignatures,
    currentDisplayContext,
    generateMcpUploadUrl,
    generateOpenaiUploadUrl,
    updateMcpView,
    updateOpenaiView,
    widgetsMap,
    posthog,
  ]);

  // Handle running the tool with current input
  const handleRun = useCallback(async () => {
    if (!selectedView || liveToolInput === null || !selectedServer) return;

    const status = getServerConnectionStatus(selectedServer);
    if (status !== "connected") {
      toast.error("Server is not connected");
      return;
    }

    setIsRunning(true);

    try {
      const params = (liveToolInput ?? {}) as Record<string, unknown>;
      const response = await executeToolApi(
        selectedServer,
        selectedView.toolName,
        params,
      );

      if ("error" in response) {
        toast.error(`Execution failed: ${response.error}`);
        return;
      }

      if (response.status === "elicitation_required") {
        toast.error("Tool requires elicitation (not supported in Views)");
        return;
      }

      if (response.status === "task_created") {
        toast.error("Background tasks not supported in Views");
        return;
      }

      // Success - update liveToolOutput with new result
      setLiveToolOutputAndBumpVersion(response.result);
      setCurrentSignatures((prev) => ({
        ...prev,
        toolOutput: safeSerializeForCompare(response.result),
      }));
      toast.success("Tool executed successfully");

      posthog.capture("view_tool_executed", {
        location: "views_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Execution failed";
      toast.error(msg);
    } finally {
      setIsRunning(false);
    }
  }, [
    selectedView,
    liveToolInput,
    selectedServer,
    getServerConnectionStatus,
    posthog,
    setLiveToolOutputAndBumpVersion,
  ]);

  const handleExecutionInjected = useCallback(
    (toolCallId?: string) => {
      if (toolCallId && pendingExecution?.renderOverride) {
        setToolRenderOverrides((prev) => ({
          ...prev,
          [toolCallId]: pendingExecution.renderOverride!,
        }));
      }
      setPendingExecution(null);
    },
    [pendingExecution],
  );

  // Handler to go back to views list
  const handleBackToList = useCallback(() => {
    setSelectedViewId(null);
    setIsEditing(false);
    // Reset live editing state
    setLiveToolInput(null);
    setLiveToolOutputAndBumpVersion(null);
    setLiveWidgetState(null);
    setOriginalToolOutput(null);
    loadedToolOutputForViewId.current = null;
    lastInjectedViewSignature.current = null;
    lastUploadedWidgetHtmlRef.current = null;
    setPendingExecution(null);
    setToolRenderOverrides({});
    const resetSigs = buildSignatures(null, null, null, undefined);
    setBaselineSignatures(resetSigs);
    setCurrentSignatures(resetSigs);
  }, [buildSignatures, setLiveToolOutputAndBumpVersion]);

  // Loading state
  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  // Not authenticated
  if (!isAuthenticated) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Layers}
          title="Sign in to view saved views"
          description="Create an account or sign in to save and manage tool execution snapshots."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  // No workspace
  if (!workspaceId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Layers}
          title="No workspace selected"
          description="Select a shared workspace to view and manage saved views."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  // Loading views
  if (isViewsLoading) {
    return (
      <div className="p-6">
        <div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">Loading views...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 overflow-hidden"
      >
        {/* Left Panel - Views List or Editor */}
        <ResizablePanel
          defaultSize={55}
          minSize={30}
          maxSize={70}
          className="border-r bg-muted/30 flex flex-col"
        >
          {selectedView && isEditing ? (
            <ViewEditorPanel
              view={selectedView}
              onBack={handleBackToList}
              initialToolOutput={originalToolOutput}
              liveToolOutput={liveToolOutput}
              initialWidgetState={
                selectedView.protocol === "openai-apps"
                  ? selectedView.widgetState
                  : undefined
              }
              liveWidgetState={
                selectedView.protocol === "openai-apps"
                  ? liveWidgetState
                  : undefined
              }
              isLoadingToolOutput={isLoadingToolOutput}
              onDataChange={handleEditorDataChange}
              isSaving={isSaving}
              onSave={handleEditorSave}
              hasUnsavedChanges={hasLiveUnsavedChanges}
              serverConnectionStatus={getServerConnectionStatus(selectedServer)}
              isRunning={isRunning}
              onRun={handleRun}
              onRename={(newName) => handleRenameView(selectedView, newName)}
            />
          ) : (
            <ViewsListSidebar
              views={filteredViews}
              selectedViewId={selectedViewId}
              onSelectView={handleSelectView}
              onEditView={handleEditView}
              onDuplicateView={handleDuplicateView}
              onDeleteView={handleDeleteView}
              deletingViewId={deletingViewId}
              duplicatingViewId={duplicatingViewId}
              isLoading={isViewsLoading}
              workspaceName={activeWorkspace?.name || "Workspace"}
              workspaceServers={activeWorkspace?.servers || {}}
              sharedWorkspaceId={activeWorkspace?.sharedWorkspaceId}
              currentUser={user}
              isAuthenticated={isAuthenticated}
              onWorkspaceShared={onWorkspaceShared}
              onLeaveWorkspace={onLeaveWorkspace}
            />
          )}
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel - UI Preview or Empty State */}
        <ResizablePanel
          defaultSize={50}
          className="flex flex-col overflow-hidden"
        >
          {!selectedView ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-md mx-auto p-8">
                <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                  <Layers className="h-10 w-10 text-muted-foreground" />
                </div>
                <h2 className="text-2xl font-semibold text-foreground mb-2">
                  {hasFilteredViews
                    ? "Select a view"
                    : !selectedServer
                      ? "Select a server"
                      : "No views for this server"}
                </h2>
                <p className="text-sm text-muted-foreground mb-6">
                  {hasFilteredViews
                    ? "Choose a view from the list to see its details and preview."
                    : !selectedServer
                      ? "Select a server from the tabs above to view its saved views."
                      : "This server has no saved views yet. Save tool executions from the Chat tab to create reusable views."}
                </p>
              </div>
            </div>
          ) : (
            <PlaygroundMain
              key={selectedView._id}
              serverName={serversById.get(selectedView.serverId) || ""}
              pendingExecution={pendingExecution}
              onExecutionInjected={handleExecutionInjected}
              isExecuting={false}
              executingToolName={null}
              invokingMessage={null}
              onWidgetStateChange={(_toolCallId, state) =>
                setLiveWidgetState(state)
              }
              toolRenderOverrides={toolRenderOverrides}
              disableChatInput
              hideSaveViewButton
              disabledInputPlaceholder="Chat is disabled in Views"
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
