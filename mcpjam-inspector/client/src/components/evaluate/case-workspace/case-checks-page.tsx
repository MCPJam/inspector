import { Button } from "@mcpjam/design-system/button";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { SuiteStageChecks } from "@/components/evals/suite-stage-checks";
import {
  toggleCaseStandardCheck,
  type StandardCheckDraft,
} from "@/components/evals/standard-checks-model";

export function CaseChecksPage({
  title,
  predicates,
  suppressedSuiteStandardCheckIds,
  suitePredicates,
  onChecksChange,
  capabilities,
  judgeSkipped,
  onJudgeSkippedChange,
  onSave,
  saveDisabled,
  onBack,
  onConfigureSuite,
}: {
  title: string;
  predicates?: CasePredicates;
  suppressedSuiteStandardCheckIds?: string[];
  suitePredicates: Predicate[];
  onChecksChange: (next: StandardCheckDraft) => void;
  capabilities?: SuiteCapabilities | null;
  judgeSkipped: boolean;
  onJudgeSkippedChange: (skipped: boolean) => void;
  onSave: () => void;
  saveDisabled: boolean;
  onBack?: () => void;
  onConfigureSuite?: () => void;
}) {
  const draft = { predicates, suppressedSuiteStandardCheckIds };
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
            <Button onClick={onSave} disabled={saveDisabled}>
              Save overrides
            </Button>
          </div>
        </div>
        <SuiteStageChecks
          suitePredicates={suitePredicates}
          caseDraft={draft}
          capabilities={capabilities}
          onToggle={(check, enabled) =>
            onChecksChange(
              toggleCaseStandardCheck(suitePredicates, draft, check, enabled),
            )
          }
          judgeSkipped={judgeSkipped}
          onJudgeSkippedChange={onJudgeSkippedChange}
          onEditRules={onBack}
        />
        {onConfigureSuite ? (
          <Button variant="outline" size="sm" onClick={onConfigureSuite}>
            Configure suite assertions
          </Button>
        ) : null}
      </div>
    </div>
  );
}
