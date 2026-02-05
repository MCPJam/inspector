import { Trash2, Pencil, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineEditableText } from "@/components/ui/inline-editable-text";
import { cn } from "@/lib/utils";
import { type AnyView } from "@/hooks/useViews";

interface ViewsListSidebarProps {
  views: AnyView[];
  selectedViewId: string | null;
  onSelectView: (viewId: string) => void;
  onEditView: (view: AnyView) => void;
  onDuplicateView: (view: AnyView) => void;
  onDeleteView: (view: AnyView) => void;
  onRenameView?: (view: AnyView, newName: string) => Promise<void>;
  deletingViewId: string | null;
  duplicatingViewId: string | null;
  isLoading: boolean;
}

export function ViewsListSidebar({
  views,
  selectedViewId,
  onSelectView,
  onEditView,
  onDuplicateView,
  onDeleteView,
  onRenameView,
  deletingViewId,
  duplicatingViewId,
  isLoading,
}: ViewsListSidebarProps) {
  return (
    <>
      {/* Header */}
      <div className="p-4 border-b">
        <h2 className="text-sm font-semibold">Views</h2>
      </div>

      {/* Views List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading views...
          </div>
        ) : views.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No views yet
          </div>
        ) : (
          <div className="py-1">
            {views.map((view) => {
              const isSelected = selectedViewId === view._id;
              const isDeleting = deletingViewId === view._id;
              const isDuplicating = duplicatingViewId === view._id;

              return (
                <div
                  key={view._id}
                  onClick={() => onSelectView(view._id)}
                  className={cn(
                    "group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors",
                    isSelected ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <InlineEditableText
                      value={view.name}
                      onSave={
                        onRenameView
                          ? (newName) => onRenameView(view, newName)
                          : undefined
                      }
                      disabled={!onRenameView}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        "text-sm",
                        isSelected ? "font-medium" : "font-normal",
                      )}
                    />
                    <span className="text-xs text-muted-foreground truncate shrink-0">
                      {view.toolName}
                    </span>
                  </div>

                  <div
                    className={cn(
                      "flex items-center gap-0.5 shrink-0 transition-opacity",
                      isSelected
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                    )}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditView(view);
                      }}
                      aria-label="Edit view"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDuplicateView(view);
                      }}
                      disabled={isDuplicating}
                      aria-label="Duplicate view"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteView(view);
                      }}
                      disabled={isDeleting}
                      aria-label="Delete view"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
