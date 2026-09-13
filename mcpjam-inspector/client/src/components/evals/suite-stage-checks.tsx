import { useId } from "react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  STANDARD_CHECKS,
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
} from "@mcpjam/sdk/contract";
import type { Predicate } from "@/shared/eval-matching";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { formatCriterion } from "@/shared/predicate-kinds";
import { authorablePredicateKinds } from "./suite-scorer-table-model";
import {
  standardCheckState,
  type AssertionCheck,
  type StandardCheckDraft,
} from "./standard-checks-model";

export function SuiteStageChecks({
  suitePredicates,
  caseDraft,
  onToggle,
  readOnly = false,
  capabilities,
  judgeSkipped = false,
  onJudgeSkippedChange,
  onEditRules,
}: {
  suitePredicates: Predicate[];
  caseDraft?: StandardCheckDraft;
  onToggle: (check: AssertionCheck, enabled: boolean) => void;
  readOnly?: boolean;
  capabilities?: SuiteCapabilities | null;
  judgeSkipped?: boolean;
  onJudgeSkippedChange?: (skipped: boolean) => void;
  onEditRules?: () => void;
}) {
  const titleId = useId();
  const supported = authorablePredicateKinds(
    capabilities?.scorers?.predicateKinds,
  );
  return (
    <section
      aria-labelledby={titleId}
      className="space-y-4"
    >
      <div>
        <h3 id={titleId} className="text-lg font-semibold">
          Checks by stage
        </h3>
        <p className="text-sm text-muted-foreground">
          Suite and case assertions. Each toggle covers all rules for that
          standard check. Step assertions are configured in the case flow.
        </p>
      </div>
      {USER_VALUE_STAGES.map((stage) => (
        <div
          key={stage}
          data-standard-check-stage={stage}
          className="border-b border-border pb-4"
        >
          <h4 className="mb-3 font-medium">{USER_VALUE_STAGE_LABELS[stage]}</h4>
          <ul className="space-y-3">
            {STANDARD_CHECKS.filter((check) => check.stage === stage).map(
              (check) => {
                if (check.kind === "runner")
                  return (
                    <li
                      key={check.id}
                      className="text-sm text-muted-foreground"
                    >
                      {check.label} — measured by the runner
                    </li>
                  );
                if (check.kind === "judge")
                  return (
                    <li key={check.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          aria-label={check.label}
                      checked={!judgeSkipped}
                          disabled={readOnly || !onJudgeSkippedChange}
                          onCheckedChange={(enabled) =>
                            onJudgeSkippedChange?.(enabled !== true)
                          }
                        />
                        {check.label} — judge configuration
                      </label>
                    </li>
                  );
                const state = standardCheckState(
                  check,
                  suitePredicates,
                  caseDraft,
                );
                const unsupported = !supported.includes(check.preset.type);
                const suppressionUnavailable =
                  !!caseDraft &&
                  (state.suiteCount > 0 ||
                    caseDraft.suppressedSuiteStandardCheckIds?.includes(
                      check.id,
                    )) &&
                  capabilities?.scorers?.suppressedSuiteStandardCheckIds !==
                    true;
                return (
                  <li key={check.id}>
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        aria-label={check.label}
                        checked={state.enabled}
                        disabled={
                          readOnly || unsupported || suppressionUnavailable
                        }
                        onCheckedChange={(enabled) =>
                          onToggle(check, enabled === true)
                        }
                      />
                      <span>
                        {check.label}
                        <span className="block text-xs text-muted-foreground">
                          {state.enabled
                            ? `${state.customized ? "Customized" : "Preset"} · ${state.suiteCount} suite, ${state.caseCount} case rules`
                            : "Not configured"}
                        </span>
                        {state.rules.map((rule, i) => (
                          <span
                            key={i}
                            className="block text-xs text-muted-foreground"
                          >
                            {formatCriterion({ predicate: rule })} ·{" "}
                            {rule.role === "advisory"
                              ? rule.severity === "warn"
                                ? "Warn"
                                : "Report"
                              : "Gate"}
                          </span>
                        ))}
                        {unsupported || suppressionUnavailable ? (
                          <span className="block text-xs text-muted-foreground">
                            Requires backend support before this check can be
                            changed.
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              },
            )}
          </ul>
        </div>
      ))}
      {onEditRules ? (
        <button
          type="button"
          className="text-sm underline"
          onClick={onEditRules}
        >
          Edit individual rules and criteria
        </button>
      ) : null}
    </section>
  );
}
