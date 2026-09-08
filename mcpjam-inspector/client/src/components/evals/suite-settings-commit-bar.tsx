import { Button } from "@mcpjam/design-system/button";

/**
 * The sticky bar that appears once a settings draft has something in it.
 *
 * It exists because a sheet with no visible unsaved state is a sheet where the
 * only way to know whether you saved is to close it and look. The count is the
 * whole message — "3 unsaved changes" tells a person both that they have work
 * pending and roughly how much, which is what decides whether they hit Discard
 * or read the review.
 *
 * `⌘S` opens the review rather than saving, deliberately: the shortcut people
 * have in their fingers means "commit what I did", and in a sheet with a
 * review step the honest response is to show them what that is.
 */
export function SuiteSettingsCommitBar({
  changeCount,
  conflictCount,
  canCommit,
  isCommitting,
  onDiscard,
  onReview,
  revisionNumber,
  changedLabels,
  blockingErrors,
}: {
  changeCount: number;
  conflictCount: number;
  canCommit: boolean;
  isCommitting: boolean;
  onDiscard: () => void;
  onReview: () => void;
  revisionNumber?: number;
  changedLabels?: string[];
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
  const nextRevision =
    revisionNumber === undefined
      ? null
      : `${changedLabels && changedLabels.length > 0 ? `${changedLabels.join(" · ")}. ` : ""}Saving creates r${revisionNumber + 1}; runs already started keep the settings they launched with.`;
  return (
    <div
      data-testid="suite-settings-commit-bar"
      className="sticky bottom-0 z-10 -mx-6 mt-4 flex items-center justify-between gap-3 border-t border-border bg-background px-6 py-3"
    >
      {/* The live region is the TEXT, not the bar. Announcing the whole bar
          would re-read Discard and Review and save every time the count
          changes, and interactive controls inside a live region is its own
          anti-pattern. `role="status"` already implies polite. */}
      <div className="min-w-0">
        <p role="status" className="text-xs font-medium text-foreground">
          {status}
        </p>
        {nextRevision ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {nextRevision}
          </p>
        ) : null}
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
          onClick={onReview}
          disabled={!canCommit || isCommitting}
        >
          Review and save
        </Button>
      </div>
    </div>
  );
}
