import { AlertTriangle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import type { CursorPosition } from "./types";

interface JsonEditorStatusBarProps {
  cursorPosition: CursorPosition;
  characterCount: number;
  validationError?: string | null;
  className?: string;
}

export function JsonEditorStatusBar({
  cursorPosition,
  characterCount,
  validationError,
  className,
}: JsonEditorStatusBarProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-1.5 border-t border-border/50",
        "bg-gradient-to-r from-muted/40 via-muted/30 to-muted/40",
        "text-xs text-muted-foreground tabular-nums transition-colors duration-300",
        className,
      )}
      style={{ fontFamily: "var(--font-code)" }}
    >
      <div className="flex items-center gap-3">
        <span className="transition-colors duration-200">
          Ln {cursorPosition.line}, Col {cursorPosition.column}
        </span>
        <span className="transition-colors duration-200">
          {characterCount.toLocaleString()} chars
        </span>
      </div>
      {validationError ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 cursor-default items-center gap-1.5 text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="truncate">{validationError}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="max-w-[min(40rem,calc(100vw-2rem))] break-words"
          >
            <p>{validationError}</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
