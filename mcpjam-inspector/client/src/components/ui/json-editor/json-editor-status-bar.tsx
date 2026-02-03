import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CursorPosition } from "./types";

interface JsonEditorStatusBarProps {
  cursorPosition: CursorPosition;
  isValid: boolean;
  validationError?: string | null;
  characterCount: number;
  className?: string;
}

export function JsonEditorStatusBar({
  cursorPosition,
  isValid,
  validationError,
  characterCount,
  className,
}: JsonEditorStatusBarProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-1.5 border-t border-border/50",
        "bg-gradient-to-r from-muted/40 via-muted/30 to-muted/40",
        "text-xs text-muted-foreground tabular-nums transition-colors duration-300",
        className,
      )}
      style={{ fontFamily: "var(--font-code)" }}
    >
      {/* Left side: cursor position */}
      <div className="flex items-center gap-3">
        <span className="transition-colors duration-200">
          Ln {cursorPosition.line}, Col {cursorPosition.column}
        </span>
        <span className="transition-colors duration-200">
          {characterCount.toLocaleString()} chars
        </span>
      </div>

      {/* Right side: validation status */}
      <div className="flex items-center gap-2">
        {isValid ? (
          <span className="flex items-center gap-1 text-success transition-colors duration-300">
            <CheckCircle className="h-3 w-3" />
            Valid JSON
          </span>
        ) : (
          <span
            className={cn(
              "flex items-center gap-1 text-destructive max-w-[300px] truncate",
              "transition-colors duration-300 json-status-error",
            )}
            title={validationError ?? "Invalid JSON"}
          >
            <XCircle className="h-3 w-3 flex-shrink-0" />
            {validationError ?? "Invalid JSON"}
          </span>
        )}
      </div>
    </div>
  );
}
