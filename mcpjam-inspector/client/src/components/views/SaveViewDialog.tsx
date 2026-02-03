import { useState, useCallback } from "react";
import { Save, Loader2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { JsonEditor } from "@/components/ui/json-editor";
import { Badge } from "@/components/ui/badge";
import {
  useSaveView,
  type ToolDataForSave,
  type SaveViewFormData,
} from "@/hooks/useSaveView";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

interface SaveViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolData: ToolDataForSave | null;
  isAuthenticated: boolean;
  workspaceId: string | null;
  serverName: string;
}

export function SaveViewDialog({
  open,
  onOpenChange,
  toolData,
  isAuthenticated,
  workspaceId,
  serverName,
}: SaveViewDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  const { saveView, isSaving } = useSaveView({
    isAuthenticated,
    workspaceId,
    serverName,
  });

  const handleAddTag = useCallback(() => {
    const trimmedTag = tagInput.trim();
    if (trimmedTag && !tags.includes(trimmedTag)) {
      setTags([...tags, trimmedTag]);
      setTagInput("");
    }
  }, [tagInput, tags]);

  const handleRemoveTag = useCallback((tagToRemove: string) => {
    setTags((prev) => prev.filter((t) => t !== tagToRemove));
  }, []);

  const handleTagKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    },
    [handleAddTag]
  );

  const handleSave = useCallback(async () => {
    if (!toolData) return;

    const formData: SaveViewFormData = {
      name,
      description: description || undefined,
      category: category || undefined,
      tags: tags.length > 0 ? tags : undefined,
    };

    const viewId = await saveView(toolData, formData);

    if (viewId) {
      // Reset form and close dialog
      setName("");
      setDescription("");
      setCategory("");
      setTags([]);
      setTagInput("");
      onOpenChange(false);
    }
  }, [toolData, name, description, category, tags, saveView, onOpenChange]);

  const handleClose = useCallback(() => {
    if (!isSaving) {
      setName("");
      setDescription("");
      setCategory("");
      setTags([]);
      setTagInput("");
      onOpenChange(false);
    }
  }, [isSaving, onOpenChange]);

  if (!toolData) return null;

  const protocolLabel =
    toolData.uiType === UIType.OPENAI_SDK ? "OpenAI SDK" : "MCP Apps";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Save className="h-5 w-5" />
            Save View
          </DialogTitle>
          <DialogDescription>
            Save this tool execution as a reusable view for testing and
            collaboration.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          {/* Name field */}
          <div className="space-y-2">
            <Label htmlFor="view-name">Name *</Label>
            <Input
              id="view-name"
              placeholder="Enter view name..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSaving}
            />
          </div>

          {/* Description field */}
          <div className="space-y-2">
            <Label htmlFor="view-description">Description</Label>
            <Textarea
              id="view-description"
              placeholder="Describe this view..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSaving}
              rows={2}
            />
          </div>

          {/* Category field */}
          <div className="space-y-2">
            <Label htmlFor="view-category">Category</Label>
            <Input
              id="view-category"
              placeholder="e.g., User Management, Analytics..."
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={isSaving}
            />
          </div>

          {/* Tags field */}
          <div className="space-y-2">
            <Label htmlFor="view-tags">Tags</Label>
            <div className="flex gap-2">
              <Input
                id="view-tags"
                placeholder="Add tag and press Enter..."
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                disabled={isSaving}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddTag}
                disabled={isSaving || !tagInput.trim()}
              >
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="flex items-center gap-1"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      disabled={isSaving}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Metadata preview */}
          <div className="space-y-2 pt-2 border-t">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Tool:</span>
              <Badge variant="outline">{toolData.toolName}</Badge>
              <span>Protocol:</span>
              <Badge variant="outline">{protocolLabel}</Badge>
              <span>Server:</span>
              <Badge variant="outline">{serverName}</Badge>
            </div>
          </div>

          {/* Input preview */}
          {toolData.input !== undefined && toolData.input !== null && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Tool Input
              </Label>
              <div className="rounded-md border border-border/30 bg-muted/20 max-h-[150px] overflow-auto">
                <JsonEditor
                  viewOnly
                  value={toolData.input}
                  className="p-2 text-[11px]"
                  collapsible
                  defaultExpandDepth={1}
                />
              </div>
            </div>
          )}

          {/* Output preview */}
          {toolData.output !== undefined && toolData.output !== null && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Tool Output
              </Label>
              <div className="rounded-md border border-border/30 bg-muted/20 max-h-[150px] overflow-auto">
                <JsonEditor
                  viewOnly
                  value={toolData.output}
                  className="p-2 text-[11px]"
                  collapsible
                  defaultExpandDepth={1}
                />
              </div>
            </div>
          )}

          {/* Error preview */}
          {toolData.state === "output-error" && toolData.errorText && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-destructive">
                Error
              </Label>
              <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive text-sm">
                {toolData.errorText}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || !name.trim() || !isAuthenticated || !workspaceId}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save View
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
