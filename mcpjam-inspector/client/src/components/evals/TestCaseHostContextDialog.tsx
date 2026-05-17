/**
 * Controlled hostContext JSON editor for the test case host header.
 *
 * Mirrors the playground's `HostContextDialog` but skips the persistence
 * path: edits live on the per-case override (passed in via `value` /
 * `onChange`) and never write to `useHostContextStore`. "Apply" commits
 * the edit; "Reset" clears the per-case override entirely via
 * `onClearOverride` so the case re-tracks the live suite baseline (NOT a
 * frozen snapshot of today's baseline). The dialog disables Apply when
 * the JSON is invalid.
 */

import { useEffect, useState } from "react";
import { RotateCcw, Check } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { JsonEditor } from "@/components/ui/json-editor";

export interface TestCaseHostContextDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current value (effective: override ?? baseline). */
  value: Record<string, unknown>;
  /** Commit a new hostContext to the override. */
  onChange: (next: Record<string, unknown>) => void;
  /**
   * Clear the per-case override entirely so the case re-tracks the live
   * suite baseline. Writing `baseline` back through `onChange` would
   * instead snapshot today's value and silently drift if the suite default
   * changes later.
   */
  onClearOverride: () => void;
}

function stringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function TestCaseHostContextDialog({
  open,
  onOpenChange,
  value,
  onChange,
  onClearOverride,
}: TestCaseHostContextDialogProps) {
  const [text, setText] = useState(() => stringify(value));
  const [error, setError] = useState<string | null>(null);

  // Re-seed the textarea every time the dialog opens — keeps the editor
  // in sync with external override updates (e.g. the Reset button on the
  // header collapsed the override after the dialog last closed).
  useEffect(() => {
    if (open) {
      setText(stringify(value));
      setError(null);
    }
  }, [open, value]);

  const handleTextChange = (next: string) => {
    setText(next);
    try {
      JSON.parse(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApply = () => {
    try {
      const parsed = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        setError("hostContext must be a JSON object");
        return;
      }
      onChange(parsed as Record<string, unknown>);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResetToBaseline = () => {
    onClearOverride();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[min(96vw,60rem)] max-w-[60rem] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Host Context</DialogTitle>
          <DialogDescription>
            Edit the `hostContext` for the next Run. Changes are not saved
            back to the suite.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border border-border/70 bg-background">
            <JsonEditor
              rawContent={text}
              onRawChange={handleTextChange}
              mode="edit"
              showModeToggle={false}
              className="border-0 bg-background"
              height="100%"
              wrapLongLinesInEdit={false}
              showLineNumbers
              error={error}
              showValidationErrorInStatusBar={false}
            />
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-4">
          <Button variant="outline" onClick={handleResetToBaseline}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset to suite default
          </Button>
          <Button onClick={handleApply} disabled={!!error}>
            <Check className="mr-2 h-4 w-4" />
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
