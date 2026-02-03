import { useState, useMemo } from "react";
import {
  Search,
  MoreVertical,
  Trash2,
  ChevronRight,
  ChevronDown,
  Layers,
  Server,
  FolderOpen,
} from "lucide-react";
import { Input } from "@/components/ui/input";
// Button import removed - not currently used
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type AnyView } from "@/hooks/useViews";

type GroupBy = "none" | "server" | "category";

interface ViewsListSidebarProps {
  views: AnyView[];
  viewsByServer?: Map<string, AnyView[]>;
  viewsByCategory?: Map<string, AnyView[]>;
  selectedViewId: string | null;
  onSelectView: (viewId: string) => void;
  onDeleteView: (view: AnyView) => void;
  deletingViewId: string | null;
  isLoading: boolean;
  serversById?: Map<string, string>;
}

export function ViewsListSidebar({
  views,
  // These are available for future use when we implement server/category grouping from props
  viewsByServer: _viewsByServer,
  viewsByCategory: _viewsByCategory,
  selectedViewId,
  onSelectView,
  onDeleteView,
  deletingViewId,
  isLoading,
  serversById,
}: ViewsListSidebarProps) {
  void _viewsByServer;
  void _viewsByCategory;
  const [searchQuery, setSearchQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Filter views by search query
  const filteredViews = useMemo(() => {
    if (!searchQuery.trim()) return views;
    const query = searchQuery.toLowerCase();
    return views.filter(
      (view) =>
        view.name.toLowerCase().includes(query) ||
        view.toolName.toLowerCase().includes(query) ||
        view.category?.toLowerCase().includes(query) ||
        view.tags?.some((tag) => tag.toLowerCase().includes(query))
    );
  }, [views, searchQuery]);

  // Group filtered views
  const groupedViews = useMemo(() => {
    if (groupBy === "none") {
      return new Map([["All Views", filteredViews]]);
    }

    const grouped = new Map<string, AnyView[]>();
    for (const view of filteredViews) {
      const key =
        groupBy === "server"
          ? view.serverId
          : view.category || "Uncategorized";
      const existing = grouped.get(key) || [];
      grouped.set(key, [...existing, view]);
    }
    return grouped;
  }, [filteredViews, groupBy]);

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(groupKey)) {
        newSet.delete(groupKey);
      } else {
        newSet.add(groupKey);
      }
      return newSet;
    });
  };

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
      <div className="p-4 border-b space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Views</h2>
          <span className="text-xs text-muted-foreground">
            {filteredViews.length} {filteredViews.length === 1 ? "view" : "views"}
          </span>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search views..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-9"
          />
        </div>

        {/* Group by */}
        <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            <SelectItem value="server">Group by server</SelectItem>
            <SelectItem value="category">Group by category</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Views List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading views...
          </div>
        ) : filteredViews.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {searchQuery ? "No views match your search" : "No views yet"}
          </div>
        ) : (
          <div className="py-2">
            {Array.from(groupedViews.entries()).map(([groupKey, groupViews]) => {
              const isCollapsed = collapsedGroups.has(groupKey);
              const showGroupHeader = groupBy !== "none" || groupedViews.size > 1;

              return (
                <div key={groupKey}>
                  {showGroupHeader && (
                    <button
                      onClick={() => toggleGroup(groupKey)}
                      className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/50 transition-colors"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                      {groupBy === "server" ? (
                        <Server className="h-3 w-3" />
                      ) : groupBy === "category" ? (
                        <FolderOpen className="h-3 w-3" />
                      ) : (
                        <Layers className="h-3 w-3" />
                      )}
                      <span className="truncate flex-1 text-left">
                        {groupBy === "server" && serversById
                          ? serversById.get(groupKey) || groupKey
                          : groupKey}
                      </span>
                      <span className="text-[10px]">{groupViews.length}</span>
                    </button>
                  )}

                  {!isCollapsed &&
                    groupViews.map((view) => {
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
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
