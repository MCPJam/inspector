/**
 * Scorers as one table, in user-value-chain order.
 *
 * Configuration only. There is no Last run or Trend column — those are a
 * later slice that needs run data this page does not have.
 *
 * ONE TABLE, TWO PAGES. The suite settings page and a case's checks page
 * render this same component. The `scope` prop says which list a click
 * writes to:
 *
 *   - `suite`: every rule is the suite's. Off removes it; a preset row
 *     switched on appends the standard check's preset.
 *   - `case`: the suite's rules are listed first as inherited — read-only,
 *     and switchable off only as a whole standard-check family, which is
 *     the one suppression the backend stores. The case's own rules follow
 *     and edit like the suite's. A preset row switched on authors a case
 *     rule, moving an inheriting case to `extend`.
 *
 * Every stage also lists the standard checks nothing authors yet, off, with
 * the preset's criterion and role — so "what could I turn on here" is read
 * in the same place as "what is on".
 */

import { useMemo, useState } from "react";
import { type UserValueStage } from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import { STAGE_CHIP_TONE_CLASS } from "@/components/evaluate/stage-chain-model";
import { StageChainCards } from "@/components/evaluate/stage-chain-cards";
import { cn } from "@/lib/utils";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Input } from "@mcpjam/design-system/input";
import type { ModelDefinition } from "@/shared/types";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { DEFAULT_JUDGE_THRESHOLD } from "@/components/shared/session-quality/judge-config";
import { hasJudgeSeverityCapability } from "@/hooks/use-suite-capabilities";
import { ValidatorsSection } from "./validators-section";
import { CheckRow, blankPredicate } from "./checks-section";
import { GlobalGatesSectionInfoHint } from "./global-gates-info";
import { gateSwitchDisabledReason } from "./judge-gate-panel";
import { SuiteScorerLibraryMenu } from "./suite-scorer-library-menu";
import {
  SuiteJudgeCard,
  type GroundednessRunEvidence,
} from "./suite-judge-card";
import {
  authorablePredicateKinds,
  buildScorerTable,
  withGoalCompletionRole,
  withPredicateRole,
  type ScorerTableRow,
  type ScorerUiRole,
} from "./suite-scorer-table-model";
import { RoleChip, RoleSegmentGroup } from "./scorer-role-control";
import { groupGradersByStage, judgeMode } from "./suite-grading-model";
import { rolesForPredicateKind } from "@/shared/predicate-kinds";
import type { EvalJudgeConfig } from "./types";
import {
  addCaseRule,
  listEffectiveRules,
  removeCaseRule,
  setSuiteFamilySuppressed,
  standardCheckOfKind,
  toggleCaseStandardCheck,
  toggleSuiteStandardCheck,
  updateCaseRule,
  type EffectiveRule,
  type StandardCheckDraft,
} from "./standard-checks-model";

export type ScorerTableScope =
  | {
      kind: "suite";
      predicates: Predicate[];
      onPredicatesChange: (
        next: Predicate[] | ((previous: Predicate[]) => Predicate[]),
      ) => void;
    }
  | {
      kind: "case";
      suitePredicates: Predicate[];
      draft: StandardCheckDraft;
      onDraftChange: (next: StandardCheckDraft) => void;
      judgeSkipped: boolean;
      onJudgeSkippedChange: (skipped: boolean) => void;
    };

/** The one sentence a disabled On box gives when the deployment is behind. */
export const BACKEND_SUPPORT_HINT =
  "Requires backend support before this check can be changed.";

export function SuiteScorerTable({
  scope,
  matchOptions,
  onMatchOptionsChange,
  judgeConfig,
  onJudgeConfigChange,
  availableModels = [],
  scenarioMigrationNotice,
  judgeAccessory,
  rubricEditor,
  stageFacts,
  capabilities,
  unavailableReason,
  passOrFailHint,
  judgeHint,
  groundednessEvidence,
}: {
  scope: ScorerTableScope;
  matchOptions?: EvalMatchOptions;
  /** Suite scope only: the match editor is the suite's. */
  onMatchOptionsChange?: (next: EvalMatchOptions | undefined) => void;
  judgeConfig: EvalJudgeConfig | undefined;
  /** Suite scope only: a case reads the judge's config and may only skip it. */
  onJudgeConfigChange?: (next: EvalJudgeConfig | undefined) => void;
  availableModels?: ModelDefinition[];
  scenarioMigrationNotice?: React.ReactNode;
  judgeAccessory?: React.ReactNode;
  rubricEditor?: React.ReactNode;
  stageFacts?: Partial<Record<UserValueStage, React.ReactNode>>;
  capabilities?: SuiteCapabilities | null;
  unavailableReason?: string;
  passOrFailHint: string;
  judgeHint: string;
  groundednessEvidence?: GroundednessRunEvidence;
}) {
  const suitePredicates =
    scope.kind === "suite" ? scope.predicates : scope.suitePredicates;
  const draft = scope.kind === "case" ? scope.draft : undefined;
  const rules = useMemo(
    () => listEffectiveRules(suitePredicates, draft),
    [suitePredicates, draft],
  );
  const predicates = useMemo(
    () => rules.map((rule) => rule.predicate),
    [rules],
  );
  const activePredicates = useMemo(
    () =>
      rules.filter((rule) => !rule.suppressed).map((rule) => rule.predicate),
    [rules],
  );
  const model = useMemo(
    () => groupGradersByStage({ matchOptions, predicates, judgeConfig }),
    [matchOptions, predicates, judgeConfig],
  );
  const activeModel = useMemo(
    () =>
      groupGradersByStage({
        matchOptions,
        predicates: activePredicates,
        judgeConfig,
      }),
    [matchOptions, activePredicates, judgeConfig],
  );
  const judgeEnabled = scope.kind === "case" ? !scope.judgeSkipped : undefined;
  const table = useMemo(
    () =>
      buildScorerTable({
        model,
        activeModel,
        predicates,
        rules,
        judgeConfig,
        judgeEnabled,
        judgeCapabilities: capabilities?.judge,
      }),
    [
      model,
      activeModel,
      predicates,
      rules,
      judgeConfig,
      judgeEnabled,
      capabilities?.judge,
    ],
  );
  const [selected, setSelected] = useState<UserValueStage | null>(null);
  const [expandedPredicate, setExpandedPredicate] = useState<number | null>(
    null,
  );
  const [matchEditorOpen, setMatchEditorOpen] = useState(false);
  const checkPolicy = capabilities?.scorers?.checkPolicy === true;
  const authorableKinds = authorablePredicateKinds(
    capabilities?.scorers?.predicateKinds,
  );
  const suppressionSupported =
    capabilities?.scorers?.suppressedSuiteStandardCheckIds === true;
  const judgeDisabledReason = gateSwitchDisabledReason(
    capabilities?.judge,
    unavailableReason,
  );
  const judgeSeveritySupported = hasJudgeSeverityCapability(capabilities);

  /** A rule this page may edit in place: its own list, not an inherited one. */
  const editable = (rule: EffectiveRule | undefined) =>
    rule !== undefined && !rule.suppressed && rule.source === scope.kind;

  const updatePredicate = (index: number, next: Predicate) => {
    const rule = rules[index];
    if (!editable(rule)) return;
    if (scope.kind === "suite") {
      scope.onPredicatesChange((previous) => {
        const copy = previous.slice();
        copy[rule.index] = next;
        return copy;
      });
    } else {
      scope.onDraftChange(updateCaseRule(scope.draft, rule.index, next));
    }
  };
  const removePredicate = (index: number) => {
    const rule = rules[index];
    if (!editable(rule)) return;
    if (scope.kind === "suite") {
      scope.onPredicatesChange((previous) => {
        const copy = previous.slice();
        copy.splice(rule.index, 1);
        return copy;
      });
    } else {
      scope.onDraftChange(removeCaseRule(scope.draft, rule.index));
    }
    setExpandedPredicate(null);
  };
  const addPredicate = (predicate: Predicate) => {
    if (scope.kind === "suite") {
      scope.onPredicatesChange((previous) => [...previous, predicate]);
    } else {
      scope.onDraftChange(addCaseRule(scope.draft, predicate));
    }
  };

  /**
   * The On column, per row kind.
   *
   * A preset switches on by authoring its preset where this page writes. A
   * rule switches off by removal when this page owns it, and by family
   * suppression when it is inherited. The judge row is the suite's
   * `enabled` flag, or the case's skip flag.
   */
  const onDisabledReason = (row: ScorerTableRow): string | undefined => {
    if (row.kind === "preset") {
      return row.preset && !authorableKinds.includes(row.preset.type)
        ? BACKEND_SUPPORT_HINT
        : undefined;
    }
    if (row.kind === "predicate" && scope.kind === "case") {
      const rule =
        row.predicateIndex !== undefined
          ? rules[row.predicateIndex]
          : undefined;
      if (rule?.source !== "suite") return undefined;
      if (!row.family) {
        return "Only standard checks can be turned off per case. Edit this rule in suite settings.";
      }
      return suppressionSupported ? undefined : BACKEND_SUPPORT_HINT;
    }
    if (
      row.kind === "judge" &&
      row.judgeSlot === "goalCompletion" &&
      scope.kind === "case"
    ) {
      // A case can skip a judge that runs, never switch on one the suite
      // turned off.
      return judgeMode(judgeConfig) === "off"
        ? "The suite's judge is off."
        : undefined;
    }
    return undefined;
  };
  const setRowEnabled = (row: ScorerTableRow, enabled: boolean) => {
    if (row.kind === "preset") {
      if (!enabled || !row.preset) return;
      const check = standardCheckOfKind(row.preset.type);
      if (!check) return;
      if (scope.kind === "suite") {
        scope.onPredicatesChange((previous) =>
          toggleSuiteStandardCheck(previous, check, true),
        );
      } else {
        scope.onDraftChange(
          toggleCaseStandardCheck(
            scope.suitePredicates,
            scope.draft,
            check,
            true,
          ),
        );
      }
      return;
    }
    if (row.kind === "predicate" && row.predicateIndex !== undefined) {
      const rule = rules[row.predicateIndex];
      if (!rule) return;
      if (rule.source === scope.kind) {
        if (!enabled) removePredicate(row.predicateIndex);
        return;
      }
      if (scope.kind === "case" && row.family) {
        scope.onDraftChange(
          setSuiteFamilySuppressed(scope.draft, row.family.id, !enabled),
        );
      }
      return;
    }
    if (row.kind === "judge" && row.judgeSlot === "goalCompletion") {
      if (scope.kind === "case") {
        scope.onJudgeSkippedChange(!enabled);
        return;
      }
      onJudgeConfigChange?.({
        ...judgeConfig,
        goalCompletion: { ...(judgeConfig?.goalCompletion ?? {}), enabled },
      });
    }
  };

  return (
    <div>
      <StageChainCards
        cards={table.cards}
        selected={selected}
        onSelect={(stage) =>
          setSelected((current) => (current === stage ? null : stage))
        }
      />

      <div className="mt-6" data-setting-key="checks">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-lg font-semibold tracking-tight text-foreground">
                Scorers
              </h3>
              <GlobalGatesSectionInfoHint />
            </div>
            <p className="text-sm text-muted-foreground">{passOrFailHint}</p>
          </div>
          <SuiteScorerLibraryMenu
            authorableKinds={authorableKinds}
            onAdd={(kind) => addPredicate(blankPredicate(kind))}
          />
        </div>
        {scenarioMigrationNotice ? (
          <div className="mb-4">{scenarioMigrationNotice}</div>
        ) : null}
        {scope.kind === "case" && scope.draft.predicates?.mode === "replace" ? (
          <p
            className="mb-4 text-xs text-muted-foreground"
            data-testid="case-replaces-suite-rules"
          >
            This case replaces the suite&apos;s rules. Only its own are listed.
          </p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                <th className="w-8 py-2 pr-2 font-medium">On</th>
                <th className="py-2 pr-3 font-medium">Scorer</th>
                <th className="py-2 pr-3 font-medium">Kind</th>
                <th className="py-2 pr-3 font-medium">Threshold</th>
                <th className="py-2 font-medium">Role</th>
              </tr>
            </thead>
            {table.groups.map((group) => (
              <tbody
                key={group.stage}
                data-stage-group={group.stage}
                data-selected={selected === group.stage ? "true" : undefined}
                className={cn(
                  selected === group.stage &&
                    "bg-muted/40 ring-1 ring-foreground/20",
                )}
              >
                <tr>
                  <th colSpan={5} className="pb-1 pt-5 text-left font-normal">
                    <div className="space-y-0.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[10px] tabular-nums text-muted-foreground/70">
                          {group.ordinal}
                        </span>
                        <span className="text-sm font-semibold text-foreground">
                          {group.label}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {group.question}
                      </p>
                    </div>
                  </th>
                </tr>
                {group.rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className={cn(
                        "pb-3 text-sm",
                        STAGE_CHIP_TONE_CLASS.unmeasured,
                      )}
                      data-stage-empty={group.stage}
                    >
                      No grader
                    </td>
                  </tr>
                ) : (
                  group.rows.map((row) => (
                    <ScorerRow
                      key={row.id}
                      row={row}
                      rule={
                        row.predicateIndex !== undefined
                          ? rules[row.predicateIndex]
                          : undefined
                      }
                      scope={scope.kind}
                      onDisabledReason={onDisabledReason(row)}
                      onEnabledChange={(enabled) => setRowEnabled(row, enabled)}
                      checkPolicy={checkPolicy}
                      judgeDisabledReason={judgeDisabledReason}
                      judgeSeveritySupported={judgeSeveritySupported}
                      judgeConfig={judgeConfig}
                      expanded={
                        row.predicateIndex !== undefined &&
                        expandedPredicate === row.predicateIndex
                      }
                      onToggleExpand={() => {
                        if (row.predicateIndex === undefined) return;
                        setExpandedPredicate((current) =>
                          current === row.predicateIndex
                            ? null
                            : row.predicateIndex ?? null,
                        );
                      }}
                      editable={
                        row.predicateIndex !== undefined &&
                        editable(rules[row.predicateIndex])
                      }
                      onPredicateChange={updatePredicate}
                      onPredicateRemove={removePredicate}
                      onJudgeRoleChange={(role) => {
                        onJudgeConfigChange?.({
                          ...judgeConfig,
                          goalCompletion: withGoalCompletionRole(
                            judgeConfig?.goalCompletion ?? {},
                            role,
                          ),
                        });
                      }}
                      onJudgeThresholdChange={(threshold) => {
                        onJudgeConfigChange?.({
                          ...judgeConfig,
                          goalCompletion: {
                            ...(judgeConfig?.goalCompletion ?? {}),
                            threshold,
                          },
                        });
                      }}
                      facts={
                        row.kind === "observed"
                          ? stageFacts?.[group.stage]
                          : undefined
                      }
                    />
                  ))
                )}
                {scope.kind === "suite" &&
                onMatchOptionsChange &&
                group.stage === "selection" ? (
                  <tr>
                    <td colSpan={5} className="pb-3 pt-1">
                      <details
                        className="rounded-md border border-border/50 bg-muted/10 px-3 py-2"
                        data-setting-key="matchOptions"
                        open={matchEditorOpen}
                        onToggle={(event) =>
                          setMatchEditorOpen(
                            (event.currentTarget as HTMLDetailsElement).open,
                          )
                        }
                      >
                        <summary className="cursor-pointer text-xs font-medium text-foreground">
                          Edit tool-call matching
                        </summary>
                        <div className="mt-3 space-y-2">
                          <p className="text-[11px] text-muted-foreground">
                            Arguments is edited here and measured at Tool call.
                          </p>
                          <ValidatorsSection
                            title=""
                            value={matchOptions}
                            inheritedFrom={MATCH_OPTIONS_DEFAULTS}
                            onChange={onMatchOptionsChange}
                          />
                        </div>
                      </details>
                    </td>
                  </tr>
                ) : null}
                {scope.kind === "suite" &&
                onJudgeConfigChange &&
                group.stage === "userValue" ? (
                  <tr>
                    <td colSpan={5} className="pb-3 pt-1">
                      <div
                        className="space-y-5"
                        data-setting-key="judge"
                        data-subsection-id="judge"
                      >
                        <div>
                          <h4 className="text-sm font-semibold text-foreground">
                            Judge
                          </h4>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {judgeHint}
                          </p>
                        </div>
                        <SuiteJudgeCard
                          slot="goalCompletion"
                          judgeConfig={judgeConfig}
                          onJudgeConfigChange={onJudgeConfigChange}
                          availableModels={availableModels}
                          judgesCapabilities={capabilities?.judges}
                          judgeAccessory={judgeAccessory}
                          rubricEditor={rubricEditor}
                        />
                        <SuiteJudgeCard
                          slot="groundedness"
                          judgeConfig={judgeConfig}
                          onJudgeConfigChange={onJudgeConfigChange}
                          availableModels={availableModels}
                          judgesCapabilities={capabilities?.judges}
                          groundednessEvidence={groundednessEvidence}
                        />
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </div>
  );
}

/** Whether a row has an On box at all. Observed and match rows are facts. */
function hasOnControl(row: ScorerTableRow): boolean {
  if (row.kind === "predicate" || row.kind === "preset") return true;
  return row.kind === "judge" && row.judgeSlot === "goalCompletion";
}

function ScorerRow({
  row,
  rule,
  scope,
  onDisabledReason,
  onEnabledChange,
  checkPolicy,
  judgeDisabledReason,
  judgeSeveritySupported,
  judgeConfig,
  expanded,
  editable,
  onToggleExpand,
  onPredicateChange,
  onPredicateRemove,
  onJudgeRoleChange,
  onJudgeThresholdChange,
  facts,
}: {
  row: ScorerTableRow;
  rule: EffectiveRule | undefined;
  scope: ScorerTableScope["kind"];
  onDisabledReason: string | undefined;
  onEnabledChange: (enabled: boolean) => void;
  checkPolicy: boolean;
  judgeDisabledReason: string | undefined;
  judgeSeveritySupported: boolean;
  judgeConfig: EvalJudgeConfig | undefined;
  expanded: boolean;
  /** This page may change the row's threshold, role and body in place. */
  editable: boolean;
  onToggleExpand: () => void;
  onPredicateChange: (index: number, next: Predicate) => void;
  onPredicateRemove: (index: number) => void;
  onJudgeRoleChange: (role: ScorerUiRole) => void;
  onJudgeThresholdChange: (threshold: number) => void;
  facts?: React.ReactNode;
}) {
  const predicate = rule?.predicate;
  // The family label names what the box switches; a rule outside any family
  // is named by its criterion, the only name it has.
  const onLabel = row.family?.label ?? row.name;
  const inherited = scope === "case" && rule?.source === "suite";
  const sourceLine =
    scope === "case" && row.kind === "predicate"
      ? row.suppressed
        ? "From suite · off for this case"
        : inherited
          ? "From suite"
          : "This case"
      : null;
  const familyLine =
    inherited && row.family && row.family.suiteRules > 1
      ? `Turns off all ${row.family.suiteRules} suite rules of this kind for this case.`
      : null;

  return (
    <>
      <tr
        className={cn(
          "border-b border-border/40 align-top",
          row.muted && "text-muted-foreground",
        )}
        data-scorer-row={row.kind}
        data-scorer-id={row.id}
        data-scorer-source={rule?.source}
        data-scorer-enabled={
          hasOnControl(row) ? String(row.enabled) : undefined
        }
      >
        <td className="py-2 pr-2">
          {hasOnControl(row) ? (
            <Checkbox
              className="mt-0.5"
              aria-label={onLabel}
              checked={row.enabled}
              disabled={onDisabledReason !== undefined}
              onCheckedChange={(next) => onEnabledChange(next === true)}
            />
          ) : null}
        </td>
        <td className="py-2 pr-3">
          {row.kind === "predicate" && editable ? (
            <button
              type="button"
              className="text-left text-xs text-foreground hover:underline"
              onClick={onToggleExpand}
              aria-expanded={expanded}
            >
              {row.family ? row.family.label : row.name}
            </button>
          ) : (
            <span
              className="text-xs"
              data-stage-empty={
                row.kind === "observed" ? row.observedStage : undefined
              }
            >
              {row.family ? row.family.label : row.name}
            </span>
          )}
          {row.family ? (
            <span className="block text-[11px] text-muted-foreground">
              {row.name}
            </span>
          ) : null}
          {sourceLine ? (
            <span className="block text-[11px] text-muted-foreground">
              {sourceLine}
            </span>
          ) : null}
          {familyLine ? (
            <span className="block text-[11px] text-muted-foreground">
              {familyLine}
            </span>
          ) : null}
          {onDisabledReason ? (
            <span
              className="block text-[11px] text-muted-foreground"
              data-testid="on-disabled-reason"
            >
              {onDisabledReason}
            </span>
          ) : null}
          {row.kind === "observed" && facts ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                How this stage is decided
              </summary>
              <div className="mt-2">{facts}</div>
            </details>
          ) : null}
        </td>
        <td className="py-2 pr-3 text-muted-foreground">{row.kindLabel}</td>
        <td className="py-2 pr-3">
          {editable || (row.kind === "judge" && scope === "suite") ? (
            <ThresholdCell
              row={row}
              predicate={predicate}
              judgeConfig={judgeConfig}
              onPredicateChange={onPredicateChange}
              onJudgeThresholdChange={onJudgeThresholdChange}
            />
          ) : row.threshold ? (
            <span className="tabular-nums text-muted-foreground">
              {row.threshold}
            </span>
          ) : null}
        </td>
        <td className="py-2">
          {editable || row.kind !== "predicate" ? (
            <RoleCell
              row={row}
              predicate={predicate}
              checkPolicy={checkPolicy}
              judgeDisabledReason={judgeDisabledReason}
              judgeSeveritySupported={judgeSeveritySupported}
              judgeEditable={scope === "suite"}
              onPredicateChange={onPredicateChange}
              onJudgeRoleChange={onJudgeRoleChange}
            />
          ) : (
            <RoleChip role={row.role} />
          )}
        </td>
      </tr>
      {expanded && editable && predicate && row.predicateIndex !== undefined ? (
        <tr className="border-b border-border/40">
          <td colSpan={5} className="pb-3 pt-1">
            <CheckRow
              embedded
              predicate={predicate}
              onChange={(next) => onPredicateChange(row.predicateIndex!, next)}
              onRemove={() => onPredicateRemove(row.predicateIndex!)}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ThresholdCell({
  row,
  predicate,
  judgeConfig,
  onPredicateChange,
  onJudgeThresholdChange,
}: {
  row: ScorerTableRow;
  predicate: Predicate | undefined;
  judgeConfig: EvalJudgeConfig | undefined;
  onPredicateChange: (index: number, next: Predicate) => void;
  onJudgeThresholdChange: (threshold: number) => void;
}) {
  if (row.thresholdKind === "none") return null;
  if (row.thresholdKind === "fixed") {
    return <span className="tabular-nums text-muted-foreground">1</span>;
  }
  if (row.thresholdKind === "judge") {
    const value =
      judgeConfig?.goalCompletion?.threshold ?? DEFAULT_JUDGE_THRESHOLD;
    return (
      <Input
        type="number"
        min={0}
        max={1}
        step={0.05}
        value={value}
        aria-label="Judge threshold"
        className="h-7 w-20 text-xs"
        onChange={(event) => {
          // `Number("")` is 0. An emptied field is someone retyping, not a
          // threshold of zero — which on a gating judge would pass any score.
          const raw = event.target.value.trim();
          if (raw === "") return;
          const next = Number(raw);
          if (!Number.isFinite(next)) return;
          onJudgeThresholdChange(Math.min(1, Math.max(0, next)));
        }}
      />
    );
  }
  if (
    row.thresholdKind === "budget" &&
    predicate &&
    row.predicateIndex !== undefined
  ) {
    if (predicate.type === "tokenBudgetUnder") {
      return (
        <Input
          type="number"
          min={1}
          step={1}
          value={predicate.tokens}
          aria-label="Token budget"
          className="h-7 w-24 text-xs"
          onChange={(event) => {
            // An emptied or non-positive field is mid-edit, not a ceiling of
            // zero — which the suite-file schema refuses, disabling Save with
            // nothing on screen to explain it.
            const raw = event.target.value.trim();
            if (raw === "") return;
            const next = Number(raw);
            if (!Number.isFinite(next) || next < 1) return;
            onPredicateChange(row.predicateIndex!, {
              ...predicate,
              tokens: Math.floor(next),
            });
          }}
        />
      );
    }
    if (
      predicate.type === "toolDescriptionsPresent" ||
      predicate.type === "toolLatencyUnder" ||
      predicate.type === "toolResultSizeUnder" ||
      predicate.type === "toolCallCountUnder"
    ) {
      const { field, value, label } =
        predicate.type === "toolDescriptionsPresent"
          ? {
              field: "minLength" as const,
              value: predicate.minLength ?? 20,
              label: "Minimum tool description length",
            }
          : predicate.type === "toolLatencyUnder"
            ? { field: "ms" as const, value: predicate.ms, label: "Tool latency budget in ms" }
            : predicate.type === "toolResultSizeUnder"
            ? {
                field: "maxBytes" as const,
                value: predicate.maxBytes,
                label: "Tool result size budget in bytes",
              }
            : {
                field: "count" as const,
                value: predicate.count,
                label: "Tool call budget",
              };
      return (
        <Input
          type="number"
          min={1}
          step={1}
          value={value}
          aria-label={label}
          className="h-7 w-24 text-xs"
          onChange={(event) => {
            // An empty field is `Number("") === 0`, and a budget of 0 is a
            // check nothing can pass — the same reason the backend now
            // refuses a non-positive `tokens` or `minCount` at the write
            // boundary. Leave the predicate alone until the field holds a
            // usable number, exactly as the token and turn budgets do.
            const raw = event.target.value.trim();
            if (raw === "") return;
            const next = Number(raw);
            if (!Number.isFinite(next) || next < 1) return;
            onPredicateChange(row.predicateIndex!, {
              ...predicate,
              [field]: Math.floor(next),
            } as Predicate);
          }}
        />
      );
    }
    if (predicate.type === "turnCountUnder") {
      return (
        <Input
          type="number"
          min={1}
          step={1}
          value={predicate.turns}
          aria-label="Turn budget"
          className="h-7 w-24 text-xs"
          onChange={(event) => {
            const raw = event.target.value.trim();
            if (raw === "") return;
            const next = Number(raw);
            if (!Number.isFinite(next) || next < 1) return;
            onPredicateChange(row.predicateIndex!, {
              ...predicate,
              turns: Math.floor(next),
            });
          }}
        />
      );
    }
  }
  return <span className="tabular-nums text-muted-foreground">1</span>;
}

function RoleCell({
  row,
  predicate,
  checkPolicy,
  judgeDisabledReason,
  judgeSeveritySupported,
  judgeEditable,
  onPredicateChange,
  onJudgeRoleChange,
}: {
  row: ScorerTableRow;
  predicate: Predicate | undefined;
  checkPolicy: boolean;
  judgeDisabledReason: string | undefined;
  judgeSeveritySupported: boolean;
  /** The suite page edits the judge's role; a case only reads it. */
  judgeEditable: boolean;
  onPredicateChange: (index: number, next: Predicate) => void;
  onJudgeRoleChange: (role: ScorerUiRole) => void;
}) {
  if (row.kind === "observed") return null;
  if (row.kind === "match") {
    return <RoleChip role="gate" />;
  }
  if (row.kind === "preset") {
    return <RoleChip role={row.role} />;
  }
  if (row.kind === "judge") {
    if (row.judgeSlot === "groundedness" || !judgeEditable) {
      return <RoleChip role={row.role} />;
    }
    const gateEnabled = judgeDisabledReason === undefined;
    const roles: ScorerUiRole[] = judgeSeveritySupported
      ? ["gate", "warn", "report"]
      : ["gate", "report"];
    return (
      <div className="space-y-1">
        <RoleSegmentGroup
          value={row.role}
          roles={roles}
          disabledRoles={gateEnabled ? undefined : ["gate"]}
          ariaLabel="Judge role"
          onChange={onJudgeRoleChange}
        />
        {judgeDisabledReason ? (
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="judge-gate-disabled-reason"
          >
            {judgeDisabledReason}
          </p>
        ) : null}
      </div>
    );
  }
  if (row.kind === "predicate" && predicate && row.predicateIndex !== undefined) {
    if (!checkPolicy) {
      // Read-only, but honest: an SDK- or CLI-authored advisory check still
      // reads Warn/Report here rather than being relabelled Gate.
      return <RoleChip role={row.role} />;
    }
    // Observations get two segments, the same way groundedness does: a
    // heuristic must not decide a release, and offering a Gate the schema is
    // going to refuse is a control that lies.
    return (
      <RoleSegmentGroup
        value={row.role}
        // An observation is a heuristic, so it is offered as Warn or Report
        // and never as a Gate — the same rule the Zod schema enforces at the
        // save, surfaced as an absent segment rather than a refused save.
        roles={rolesForPredicateKind(predicate.type)}
        ariaLabel="Check role"
        onChange={(role) =>
          onPredicateChange(
            row.predicateIndex!,
            withPredicateRole(predicate, role),
          )
        }
      />
    );
  }
  return <RoleChip role={row.role} />;
}

