import {
  Eye,
  Pencil,
  AlignLeft,
  Copy,
  Undo2,
  Redo2,
  Maximize2,
  Minimize2,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useState } from "react";
import type { JsonEditorMode } from "./types";
import { SegmentedControl } from "./segmented-control";

interface JsonEditorToolbarProps {
  mode: JsonEditorMode;
  onModeChange?: (mode: JsonEditorMode) => void;
  showModeToggle?: boolean;
  readOnly?: boolean;
  onFormat?: () => void;
  onCopy?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  allowMaximize?: boolean;
  isValid?: boolean;
  className?: string;
}

const modeOptions = [
  { value: "view" as const, label: "View", icon: <Eye className="h-3 w-3" /> },
  {
    value: "edit" as const,
    label: "Edit",
    icon: <Pencil className="h-3 w-3" />,
  },
];

export function JsonEditorToolbar({
  mode,
  onModeChange,
  showModeToggle = true,
  readOnly = false,
  onFormat,
  onCopy,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  isMaximized = false,
  onToggleMaximize,
  allowMaximize = false,
  isValid = true,
  className,
}: JsonEditorToolbarProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between p-2 border-b border-border",
        className,
      )}
    >
      {/* Mode toggle */}
      <div className="flex items-center gap-1">
        {showModeToggle && !readOnly && onModeChange && (
          <SegmentedControl
            options={modeOptions}
            value={mode}
            onChange={onModeChange}
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        {mode === "edit" && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onUndo}
                  disabled={!canUndo}
                  className="h-7 w-7 p-0 transition-all duration-200 hover:scale-105"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Undo (Ctrl+Z)</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onRedo}
                  disabled={!canRedo}
                  className="h-7 w-7 p-0 transition-all duration-200 hover:scale-105"
                >
                  <Redo2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Redo (Ctrl+Shift+Z)</p>
              </TooltipContent>
            </Tooltip>

            <div className="w-px h-4 bg-border mx-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onFormat}
                  disabled={!isValid}
                  className="h-7 w-7 p-0 transition-all duration-200 hover:scale-105"
                >
                  <AlignLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Format JSON</p>
              </TooltipContent>
            </Tooltip>
          </>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopy}
              className={cn(
                "h-7 w-7 p-0 transition-all duration-200 hover:scale-105",
                copied && "bg-success/10",
              )}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{copied ? "Copied!" : "Copy to clipboard"}</p>
          </TooltipContent>
        </Tooltip>

        {allowMaximize && (
          <>
            <div className="w-px h-4 bg-border mx-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onToggleMaximize}
                  className="h-7 w-7 p-0 transition-all duration-200 hover:scale-105"
                >
                  {isMaximized ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{isMaximized ? "Exit fullscreen" : "Fullscreen"}</p>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}
