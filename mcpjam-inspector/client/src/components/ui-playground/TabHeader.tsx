/**
 * TabHeader
 *
 * Header with tabs (Tools/Saved) and action buttons (Run, Save, Refresh, Close)
 *
 * Below ~320px tab-header width, the Tools tab stays visible; Saved + Save + Refresh
 * move into a "More" menu so the row does not overflow.
 */

import {
  RefreshCw,
  Play,
  Save,
  PanelLeftClose,
  MoreHorizontal,
  Check,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface TabHeaderProps {
  activeTab: "tools" | "saved";
  onTabChange: (tab: "tools" | "saved") => void;
  toolCount: number;
  savedCount: number;
  isExecuting: boolean;
  canExecute: boolean;
  canSave: boolean;
  fetchingTools: boolean;
  onExecute: () => void;
  onSave: () => void;
  onRefresh: () => void;
  onClose?: () => void;
}

export function TabHeader({
  activeTab,
  onTabChange,
  toolCount,
  savedCount,
  isExecuting,
  canExecute,
  canSave,
  fetchingTools,
  onExecute,
  onSave,
  onRefresh,
  onClose,
}: TabHeaderProps) {
  const tabButtonClass = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-md py-1.5 text-xs font-medium transition-colors cursor-pointer px-2 sm:px-3 ${
      active
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:text-foreground"
    }`;

  const wideTabAreaClass =
    "scrollbar-hidden hidden min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden @min-[320px]/tab-header:flex";

  // Must be `flex` by default — a bare `hidden` would hide Tools/More for all narrow widths.
  const narrowToolsRowClass =
    "flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden @min-[320px]/tab-header:hidden";

  const wideActionsClass =
    "hidden items-center gap-0.5 @min-[320px]/tab-header:flex";

  const handleRefreshTools = () => {
    onTabChange("tools");
    onRefresh();
  };

  return (
    <div className="@container/tab-header h-11 min-w-0 shrink border-b border-border">
      <div className="flex h-full min-w-0 items-center gap-1.5 px-2 sm:gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
          {onClose && (
            <Button
              onClick={onClose}
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground/80"
              title="Hide sidebar"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          )}

          {/* Wide: two tabs */}
          <div className={wideTabAreaClass} role="tablist">
            <button
              type="button"
              role="tab"
              onClick={() => onTabChange("tools")}
              className={tabButtonClass(activeTab === "tools")}
            >
              Tools
              <span className="ml-1 inline text-[10px] font-mono opacity-70">
                {toolCount}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              onClick={() => onTabChange("saved")}
              className={tabButtonClass(activeTab === "saved")}
            >
              Saved
              {savedCount > 0 && (
                <span className="ml-1 inline text-[10px] font-mono opacity-70">
                  {savedCount}
                </span>
              )}
            </button>
          </div>

          {/* Narrow: Tools tab alone + More (Saved, Save, Refresh) */}
          <div className={narrowToolsRowClass}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "tools"}
              onClick={() => onTabChange("tools")}
              className={tabButtonClass(activeTab === "tools")}
            >
              Tools
              <span className="ml-1 inline text-[10px] font-mono opacity-70">
                {toolCount}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground",
                    activeTab === "saved" && "text-primary",
                  )}
                  aria-label="More: saved requests and tools actions"
                  title="More"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="text-xs">More</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={() => onTabChange("saved")}
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    {activeTab === "saved" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : null}
                  </span>
                  Saved
                  <span className="ml-auto pl-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                    {savedCount}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-xs"
                  disabled={!canSave}
                  onSelect={() => onSave()}
                >
                  <Save className="mr-2 h-3.5 w-3.5" />
                  Save request
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs"
                  disabled={fetchingTools}
                  onSelect={() => handleRefreshTools()}
                >
                  <RefreshCw
                    className={`mr-2 h-3.5 w-3.5 ${fetchingTools ? "animate-spin" : ""}`}
                  />
                  Refresh tools
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground/80">
          <div className={wideActionsClass}>
            <Button
              onClick={onSave}
              disabled={!canSave}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Save request"
            >
              <Save className="h-3.5 w-3.5" />
            </Button>
            <Button
              onClick={handleRefreshTools}
              variant="ghost"
              size="sm"
              disabled={fetchingTools}
              className="h-7 w-7 p-0"
              title="Refresh tools"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${fetchingTools ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
          <Button
            onClick={onExecute}
            disabled={isExecuting || !canExecute}
            size="sm"
            className="h-8 shrink-0 px-2 text-xs sm:px-3"
          >
            {isExecuting ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            <span className="ml-1">Run</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
