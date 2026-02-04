import { useState, useCallback, useEffect } from "react";
import { Save, Loader2, RotateCcw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "@/components/ui/json-editor";
import { type AnyView } from "@/hooks/useViews";

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
  /** Reset handler (provided by parent) */
  onReset?: () => void;
}

export function ViewEditorPanel({
  view,
  onBack,
  initialToolOutput,
  isLoadingToolOutput,
  onDataChange,
  isSaving = false,
  onSave,
  hasUnsavedChanges = false,
  onReset,
}: ViewEditorPanelProps) {
  // Editor model contains only toolInput and toolOutput
  const [editorModel, setEditorModel] = useState<EditorModel>({
    toolInput: view.toolInput,
    toolOutput: initialToolOutput ?? null,
  });

  // Update editor model when view changes or initialToolOutput loads
  useEffect(() => {
    setEditorModel({
      toolInput: view.toolInput,
      toolOutput: initialToolOutput ?? null,
    });
  }, [view._id, initialToolOutput]);

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
    [onDataChange]
  );

  const handleReset = useCallback(() => {
    // Reset to original values
    setEditorModel({
      toolInput: view.toolInput,
      toolOutput: initialToolOutput ?? null,
    });
    onReset?.();
  }, [view.toolInput, initialToolOutput, onReset]);

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
            <span className="text-sm font-medium text-muted-foreground">
              Editor
            </span>
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
          <span className="text-sm font-medium text-muted-foreground">
            Editor
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={!hasUnsavedChanges || isSaving}
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            Reset
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasUnsavedChanges || isSaving}
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
