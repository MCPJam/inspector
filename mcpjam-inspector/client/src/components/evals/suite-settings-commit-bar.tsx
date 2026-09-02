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
}: {
  changeCount: number;
  conflictCount: number;
  canCommit: boolean;
  isCommitting: boolean;
  onDiscard: () => void;
  onReview: () => void;
}) {
  if (changeCount === 0) return null;
  return (
    <div
      data-testid="suite-settings-commit-bar"
      className="sticky bottom-0 z-10 -mx-4 mt-4 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          {changeCount === 1 ? "1 unsaved change" : `${changeCount} unsaved changes`}
        </p>
        {conflictCount > 0 ? (
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-500">
            {conflictCount === 1
              ? "1 setting changed elsewhere while you were editing"
              : `${conflictCount} settings changed elsewhere while you were editing`}
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
        <Button size="sm" onClick={onReview} disabled={!canCommit || isCommitting}>
          Review and save
        </Button>
      </div>
    </div>
  );
}
