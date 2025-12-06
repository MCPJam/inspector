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
      <div className="flex items-center">
        <button
          onClick={() => onTabChange("tools")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === "tools"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Tools
          <span className="ml-1 text-[10px] font-mono opacity-60">
            {toolCount}
          </span>
        </button>
        <button
          onClick={() => onTabChange("saved")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === "saved"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Saved
          {savedCount > 0 && (
            <span className="ml-1 text-[10px] font-mono opacity-60">
              {savedCount}
            </span>
          )}
        </button>
        <div className="ml-auto flex items-center gap-1 pr-2">
          <Button
            onClick={onExecute}
            disabled={isExecuting || !canExecute}
            size="sm"
            className="h-7 px-2.5 text-xs"
          >
            {isExecuting ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            <span className="ml-1">Run</span>
          </Button>
          <Button
            onClick={onSave}
            disabled={!canSave}
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title="Save request"
          >
            <Save className="h-3 w-3" />
          </Button>
          <div className="w-px h-4 bg-border mx-0.5" />
          <Button
            onClick={onRefresh}
            variant="ghost"
            size="sm"
            disabled={fetchingTools}
            className="h-7 w-7 p-0"
            title="Refresh tools"
          >
            <RefreshCw
              className={`h-3 w-3 ${fetchingTools ? "animate-spin" : ""}`}
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
              <PanelLeftClose className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
