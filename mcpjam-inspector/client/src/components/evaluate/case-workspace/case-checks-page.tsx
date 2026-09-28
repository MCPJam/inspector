/**
 * A case's checks: the suite's scorer table, in case scope.
 *
 * The same `SuiteScorerTable` the suite settings page renders, so a person
 * reads one numbered 01–06 layout on both pages. Here the suite's rules are
 * inherited — read-only, switchable off by standard-check family — and the
 * case's own rules are edited in place. The judge row is the case's
 * judge-skipped flag. Match options and the judge cards are edited on the
 * suite's page; the match rows here read the case's own resolved options,
 * because those are the ones its iterations are graded with.
 */

import { Button } from "@mcpjam/design-system/button";
import type {
  CasePredicates,
  EvalMatchOptions,
  Predicate,
} from "@/shared/eval-matching";
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
  matchOptions,
  suiteJudgeConfig,
  onChecksChange,
  capabilities,
  judgeSkipped,
  onJudgeSkippedChange,
  onConfigureSuite,
  saveStatus,
}: {
  title: string;
  predicates?: CasePredicates;
  suppressedSuiteStandardCheckIds?: string[];
  suitePredicates: Predicate[];
  /**
   * The case's match options, resolved over the suite's defaults. Absent, the
   * match rows would describe the built-in defaults, which a case that
   * overrides them is not graded with.
   */
  matchOptions?: EvalMatchOptions;
  /** Read only here: the judge row shows the suite's threshold and role. */
  suiteJudgeConfig?: EvalJudgeConfig;
  onChecksChange: (next: StandardCheckDraft) => void;
  capabilities?: SuiteCapabilities | null;
  judgeSkipped: boolean;
  onJudgeSkippedChange: (skipped: boolean) => void;
  onConfigureSuite?: () => void;
  saveStatus?: string | null;
}) {
  const draft = { predicates, suppressedSuiteStandardCheckIds };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10 sm:py-10 lg:px-12">
      <div className="mx-auto max-w-4xl space-y-6">
        <SuiteScorerTable
          headerContent={
            <h2 className="text-lg font-semibold">Test Case Evaluators</h2>
          }
          headerDescription={
            <div className="space-y-2">
              <p className="text-sm leading-relaxed text-foreground/80">
                Overrides for {title}. Step assertions are authored in the case
                flow.
              </p>
              {saveStatus ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {saveStatus}
                </p>
              ) : null}
            </div>
          }
          headerActions={
            onConfigureSuite ? (
              <Button variant="outline" size="sm" onClick={onConfigureSuite}>
                Configure suite assertions
              </Button>
            ) : null
          }
          scope={{
            kind: "case",
            suitePredicates,
            draft,
            onDraftChange: onChecksChange,
            judgeSkipped,
            onJudgeSkippedChange,
          }}
          matchOptions={matchOptions}
          judgeConfig={suiteJudgeConfig}
          capabilities={capabilities}
          passOrFailHint={PASS_OR_FAIL_HINT}
          judgeHint={JUDGE_HINT}
        />
      </div>
    </div>
  );
}
