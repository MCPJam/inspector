import { useState, useCallback, useEffect, useRef } from "react";
import { Save, Loader2, ArrowLeft, Play, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JsonEditor } from "@/components/ui/json-editor";
import { type AnyView } from "@/hooks/useViews";
import { type ConnectionStatus } from "@/state/app-types";

/** The editor model - only toolInput and toolOutput */
interface EditorModel {
  toolInput: unknown;
  toolOutput: unknown;
}

interface ViewEditorPanelProps {
  view: AnyView;
  onBack: () => void;
  /** Initial toolOutput loaded from blob (provided by parent) */
  initialToolOutput?: unknown;
  /** Live toolOutput that updates when Run executes */
  liveToolOutput?: unknown;
  /** Whether toolOutput is still loading */
  isLoadingToolOutput?: boolean;
  /** Callback when editor data changes */
  onDataChange?: (data: { toolInput: unknown; toolOutput: unknown }) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Save handler (provided by parent) */
  onSave?: () => Promise<void>;
  /** Whether there are unsaved changes */
  hasUnsavedChanges?: boolean;
  /** Server connection status for showing Run button */
  serverConnectionStatus?: ConnectionStatus;
  /** Whether tool execution is in progress */
  isRunning?: boolean;
  /** Run handler to execute the tool with current input */
  onRun?: () => Promise<void>;
  /** Rename handler */
  onRename?: (newName: string) => Promise<void>;
}

export function ViewEditorPanel({
  view,
  onBack,
  initialToolOutput,
  liveToolOutput,
  isLoadingToolOutput,
  onDataChange,
  isSaving = false,
  onSave,
  hasUnsavedChanges = false,
  serverConnectionStatus,
  isRunning = false,
  onRun,
  onRename,
}: ViewEditorPanelProps) {
  // Editor model contains only toolInput and toolOutput
  const [editorModel, setEditorModel] = useState<EditorModel>({
    toolInput: view.toolInput,
    toolOutput: initialToolOutput ?? null,
  });

  // Name editing state
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(view.name);
  const [isRenameSaving, setIsRenameSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Track the previous liveToolOutput to detect external updates (e.g., from Run)
  const prevLiveToolOutputRef = useRef(liveToolOutput);

  // Update editor model when view changes or initialToolOutput loads
  useEffect(() => {
    setEditorModel({
      toolInput: view.toolInput,
      toolOutput: initialToolOutput ?? null,
    });
  }, [view._id, initialToolOutput]);

  // Reset edited name when view changes
  useEffect(() => {
    setEditedName(view.name);
    setIsEditingName(false);
  }, [view._id, view.name]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  const handleStartEditingName = useCallback(() => {
    if (onRename) {
      setEditedName(view.name);
      setIsEditingName(true);
    }
  }, [onRename, view.name]);

  const handleCancelEditingName = useCallback(() => {
    setEditedName(view.name);
    setIsEditingName(false);
  }, [view.name]);

  const handleSaveName = useCallback(async () => {
    const trimmedName = editedName.trim();
    if (!trimmedName || trimmedName === view.name || !onRename) {
      handleCancelEditingName();
      return;
    }

    setIsRenameSaving(true);
    try {
      await onRename(trimmedName);
      setIsEditingName(false);
    } catch {
      // Keep editing mode on error (parent will show toast)
    } finally {
      setIsRenameSaving(false);
    }
  }, [editedName, view.name, onRename, handleCancelEditingName]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSaveName();
      } else if (e.key === "Escape") {
        handleCancelEditingName();
      }
    },
    [handleSaveName, handleCancelEditingName],
  );

  // Update only toolOutput when liveToolOutput changes from parent (e.g., after Run)
  // This preserves the user's toolInput edits while showing the new output
  useEffect(() => {
    if (liveToolOutput !== prevLiveToolOutputRef.current) {
      prevLiveToolOutputRef.current = liveToolOutput;
      setEditorModel((prev) => ({
        ...prev,
        toolOutput: liveToolOutput ?? null,
      }));
    }
  }, [liveToolOutput]);

  const handleChange = useCallback(
    (newValue: unknown) => {
      if (newValue && typeof newValue === "object") {
        const model = newValue as EditorModel;
        setEditorModel(model);
        // Notify parent of data change for live preview
        onDataChange?.({
          toolInput: model.toolInput,
          toolOutput: model.toolOutput,
        });
      }
    },
    [onDataChange],
  );

  const handleSave = useCallback(async () => {
    if (!hasUnsavedChanges || !onSave) return;
    await onSave();
  }, [hasUnsavedChanges, onSave]);

  // Render the editable name component
  const renderNameEditor = () => {
    if (isEditingName) {
      return (
        <Input
          ref={nameInputRef}
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          onKeyDown={handleNameKeyDown}
          onBlur={handleSaveName}
          disabled={isRenameSaving}
          className="h-7 w-48 text-sm font-medium"
        />
      );
    }

    return (
      <button
        onClick={handleStartEditingName}
        disabled={!onRename}
        className="flex items-center gap-1.5 group font-medium text-sm truncate hover:text-foreground/80 disabled:cursor-default"
      >
        <span className="truncate">{view.name}</span>
        {onRename && (
          <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity" />
        )}
      </button>
    );
  };

  // Show loading state while toolOutput is loading
  if (isLoadingToolOutput) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="h-8 w-8 p-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            {renderNameEditor()}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="h-8 w-8 p-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {renderNameEditor()}
        </div>
        <div className="flex items-center gap-2">
          {serverConnectionStatus === "connected" && onRun && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRun}
              disabled={isRunning || isSaving}
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              Run
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasUnsavedChanges || isSaving || isRunning}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            Save
          </Button>
        </div>
      </div>

      {/* JSON Editor */}
      <div className="flex-1 overflow-hidden">
        <JsonEditor
          value={editorModel}
          onChange={handleChange}
          mode="edit"
          showToolbar={true}
          showModeToggle={false}
          allowMaximize={true}
          height="100%"
        />
      </div>
    </div>
  );
}
