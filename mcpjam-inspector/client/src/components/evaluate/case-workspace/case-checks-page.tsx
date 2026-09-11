import { Button } from "@mcpjam/design-system/button";
import { useState } from "react";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import { SuiteStageChecks } from "@/components/evals/suite-stage-checks";

export function CaseChecksPage({
  title,
  disabledChecks,
  judgeSkipped,
  onJudgeSkippedChange,
  onSave,
  saveDisabled,
  onBack,
  onConfigureSuite,
}: {
  title: string;
  disabledChecks?: string[];
  predicates?: CasePredicates;
  suitePredicates: Predicate[];
  availableTools: string[];
  onPredicatesChange: (next: CasePredicates | undefined) => void;
  judgeSkipped: boolean;
  onJudgeSkippedChange: (skipped: boolean) => void;
  onSave: () => void;
  saveDisabled: boolean;
  onBack?: () => void;
  onConfigureSuite?: () => void;
}) {
  const suiteDisabled = disabledChecks ?? [];
  const [stageOverrides, setStageOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const effectiveDisabled = new Set(suiteDisabled);
  if (judgeSkipped) effectiveDisabled.add("userValue.outcome");
  for (const [id, enabled] of Object.entries(stageOverrides)) {
    if (enabled) effectiveDisabled.delete(id);
    else effectiveDisabled.add(id);
  }
  const hasUnsavedStageChanges = Object.keys(stageOverrides).length > 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">
              User Value Chain Assertions
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Overrides for {title}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onBack}>
              Back to case
            </Button>
            <Button
              onClick={onSave}
              disabled={saveDisabled || hasUnsavedStageChanges}
            >
              Save overrides
            </Button>
          </div>
        </div>
        <SuiteStageChecks
          disabledChecks={[...effectiveDisabled]}
          suiteDisabledChecks={suiteDisabled}
          onChange={(next) => {
            const nextDisabled = next ?? [];
            const overrides: Record<string, boolean> = {};
            for (const id of new Set([...nextDisabled, ...suiteDisabled])) {
              if (id === "userValue.outcome" && !suiteDisabled.includes(id))
                continue;
              if (nextDisabled.includes(id) !== suiteDisabled.includes(id)) {
                overrides[id] = !nextDisabled.includes(id);
              }
            }
            setStageOverrides(overrides);
            if (!suiteDisabled.includes("userValue.outcome")) {
              onJudgeSkippedChange(nextDisabled.includes("userValue.outcome"));
            }
          }}
        />
        {hasUnsavedStageChanges ? (
          <p role="status" className="text-sm text-muted-foreground">
            These stage changes are a preview. Saving them requires case-level
            stage override support in the backend.
          </p>
        ) : null}
        {onConfigureSuite ? (
          <div className="border-t border-border pt-4">
            <Button variant="outline" size="sm" onClick={onConfigureSuite}>
              Configure suite checks
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
