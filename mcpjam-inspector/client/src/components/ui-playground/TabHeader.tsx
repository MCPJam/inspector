/**
 * TabHeader
 *
 * Header with tabs (Tools/Saved) and action buttons (Run, Save, Refresh, Close)
 */

import { RefreshCw, Play, Save, PanelLeftClose } from "lucide-react";
import { Button } from "../ui/button";

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

  return (
    <div className="@container/tab-header h-11 min-w-0 shrink border-b border-border">
      <div className="flex h-full min-w-0 items-center gap-1.5 px-2 sm:gap-2">
        {/* Left: hide + tabs — scrolls horizontally when the panel is narrow */}
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
          <div
            className="scrollbar-hidden flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden"
            role="tablist"
          >
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
        </div>

        {/* Right: save + refresh only when the header is wide enough; Run always */}
        <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground/80">
          <div className="hidden items-center gap-0.5 @min-[320px]/tab-header:flex">
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
              onClick={onRefresh}
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
