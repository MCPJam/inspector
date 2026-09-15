/**
 * A case's checks: the suite's scorer table, in case scope.
 *
 * The same `SuiteScorerTable` the suite settings page renders, so a person
 * reads one numbered 01–06 layout on both pages. Here the suite's rules are
 * inherited — read-only, switchable off by standard-check family — and the
 * case's own rules are edited in place. The judge row is the case's
 * judge-skipped flag. Match options and the judge cards are the suite's and
 * stay on its page.
 */

import { Button } from "@mcpjam/design-system/button";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { SuiteScorerTable } from "@/components/evals/suite-scorer-table";
import {
  JUDGE_HINT,
  PASS_OR_FAIL_HINT,
} from "@/components/evals/suite-pass-or-fail-section";
import type { StandardCheckDraft } from "@/components/evals/standard-checks-model";
import type { EvalJudgeConfig } from "@/components/evals/types";

export function CaseChecksPage({
  title,
  predicates,
  suppressedSuiteStandardCheckIds,
  suitePredicates,
  suiteJudgeConfig,
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
  /** Read only here: the judge row shows the suite's threshold and role. */
  suiteJudgeConfig?: EvalJudgeConfig;
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
              Test Case Evaluators
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Overrides for {title}. Step assertions are authored in the case
              flow.
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
        <SuiteScorerTable
          scope={{
            kind: "case",
            suitePredicates,
            draft,
            onDraftChange: onChecksChange,
            judgeSkipped,
            onJudgeSkippedChange,
          }}
          judgeConfig={suiteJudgeConfig}
          capabilities={capabilities}
          passOrFailHint={PASS_OR_FAIL_HINT}
          judgeHint={JUDGE_HINT}
        />
        {onConfigureSuite ? (
          <Button variant="outline" size="sm" onClick={onConfigureSuite}>
            Configure suite evaluators
          </Button>
        ) : null}
      </div>
    </div>
  );
}
