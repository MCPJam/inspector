import { useState, useCallback, useEffect, useRef } from "react";
import { Save, Loader2, ArrowLeft, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}: ViewEditorPanelProps) {
  // Editor model contains only toolInput and toolOutput
  const [editorModel, setEditorModel] = useState<EditorModel>({
    toolInput: view.toolInput,
    toolOutput: initialToolOutput ?? null,
  });

  // Track the previous liveToolOutput to detect external updates (e.g., from Run)
  const prevLiveToolOutputRef = useRef(liveToolOutput);

  // Update editor model when view changes or initialToolOutput loads
  useEffect(() => {
    setEditorModel({
      toolInput: view.toolInput,
      toolOutput: initialToolOutput ?? null,
    });
  }, [view._id, initialToolOutput]);

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
            <span className="font-medium text-sm truncate">{view.name}</span>
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
          <span className="font-medium text-sm truncate">{view.name}</span>
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
