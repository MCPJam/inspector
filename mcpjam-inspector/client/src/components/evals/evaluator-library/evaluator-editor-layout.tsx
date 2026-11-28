import { Button } from "@mcpjam/design-system/button";
import { DialogFooter } from "@mcpjam/design-system/dialog";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";
import type { ReactNode } from "react";

/** Whether an editor's draft differs from where it started. */
export function draftChanged(draft: unknown, start: unknown): boolean {
  return stableStringifyJson(draft) !== stableStringifyJson(start);
}

export function EvaluatorEditorLayout({
  inDialog = false,
  inlineClassName,
  children,
  action,
  disabled,
  onCancel,
  onSubmit,
  error,
}: {
  inDialog?: boolean;
  inlineClassName?: string;
  children: ReactNode;
  action: string;
  disabled?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  error?: string;
}) {
  const buttons = (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" size="sm" disabled={disabled} onClick={onSubmit}>
        {action}
      </Button>
    </>
  );
  const problem = error ? (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  ) : null;

  if (!inDialog) {
    return (
      <div className={inlineClassName}>
        {children}
        {problem}
        <div className="flex justify-end gap-2">{buttons}</div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:px-5">
        {children}
      </div>
      <div className="space-y-2 border-t border-border px-4 py-3 sm:px-5">
        {problem}
        <DialogFooter className="flex-row flex-wrap items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Adds to your unsaved suite changes.
          </span>
          <div className="ml-auto flex gap-2">{buttons}</div>
        </DialogFooter>
      </div>
    </div>
  );
}
