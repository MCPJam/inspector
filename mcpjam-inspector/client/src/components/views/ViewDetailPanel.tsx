import { useState, useCallback, useEffect } from "react";
import {
  Edit,
  Save,
  X,
  AlertCircle,
  ExternalLink,
  Loader2,
  Eye,
  Code,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { JsonEditor } from "@/components/ui/json-editor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  type AnyView,
  type McpAppView,
  type OpenaiAppView,
  type DisplayContext,
} from "@/hooks/useViews";
import { type ConnectionStatus } from "@/state/app-types";
import { ViewPreview } from "./ViewPreview";
import { callTool } from "@/lib/apis/mcp-tools-api";
import { useViewMutations } from "@/hooks/useViews";

export interface ViewDraft {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  toolInput: unknown;
  toolOutput: unknown | null;
  prefersBorder?: boolean;
  defaultContext?: DisplayContext;
}

interface ViewDetailPanelProps {
  view: AnyView;
  draft: ViewDraft | null;
  isEditing: boolean;
  hasUnsavedChanges: boolean;
  onStartEditing: () => void;
  onSaveChanges: () => Promise<void>;
  onDiscardChanges: () => void;
  onDraftChange: (updates: Partial<ViewDraft>) => void;
  serverName?: string;
  /** Server connection status for determining online/offline state */
  serverConnectionStatus?: ConnectionStatus;
  /** Callback when view is refreshed (re-run tool) */
  onViewRefreshed?: () => void;
}

export function ViewDetailPanel({
  view,
  draft,
  isEditing,
  hasUnsavedChanges,
  onStartEditing,
  onSaveChanges,
  onDiscardChanges,
  onDraftChange,
  serverName,
  serverConnectionStatus,
  onViewRefreshed,
}: ViewDetailPanelProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [isRerunning, setIsRerunning] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [outputData, setOutputData] = useState<unknown | null>(null);
  const [isLoadingOutput, setIsLoadingOutput] = useState(false);
  const [activeTab, setActiveTab] = useState<"preview" | "data">("preview");

  // Get mutation for generating upload URLs and updating views
  const { updateMcpView, updateOpenaiView, generateMcpUploadUrl, generateOpenaiUploadUrl } = useViewMutations();

  // Determine if server is online for re-run capability
  const isServerOnline = serverConnectionStatus === "connected";

  // Load output blob when view changes
  useEffect(() => {
    async function loadOutput() {
      if (!view.toolOutputUrl) {
        setOutputData(null);
        return;
      }

      setIsLoadingOutput(true);
      try {
        const response = await fetch(view.toolOutputUrl);
        const data = await response.json();
        setOutputData(data);
      } catch (error) {
        console.error("Failed to load output:", error);
        setOutputData(null);
      } finally {
        setIsLoadingOutput(false);
      }
    }

    loadOutput();
  }, [view.toolOutputUrl]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await onSaveChanges();
    } finally {
      setIsSaving(false);
    }
  }, [onSaveChanges]);

  // Handle re-run tool execution
  const handleRerunTool = useCallback(async () => {
    if (!serverName || !isServerOnline) {
      toast.error("Server must be connected to re-run the tool");
      return;
    }

    setIsRerunning(true);
    try {
      // Execute the tool with the stored input
      const toolInput = view.toolInput as Record<string, unknown> ?? {};
      const result = await callTool(serverName, view.toolName, toolInput);

      // Upload the new output as a blob
      const generateUploadUrl = view.protocol === "mcp-apps"
        ? generateMcpUploadUrl
        : generateOpenaiUploadUrl;
      const uploadUrl = await generateUploadUrl({});

      const blob = new Blob([JSON.stringify(result)], { type: "application/json" });
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        body: blob,
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload new output blob");
      }

      const { storageId: toolOutputBlobId } = await uploadResponse.json();

      // Update the view with the new output blob
      const updateView = view.protocol === "mcp-apps" ? updateMcpView : updateOpenaiView;
      await updateView({
        viewId: view._id,
        toolOutputBlobId,
        toolState: "output-available",
        // Clear any previous error
        toolErrorText: undefined,
      });

      // Update local state to show new output
      setOutputData(result);

      toast.success("Tool re-executed and view updated successfully");
      onViewRefreshed?.();
    } catch (error) {
      console.error("Failed to re-run tool:", error);
      const message = error instanceof Error ? error.message : "Failed to re-run tool";
      toast.error(message);
    } finally {
      setIsRerunning(false);
    }
  }, [
    serverName,
    isServerOnline,
    view,
    generateMcpUploadUrl,
    generateOpenaiUploadUrl,
    updateMcpView,
    updateOpenaiView,
    onViewRefreshed,
  ]);

  const handleAddTag = useCallback(() => {
    const trimmedTag = tagInput.trim();
    if (trimmedTag && draft && !draft.tags?.includes(trimmedTag)) {
      onDraftChange({
        tags: [...(draft.tags || []), trimmedTag],
      });
      setTagInput("");
    }
  }, [tagInput, draft, onDraftChange]);

  const handleRemoveTag = useCallback(
    (tagToRemove: string) => {
      if (draft) {
        onDraftChange({
          tags: draft.tags?.filter((t) => t !== tagToRemove),
        });
      }
    },
    [draft, onDraftChange]
  );

  const handleTagKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    },
    [handleAddTag]
  );

  const protocolLabel =
    view.protocol === "mcp-apps" ? "MCP Apps" : "OpenAI SDK";

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <Input
                value={draft?.name || ""}
                onChange={(e) => onDraftChange({ name: e.target.value })}
                className="text-xl font-semibold h-auto py-1"
                placeholder="View name"
              />
            ) : (
              <h1 className="text-xl font-semibold truncate">{view.name}</h1>
            )}
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-xs">
                {protocolLabel}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {view.toolName}
              </span>
              {/* Show server name or deleted indicator */}
              {serverName ? (
                <span className="text-xs text-muted-foreground">
                  • {serverName}
                </span>
              ) : (
                <Badge variant="secondary" className="text-xs text-amber-600 bg-amber-100 dark:bg-amber-900/30">
                  Server deleted
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                Updated {formatDate(view.updatedAt)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isEditing ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDiscardChanges}
                  disabled={isSaving}
                >
                  <X className="h-4 w-4 mr-1" />
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || !hasUnsavedChanges}
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Save
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRerunTool}
                  disabled={isRerunning || !isServerOnline}
                  title={!isServerOnline ? "Server must be connected to re-run" : "Re-execute tool with stored input"}
                >
                  {isRerunning ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1" />
                  )}
                  Re-run
                </Button>
                <Button variant="outline" size="sm" onClick={onStartEditing}>
                  <Edit className="h-4 w-4 mr-1" />
                  Edit
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-6 space-y-6">
        {/* Description */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Description</Label>
          {isEditing ? (
            <Textarea
              value={draft?.description || ""}
              onChange={(e) => onDraftChange({ description: e.target.value })}
              placeholder="Add a description..."
              rows={2}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {view.description || "No description"}
            </p>
          )}
        </div>

        {/* Category */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Category</Label>
          {isEditing ? (
            <Input
              value={draft?.category || ""}
              onChange={(e) => onDraftChange({ category: e.target.value })}
              placeholder="e.g., User Management, Analytics..."
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {view.category || "No category"}
            </p>
          )}
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Tags</Label>
          {isEditing ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  placeholder="Add tag and press Enter..."
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddTag}
                  disabled={!tagInput.trim()}
                >
                  Add
                </Button>
              </div>
              {draft?.tags && draft.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {draft.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="flex items-center gap-1"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        className="ml-1 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ) : view.tags && view.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {view.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tags</p>
          )}
        </div>

        {/* Protocol-specific metadata */}
        {view.protocol === "mcp-apps" && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Resource URI</Label>
            <p className="text-sm font-mono text-muted-foreground break-all">
              {(view as McpAppView).resourceUri}
            </p>
          </div>
        )}

        {view.protocol === "openai-apps" && (view as OpenaiAppView).serverInfo && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Server Info</Label>
            <div className="flex items-center gap-2">
              {(view as OpenaiAppView).serverInfo?.iconUrl && (
                <img
                  src={(view as OpenaiAppView).serverInfo?.iconUrl}
                  alt=""
                  className="h-5 w-5 rounded"
                />
              )}
              <span className="text-sm">
                {(view as OpenaiAppView).serverInfo?.name}
              </span>
            </div>
          </div>
        )}

        {/* Preview / Data Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "preview" | "data")} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="preview" className="flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="data" className="flex items-center gap-2">
              <Code className="h-4 w-4" />
              Data
            </TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="mt-4">
            {/* Widget Preview */}
            <div className="rounded-lg border bg-muted/10 min-h-[300px]">
              <ViewPreview
                view={view}
                displayMode="inline"
                serverName={serverName}
                serverConnectionStatus={serverConnectionStatus}
              />
            </div>
          </TabsContent>

          <TabsContent value="data" className="mt-4 space-y-4">
            {/* Tool Input */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Tool Input</Label>
              <div
                className={cn(
                  "rounded-md border bg-muted/20 max-h-[300px] overflow-auto",
                  isEditing && "border-primary/50"
                )}
              >
                <JsonEditor
                  viewOnly={!isEditing}
                  value={isEditing ? draft?.toolInput : view.toolInput}
                  onChange={
                    isEditing
                      ? (value) => onDraftChange({ toolInput: value })
                      : undefined
                  }
                  className="p-3 text-sm"
                  collapsible
                  defaultExpandDepth={2}
                />
              </div>
            </div>

            {/* Tool Output */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Tool Output</Label>
                {view.toolOutputUrl && (
                  <a
                    href={view.toolOutputUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                  >
                    View raw
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <div className="rounded-md border bg-muted/20 max-h-[300px] overflow-auto">
                {isLoadingOutput ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                    Loading output...
                  </div>
                ) : outputData ? (
                  <JsonEditor
                    viewOnly
                    value={outputData}
                    className="p-3 text-sm"
                    collapsible
                    defaultExpandDepth={2}
                  />
                ) : (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No output data
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Error section */}
        {view.toolState === "output-error" && view.toolErrorText && (
          <div className="space-y-2">
            <Label className="text-sm font-medium text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Error
            </Label>
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {view.toolErrorText}
            </div>
          </div>
        )}

        {/* Metadata */}
        <div className="pt-4 border-t space-y-2">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Metadata
          </Label>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Created:</span>
              <span className="ml-2">{formatDate(view.createdAt)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Tool State:</span>
              <span className="ml-2">
                <Badge
                  variant={
                    view.toolState === "output-available"
                      ? "default"
                      : "destructive"
                  }
                  className="text-xs"
                >
                  {view.toolState}
                </Badge>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
