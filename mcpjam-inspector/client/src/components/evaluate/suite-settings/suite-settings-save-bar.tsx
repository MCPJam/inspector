import { Button } from "@mcpjam/design-system/button";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { SuiteSettingsCommitBar } from "@/components/evals/suite-settings-commit-bar";
import { LedgerRowChips } from "@/components/evals/suite-settings-row-parts";
import type { SuiteSettingsSheet } from "@/components/evals/use-suite-settings-sheet";

/**
 * The page's one Save, handed to the crumb bar. It saves the settings draft
 * only (Settings and Default evaluators); cases save on their own pages.
 */
export function SuiteSettingsSaveBar({
  sheet,
  revisionNumber,
  onFix,
}: {
  sheet: SuiteSettingsSheet;
  revisionNumber?: number;
  /** Switch to the tab that owns the setting, then open it. */
  onFix(key: EvalSuiteSettingKey): void;
}) {
  if (sheet.editingDisabled) return null;
  const changeCount = sheet.changes.length;
  if (changeCount === 0) {
    return (
      <Button
        size="sm"
        className="h-8"
        disabled
        data-testid="suite-settings-save"
      >
        Save settings
      </Button>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="hidden sm:inline-flex">
        <LedgerRowChips dirty conflict={false} />
      </span>
      <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
        {changeCount}
      </span>
      <SuiteSettingsCommitBar
        layout="inline"
        changeCount={changeCount}
        conflictCount={sheet.draft.conflicts.length}
        canCommit={sheet.canCommit}
        isCommitting={sheet.isCommitting}
        onDiscard={sheet.discard}
        onSave={() => void sheet.commit()}
        revisionNumber={revisionNumber}
        blockingErrors={sheet.blockingErrors.map((error) => ({
          message: error.message,
          onFix: () => onFix(error.settingKey),
        }))}
      />
    </div>
  );
}
