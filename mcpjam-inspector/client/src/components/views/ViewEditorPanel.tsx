import { useState, useCallback, useEffect, useRef } from "react";
import { Save, Loader2, ArrowLeft, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "@/components/ui/json-editor";
import { InlineEditableText } from "@/components/ui/inline-editable-text";
import { type AnyView } from "@/hooks/useViews";
import { type ConnectionStatus } from "@/state/app-types";

/** The editor model for Views JSON editing */
interface EditorModel {
  toolInput: unknown;
  toolOutput: unknown;
  widgetState?: unknown;
}

interface ViewEditorPanelProps {
  view: AnyView;
  onBack: () => void;
  /** Initial toolOutput loaded from blob (provided by parent) */
  initialToolOutput?: unknown;
  /** Live toolOutput that updates when Run executes */
  liveToolOutput?: unknown;
  /** Initial widgetState from saved view (OpenAI views only) */
  initialWidgetState?: unknown;
  /** Live widgetState that updates when JSON editor changes */
  liveWidgetState?: unknown;
  /** Whether toolOutput is still loading */
  isLoadingToolOutput?: boolean;
  /** Callback when editor data changes */
  onDataChange?: (data: {
    toolInput: unknown;
    toolOutput: unknown;
    widgetState?: unknown;
  }) => void;
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
  initialWidgetState,
  liveWidgetState,
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
  const createEditorModel = useCallback(
    (
      toolInput: unknown,
      toolOutput: unknown,
      widgetState: unknown,
    ): EditorModel => {
      const base = {
        toolInput,
        toolOutput,
      };

      if (view.protocol === "openai-apps") {
        return {
          ...base,
          widgetState: widgetState ?? null,
        };
      }

      return base;
    },
    [view.protocol],
  );

  const [editorModel, setEditorModel] = useState<EditorModel>(() =>
    createEditorModel(
      view.toolInput,
      initialToolOutput ?? null,
      initialWidgetState ?? null,
    ),
  );

  // Track the previous liveToolOutput to detect external updates (e.g., from Run)
  const prevLiveToolOutputRef = useRef(liveToolOutput);
  const prevLiveWidgetStateRef = useRef(liveWidgetState);

  // Update editor model when view changes or initialToolOutput loads
  useEffect(() => {
    setEditorModel(
      createEditorModel(
        view.toolInput,
        initialToolOutput ?? null,
        initialWidgetState ?? null,
      ),
    );
  }, [view._id, initialToolOutput, initialWidgetState, createEditorModel]);

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

  // Keep widgetState in sync when parent updates it (OpenAI views only)
  useEffect(() => {
    if (view.protocol !== "openai-apps") return;
    if (liveWidgetState !== prevLiveWidgetStateRef.current) {
      prevLiveWidgetStateRef.current = liveWidgetState;
      setEditorModel((prev) => ({
        ...prev,
        widgetState: liveWidgetState ?? null,
      }));
    }
  }, [view.protocol, liveWidgetState]);

  const handleChange = useCallback(
    (newValue: unknown) => {
      if (newValue && typeof newValue === "object") {
        const model = newValue as EditorModel;
        const nextModel: EditorModel =
          view.protocol === "openai-apps"
            ? {
                toolInput: model.toolInput,
                toolOutput: model.toolOutput,
                widgetState: "widgetState" in model ? model.widgetState : null,
              }
            : {
                toolInput: model.toolInput,
                toolOutput: model.toolOutput,
              };

        setEditorModel(nextModel);
        // Notify parent of data change for live preview
        if (view.protocol === "openai-apps") {
          onDataChange?.({
            toolInput: nextModel.toolInput,
            toolOutput: nextModel.toolOutput,
            widgetState: nextModel.widgetState,
          });
        } else {
          onDataChange?.({
            toolInput: nextModel.toolInput,
            toolOutput: nextModel.toolOutput,
          });
        }
      }
    },
    [onDataChange, view.protocol],
  );

  const handleSave = useCallback(async () => {
    if (!hasUnsavedChanges || !onSave) return;
    await onSave();
  }, [hasUnsavedChanges, onSave]);

  // Show loading state while toolOutput is loading
  if (isLoadingToolOutput) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="h-7 w-7 p-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <InlineEditableText
              value={view.name}
              onSave={onRename}
              disabled={!onRename}
              className="text-sm font-medium max-w-[200px]"
            />
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Left toolbar content: back button + name
  const toolbarLeftContent = (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="h-7 w-7 p-0"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <InlineEditableText
        value={view.name}
        onSave={onRename}
        disabled={!onRename}
        className="text-sm font-medium max-w-[200px]"
      />
    </div>
  );

  // Right toolbar content: Run + Save buttons
  const toolbarRightContent = (
    <div className="flex items-center gap-2">
      {serverConnectionStatus === "connected" && onRun && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRun}
          disabled={isRunning || isSaving}
          className="h-7 px-2 text-xs"
        >
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5 mr-1" />
          )}
          Run
        </Button>
      )}
      <Button
        size="sm"
        onClick={handleSave}
        disabled={!hasUnsavedChanges || isSaving || isRunning}
        className="h-7 px-2 text-xs"
      >
        {isSaving ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : (
          <Save className="h-3.5 w-3.5 mr-1" />
        )}
        Save
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* JSON Editor with unified toolbar */}
      <JsonEditor
        value={editorModel}
        onChange={handleChange}
        mode="edit"
        showToolbar={true}
        showModeToggle={false}
        wrapLongLinesInEdit={true}
        allowMaximize={true}
        height="100%"
        toolbarLeftContent={toolbarLeftContent}
        toolbarRightContent={toolbarRightContent}
      />
    </div>
  );
}
