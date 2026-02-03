import { useMemo, useState, useCallback, useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { Layers } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useViewQueries, useViewMutations, useWorkspaceServers, type AnyView } from "@/hooks/useViews";
import { useSharedAppState } from "@/state/app-state-context";
import { ViewsListSidebar } from "./views/ViewsListSidebar";
import { ViewDetailPanel, type ViewDraft } from "./views/ViewDetailPanel";

interface ViewsTabProps {
  selectedServer?: string;
}

export function ViewsTab({ selectedServer }: ViewsTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const appState = useSharedAppState();

  // Get the Convex workspace ID from the active workspace
  const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
  const workspaceId = activeWorkspace?.sharedWorkspaceId ?? null;

  // View state
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [draftView, setDraftView] = useState<ViewDraft | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [deletingViewId, setDeletingViewId] = useState<string | null>(null);

  // Fetch views
  const {
    sortedViews,
    isLoading: isViewsLoading,
  } = useViewQueries({
    isAuthenticated,
    workspaceId,
  });

  // Fetch workspace servers to resolve server IDs to names
  const { serversById, serversByName } = useWorkspaceServers({
    isAuthenticated,
    workspaceId,
  });

  // Get the server ID from the selected server name
  const selectedServerId = selectedServer ? serversByName.get(selectedServer) : undefined;

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
      const viewStillExists = filteredViews.some((v) => v._id === selectedViewId);
      if (!viewStillExists) {
        setSelectedViewId(null);
        setDraftView(null);
        setIsEditing(false);
      }
    }
  }, [selectedServerId, selectedViewId, filteredViews]);

  // Get connection status for a specific server by server ID
  const getServerConnectionStatus = useCallback((serverName: string | undefined) => {
    if (!serverName) return undefined;
    return activeWorkspace?.servers[serverName]?.connectionStatus;
  }, [activeWorkspace]);

  // Mutations
  const {
    updateMcpView,
    updateOpenaiView,
    removeMcpView,
    removeOpenaiView,
    // Upload URLs are available for future edit with output changes
    // generateMcpUploadUrl,
    // generateOpenaiUploadUrl,
  } = useViewMutations();

  // Get selected view (from filtered list)
  const selectedView = useMemo(() => {
    if (!selectedViewId) return null;
    return filteredViews.find((v) => v._id === selectedViewId) ?? null;
  }, [selectedViewId, filteredViews]);

  // Initialize draft when selecting a view
  const handleSelectView = useCallback((viewId: string) => {
    setSelectedViewId(viewId);
    const view = filteredViews.find((v) => v._id === viewId);
    if (view) {
      setDraftView({
        name: view.name,
        description: view.description,
        category: view.category,
        tags: view.tags,
        toolInput: view.toolInput,
        toolOutput: null, // Will be loaded separately if needed
        prefersBorder: view.prefersBorder,
        defaultContext: view.defaultContext,
      });
    }
    setIsEditing(false);
  }, [filteredViews]);

  // Handle edit mode
  const handleStartEditing = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleDiscardChanges = useCallback(() => {
    if (selectedView) {
      setDraftView({
        name: selectedView.name,
        description: selectedView.description,
        category: selectedView.category,
        tags: selectedView.tags,
        toolInput: selectedView.toolInput,
        toolOutput: null,
        prefersBorder: selectedView.prefersBorder,
        defaultContext: selectedView.defaultContext,
      });
    }
    setIsEditing(false);
  }, [selectedView]);

  // Handle save
  const handleSaveChanges = useCallback(async () => {
    if (!selectedView || !draftView) return;

    try {
      const updates = {
        viewId: selectedView._id,
        name: draftView.name,
        description: draftView.description,
        category: draftView.category,
        tags: draftView.tags,
        toolInput: draftView.toolInput,
        prefersBorder: draftView.prefersBorder,
        defaultContext: draftView.defaultContext,
      };

      if (selectedView.protocol === "mcp-apps") {
        await updateMcpView(updates);
      } else {
        await updateOpenaiView(updates);
      }

      toast.success("View updated successfully");
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to update view:", error);
      toast.error("Failed to update view");
    }
  }, [selectedView, draftView, updateMcpView, updateOpenaiView]);

  // Handle delete
  const handleDeleteView = useCallback(async (view: AnyView) => {
    setDeletingViewId(view._id);
    try {
      if (view.protocol === "mcp-apps") {
        await removeMcpView({ viewId: view._id });
      } else {
        await removeOpenaiView({ viewId: view._id });
      }

      toast.success(`View "${view.name}" deleted`);

      // Clear selection if deleted view was selected
      if (selectedViewId === view._id) {
        setSelectedViewId(null);
        setDraftView(null);
        setIsEditing(false);
      }
    } catch (error) {
      console.error("Failed to delete view:", error);
      toast.error("Failed to delete view");
    } finally {
      setDeletingViewId(null);
    }
  }, [selectedViewId, removeMcpView, removeOpenaiView]);

  // Update draft field
  const handleDraftChange = useCallback((updates: Partial<ViewDraft>) => {
    setDraftView((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  // Check if draft has changes
  const hasUnsavedChanges = useMemo(() => {
    if (!selectedView || !draftView) return false;
    return (
      draftView.name !== selectedView.name ||
      draftView.description !== selectedView.description ||
      draftView.category !== selectedView.category ||
      JSON.stringify(draftView.tags) !== JSON.stringify(selectedView.tags) ||
      JSON.stringify(draftView.toolInput) !== JSON.stringify(selectedView.toolInput) ||
      draftView.prefersBorder !== selectedView.prefersBorder
    );
  }, [selectedView, draftView]);

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
        {/* Left Sidebar */}
        <ResizablePanel
          defaultSize={30}
          minSize={15}
          maxSize={40}
          className="border-r bg-muted/30 flex flex-col"
        >
          <ViewsListSidebar
            views={filteredViews}
            selectedViewId={selectedViewId}
            onSelectView={handleSelectView}
            onDeleteView={handleDeleteView}
            deletingViewId={deletingViewId}
            isLoading={isViewsLoading}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Main Content Area */}
        <ResizablePanel
          defaultSize={70}
          className="flex flex-col overflow-hidden"
        >
          {!selectedView ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-md mx-auto p-8">
                <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
                  <Layers className="h-10 w-10 text-muted-foreground" />
                </div>
                <h2 className="text-2xl font-semibold text-foreground mb-2">
                  {hasFilteredViews ? "Select a view" : !selectedServer ? "Select a server" : "No views for this server"}
                </h2>
                <p className="text-sm text-muted-foreground mb-6">
                  {hasFilteredViews
                    ? "Choose a view from the sidebar to see its details and preview."
                    : !selectedServer
                    ? "Select a server from the tabs above to view its saved views."
                    : "This server has no saved views yet. Save tool executions from the Chat tab to create reusable views."}
                </p>
              </div>
            </div>
          ) : (
            <ViewDetailPanel
              view={selectedView}
              draft={draftView}
              isEditing={isEditing}
              hasUnsavedChanges={hasUnsavedChanges}
              onStartEditing={handleStartEditing}
              onSaveChanges={handleSaveChanges}
              onDiscardChanges={handleDiscardChanges}
              onDraftChange={handleDraftChange}
              serverName={serversById.get(selectedView.serverId)}
              serverConnectionStatus={getServerConnectionStatus(serversById.get(selectedView.serverId))}
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
