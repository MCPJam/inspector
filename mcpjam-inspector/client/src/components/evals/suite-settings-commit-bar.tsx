import { Button } from "@mcpjam/design-system/button";

/** Sticky draft status with direct save and discard actions. */
export function SuiteSettingsCommitBar({
  changeCount,
  conflictCount,
  canCommit,
  isCommitting,
  onDiscard,
  onSave,
  revisionNumber,
  blockingErrors,
}: {
  changeCount: number;
  conflictCount: number;
  canCommit: boolean;
  isCommitting: boolean;
  onDiscard: () => void;
  onSave: () => void;
  revisionNumber?: number;
  blockingErrors?: Array<{ message: string; onFix: () => void }>;
}) {
  if (changeCount === 0) return null;
  const status =
    revisionNumber === undefined
      ? changeCount === 1
        ? "1 unsaved change"
        : `${changeCount} unsaved changes`
      : changeCount === 1
        ? `1 setting changed since r${revisionNumber}`
        : `${changeCount} settings changed since r${revisionNumber}`;
  return (
    <div
      data-testid="suite-settings-commit-bar"
      className="sticky bottom-0 z-10 -mx-6 mt-4 flex items-center justify-between gap-3 border-t border-border bg-background px-6 py-3"
    >
      {/* The live region is the TEXT, not the bar. Announcing the whole bar
          would re-read Discard and Save settings every time the count
          changes, and interactive controls inside a live region is its own
          anti-pattern. `role="status"` already implies polite. */}
      <div className="min-w-0">
        <p role="status" className="sr-only">
          {status}
        </p>
        {conflictCount > 0 ? (
          <p className="mt-0.5 text-[11px] text-warning-foreground">
            {conflictCount === 1
              ? "1 setting changed elsewhere while you were editing"
              : `${conflictCount} settings changed elsewhere while you were editing`}
          </p>
        ) : null}
        {!canCommit && blockingErrors && blockingErrors.length > 0 ? (
          <p className="mt-0.5 text-[11px] text-destructive">
            Fix {blockingErrors.length} error
            {blockingErrors.length === 1 ? "" : "s"} to save ·{" "}
            {blockingErrors[0].message}{" "}
            <button
              type="button"
              className="underline"
              onClick={blockingErrors[0].onFix}
            >
              Fix
            </button>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          disabled={isCommitting}
        >
          Discard
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={!canCommit || isCommitting}
        >
          {isCommitting ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
