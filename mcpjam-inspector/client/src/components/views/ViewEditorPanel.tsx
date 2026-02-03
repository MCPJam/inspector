import { useState, useCallback, useMemo, useEffect } from "react";
import { Save, Loader2, RotateCcw, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  type AnyView,
  useViewMutations,
} from "@/hooks/useViews";

interface ViewEditorPanelProps {
  view: AnyView;
  onBack: () => void;
}

export function ViewEditorPanel({ view, onBack }: ViewEditorPanelProps) {
  const [editedView, setEditedView] = useState<AnyView>(view);
  const [isSaving, setIsSaving] = useState(false);

  const { updateMcpView, updateOpenaiView } = useViewMutations();

  // Reset edited view when the selected view changes
  useEffect(() => {
    setEditedView(view);
  }, [view._id]);

  // Check if there are unsaved changes
  const hasChanges = useMemo(() => {
    return JSON.stringify(editedView) !== JSON.stringify(view);
  }, [editedView, view]);

  const handleChange = useCallback((newValue: unknown) => {
    if (newValue && typeof newValue === "object") {
      setEditedView(newValue as AnyView);
    }
  }, []);

  const handleReset = useCallback(() => {
    setEditedView(view);
  }, [view]);

  const handleSave = useCallback(async () => {
    if (!hasChanges) return;

    setIsSaving(true);
    try {
      // Extract editable fields from the edited view
      const updates = {
        viewId: editedView._id,
        name: editedView.name,
        description: editedView.description,
        category: editedView.category,
        tags: editedView.tags,
        toolInput: editedView.toolInput,
        prefersBorder: editedView.prefersBorder,
        defaultContext: editedView.defaultContext,
      };

      if (editedView.protocol === "mcp-apps") {
        await updateMcpView(updates);
      } else {
        await updateOpenaiView(updates);
      }

      toast.success("View saved successfully");
    } catch (error) {
      console.error("Failed to save view:", error);
      toast.error("Failed to save view");
    } finally {
      setIsSaving(false);
    }
  }, [editedView, hasChanges, updateMcpView, updateOpenaiView]);

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
            disabled={!hasChanges || isSaving}
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            Reset
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
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
          value={editedView}
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
