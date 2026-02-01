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
        "flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30 text-xs text-muted-foreground",
        className,
      )}
    >
      {/* Left side: cursor position */}
      <div className="flex items-center gap-3">
        <span>
          Ln {cursorPosition.line}, Col {cursorPosition.column}
        </span>
        <span>{characterCount.toLocaleString()} chars</span>
      </div>

      {/* Right side: validation status */}
      <div className="flex items-center gap-2">
        {isValid ? (
          <span className="flex items-center gap-1 text-green-500">
            <CheckCircle className="h-3 w-3" />
            Valid JSON
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-destructive max-w-[300px] truncate"
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
