import {
  MoreVertical,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type AnyView } from "@/hooks/useViews";

interface ViewsListSidebarProps {
  views: AnyView[];
  selectedViewId: string | null;
  onSelectView: (viewId: string) => void;
  onDeleteView: (view: AnyView) => void;
  deletingViewId: string | null;
  isLoading: boolean;
}

export function ViewsListSidebar({
  views,
  selectedViewId,
  onSelectView,
  onDeleteView,
  deletingViewId,
  isLoading,
}: ViewsListSidebarProps) {
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }
  };

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
          <div className="py-2">
            {views.map((view) => {
              const isSelected = selectedViewId === view._id;
              const isDeleting = deletingViewId === view._id;

              return (
                <div
                  key={view._id}
                  onClick={() => onSelectView(view._id)}
                  className={cn(
                    "group w-full flex items-start gap-2 px-4 py-2.5 text-left text-sm hover:bg-accent/50 transition-colors cursor-pointer",
                    isSelected && "bg-accent"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate font-medium",
                          isSelected && "font-semibold"
                        )}
                      >
                        {view.name}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0 shrink-0"
                      >
                        {view.protocol === "mcp-apps" ? "MCP" : "OpenAI"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground truncate">
                        {view.toolName}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {formatTimestamp(view.updatedAt)}
                      </span>
                    </div>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 p-1 hover:bg-accent/50 rounded transition-colors opacity-0 group-hover:opacity-100"
                        aria-label="View options"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteView(view);
                        }}
                        disabled={isDeleting}
                        variant="destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {isDeleting ? "Deleting..." : "Delete"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
