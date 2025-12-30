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
  return (
    <div className="border-b border-border flex-shrink-0">
      <div className="px-2 py-1.5 flex items-center gap-2">
        {/* Tabs */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onTabChange("tools")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              activeTab === "tools"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Tools
            <span className="ml-1 text-[10px] font-mono opacity-70">
              {toolCount}
            </span>
          </button>
          <button
            onClick={() => onTabChange("saved")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              activeTab === "saved"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Saved
            {savedCount > 0 && (
              <span className="ml-1 text-[10px] font-mono opacity-70">
                {savedCount}
              </span>
            )}
          </button>
        </div>

        {/* Secondary actions */}
        <div className="flex items-center gap-0.5 text-muted-foreground/80">
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
          {onClose && (
            <Button
              onClick={onClose}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Hide sidebar"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Run button */}
        <Button
          onClick={onExecute}
          disabled={isExecuting || !canExecute}
          size="sm"
          className="h-8 px-3 text-xs ml-auto"
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
  );
}
