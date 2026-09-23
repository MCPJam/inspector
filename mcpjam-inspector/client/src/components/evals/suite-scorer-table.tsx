/**
 * Evaluators as one checklist, stage by stage, in user-value-chain order.
 *
 * Configuration only. There is no Last run or Trend — those are a later
 * slice that needs run data this page does not have.
 *
 * ONE LIST, TWO PAGES. The suite settings page and a case's assertions page
 * render this same component. Each stage is a heading over rows of
 * "box · name · one line of detail"; a row's title opens its editor
 * (role, and the assertion's own fields) in place, so the resting page reads
 * like a checklist rather than a grid. The `scope` prop says which list a
 * click writes to:
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
import { cn } from "@/lib/utils";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Badge } from "@mcpjam/design-system/badge";
import { Input } from "@mcpjam/design-system/input";
import type { ModelDefinition } from "@/shared/types";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { DEFAULT_JUDGE_THRESHOLD } from "@/components/shared/session-quality/judge-config";
import { ValidatorsSection } from "./validators-section";
import { CheckRow, blankPredicate } from "./checks-section";
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
  "Requires backend support before this assertion can be changed.";

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
  headerContent,
  headerDescription,
  headerActions,
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
  headerContent?: React.ReactNode;
  headerDescription?: React.ReactNode;
  headerActions?: React.ReactNode;
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
        judgePolicy: capabilities?.judges?.goalCompletion.policy,
      }),
    [
      model,
      activeModel,
      predicates,
      rules,
      judgeConfig,
      judgeEnabled,
      capabilities?.judge,
      capabilities?.judges?.goalCompletion.policy,
    ],
  );
  const [editMode, setEditMode] = useState(false);
  const [matchEditorOpen, setMatchEditorOpen] = useState(false);
  const [judgeEditorOpen, setJudgeEditorOpen] = useState(false);
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
        return "Only standard assertions can be turned off per case. Edit this one in suite settings.";
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

  // The section title and hint are suite settings
  // furniture. A case page has its own title and reads as a plain
  // checklist: stage name on the left, boxes on the right.
  const suiteChrome = scope.kind === "suite";
  const hasMatchEditor = suiteChrome && onMatchOptionsChange !== undefined;
  const hasJudgeEditor = suiteChrome && onJudgeConfigChange !== undefined;
  const editableRowIds = table.groups.flatMap((group) =>
    group.rows.filter(rowOpensEditor).map((row) => row.id),
  );
  const showEditEvaluators =
    editableRowIds.length > 0 || hasMatchEditor || hasJudgeEditor;
  const allEditorsOpen =
    showEditEvaluators &&
    editMode &&
    (!hasMatchEditor || matchEditorOpen) &&
    (!hasJudgeEditor || judgeEditorOpen);
  const openAllEditors = () => {
    setEditMode(true);
    if (hasMatchEditor) setMatchEditorOpen(true);
    if (hasJudgeEditor) setJudgeEditorOpen(true);
  };
  const toggleAllEditors = () => {
    if (allEditorsOpen) {
      setEditMode(false);
      setMatchEditorOpen(false);
      setJudgeEditorOpen(false);
      return;
    }
    openAllEditors();
  };

  return (
    <div>
      <div data-setting-key="checks">
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-4",
            headerDescription ? "mb-2" : "mb-4",
          )}
        >
          {headerContent ??
            (suiteChrome ? (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-lg font-semibold tracking-tight text-foreground">
                    Evaluators
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  {passOrFailHint}
                </p>
              </div>
            ) : (
              <span />
            ))}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {headerActions}
            <SuiteScorerLibraryMenu
              primary
              authorableKinds={authorableKinds}
              triggerLabel="Add assertion"
              onAdd={(kind) => addPredicate(blankPredicate(kind))}
            />
          </div>
        </div>
        {headerDescription ? (
          <div className="mb-6">{headerDescription}</div>
        ) : null}
        {scenarioMigrationNotice ? (
          <div className="mb-4">{scenarioMigrationNotice}</div>
        ) : null}
        {scope.kind === "case" && scope.draft.predicates?.mode === "replace" ? (
          <p
            className="mb-4 text-xs text-muted-foreground"
            data-testid="case-replaces-suite-rules"
          >
            This case replaces the suite&apos;s assertions. Only its own are
            listed.
          </p>
        ) : null}

        <div>
          <div className="grid grid-cols-1 gap-x-6 border-b border-border pb-2 text-sm text-muted-foreground sm:grid-cols-[minmax(10rem,1fr)_2fr]">
            <span>Stage of user value chain</span>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="hidden sm:block">Evaluators</span>
              {showEditEvaluators ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="ml-auto shrink-0"
                  aria-expanded={allEditorsOpen}
                  onClick={toggleAllEditors}
                >
                  {allEditorsOpen ? "Close evaluators" : "Edit evaluators"}
                </Button>
              ) : null}
            </div>
          </div>
          {table.groups.map((group) => (
            <section
              key={group.stage}
              data-stage-group={group.stage}
              className="grid grid-cols-1 gap-x-6 gap-y-3 border-b border-border py-5 sm:grid-cols-[minmax(10rem,1fr)_2fr]"
            >
              <div>
                <h4 className="font-medium">{group.label}</h4>
              </div>
              <div className="min-w-0 space-y-3">
                {group.rows.length === 0 ? (
                  <p
                    className={cn("text-sm", STAGE_CHIP_TONE_CLASS.unmeasured)}
                    data-stage-empty={group.stage}
                  >
                    No evaluator
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {group.rows.map((row) => (
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
                        onEnabledChange={(enabled) => {
                          setRowEnabled(row, enabled);
                          openAllEditors();
                        }}
                        checkPolicy={checkPolicy}
                        judgeDisabledReason={judgeDisabledReason}
                        judgeConfig={judgeConfig}
                        expanded={editMode}
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
                    ))}
                  </ul>
                )}
                {scope.kind === "suite" &&
                onMatchOptionsChange &&
                group.stage === "selection" ? (
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
                ) : null}
                {scope.kind === "suite" &&
                onJudgeConfigChange &&
                group.stage === "userValue" ? (
                  <details
                    className="space-y-5 pt-2"
                    data-setting-key="judge"
                    data-subsection-id="judge"
                    open={judgeEditorOpen}
                    onToggle={(event) =>
                      setJudgeEditorOpen(
                        (event.currentTarget as HTMLDetailsElement).open,
                      )
                    }
                  >
                    <summary className="cursor-pointer text-xs font-medium">
                      Judge — model, criteria and gate
                    </summary>
                    <div>
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
                  </details>
                ) : null}
              </div>
            </section>
          ))}
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

/**
 * A row Edit evaluators opens. Required runner facts and match rows stay
 * closed: their settings are either absent or live in the stage's own
 * disclosure. An off check still opens — the checkbox and Edit evaluators
 * reveal every check, selected or not. The title itself is not a control.
 */
function rowOpensEditor(row: ScorerTableRow): boolean {
  return row.kind !== "observed" && row.kind !== "match";
}

function ScorerRow({
  row,
  rule,
  scope,
  onDisabledReason,
  onEnabledChange,
  checkPolicy,
  judgeDisabledReason,
  judgeConfig,
  expanded,
  editable,
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
  judgeConfig: EvalJudgeConfig | undefined;
  expanded: boolean;
  /** This page may change the row's threshold, role and body in place. */
  editable: boolean;
  onPredicateChange: (index: number, next: Predicate) => void;
  onPredicateRemove: (index: number) => void;
  onJudgeRoleChange: (role: ScorerUiRole) => void;
  onJudgeThresholdChange: (threshold: number) => void;
  facts?: React.ReactNode;
}) {
  const predicate = rule?.predicate;
  // The family name names what the box switches; a rule outside any family
  // is named by its criterion, the only name it has.
  const onLabel = row.family?.name ?? row.name;
  const title = onLabel;
  const inherited = scope === "case" && rule?.source === "suite";
  // A row that is off says only its name until its settings are opened.
  // Edit evaluators opens every check, including ones that are still off.
  const on = hasOnControl(row) ? row.enabled : true;
  // Muted text is for a row the reader cannot toggle (a required runner
  // fact, or a check this deployment will not accept). An off check they
  // can still tick stays in foreground text, so an empty box does not read
  // as disabled.
  const canToggle = hasOnControl(row) && onDisabledReason === undefined;
  // The suite page opens the judge's threshold and role; a case reads them.
  const judgeEditable =
    row.kind === "judge" &&
    row.judgeSlot === "goalCompletion" &&
    scope === "suite";
  const opensEditor = rowOpensEditor(row);
  // An off preset previews the catalog rule. A check this page owns can be
  // edited in place; everything else is shown read-only.
  const editorPredicate = row.kind === "preset" ? row.preset : predicate;
  const editorWritable =
    row.kind === "predicate" &&
    editable &&
    row.predicateIndex !== undefined;
  // Owned checks edit in place. A check that is off previews its fields
  // here, because Edit evaluators opens it before the box is ticked. An
  // inherited check that is already on keeps its number on the title line.
  const showEditorFields = Boolean(editorPredicate) && (editorWritable || !on);
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
      ? `Turns off all ${row.family.suiteRules} suite assertions of this kind for this case.`
      : null;

  // The family description is the one line under the name, on or off. The
  // configured number lives in the field, so it is not repeated here. A
  // judge has no family description; its threshold is that one line.
  let detail: string | null = null;
  if (row.kind === "judge" && row.thresholdKind === "judge") {
    detail = `Threshold ${
      judgeConfig?.goalCompletion?.threshold ?? DEFAULT_JUDGE_THRESHOLD
    }`;
  }

  return (
    <li
      data-scorer-row={row.kind}
      data-scorer-id={row.id}
      data-scorer-source={rule?.source}
      data-scorer-enabled={hasOnControl(row) ? String(row.enabled) : undefined}
      data-stage-empty={row.kind === "observed" ? row.observedStage : undefined}
      className={cn(
        "text-sm",
        canToggle ? "text-foreground" : row.muted && "text-muted-foreground",
      )}
    >
      <div className="flex items-start gap-2">
        {hasOnControl(row) ? (
          <Checkbox
            className="mt-0.5"
            aria-label={onLabel}
            checked={row.enabled}
            disabled={onDisabledReason !== undefined}
            onCheckedChange={(next) => onEnabledChange(next === true)}
          />
        ) : row.kind === "observed" || row.kind === "match" ? (
          <Checkbox className="mt-0.5" aria-label={title} checked disabled />
        ) : (
          <span aria-hidden className="mt-0.5 inline-block size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <div className="min-w-0 flex-1">
              <span>{title}</span>
              {row.family && row.family.label !== title ? (
                <span className="block text-xs text-muted-foreground">
                  {row.family.label}
                </span>
              ) : null}
              {on && detail ? (
                <span className="block text-xs text-muted-foreground">
                  {detail}
                </span>
              ) : null}
            </div>
            {row.kind === "observed" || row.kind === "match" ? (
              <Badge variant="outline">Required</Badge>
            ) : null}
          </div>
          {sourceLine ? (
            <span className="block text-xs text-muted-foreground">
              {sourceLine}
            </span>
          ) : null}
          {familyLine ? (
            <span className="block text-xs text-muted-foreground">
              {familyLine}
            </span>
          ) : null}
          {onDisabledReason ? (
            <span
              className="block text-xs text-muted-foreground"
              data-testid="on-disabled-reason"
            >
              {onDisabledReason}
            </span>
          ) : null}
          {row.kind === "observed" && facts ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                How this stage is decided
              </summary>
              <div className="mt-2">{facts}</div>
            </details>
          ) : null}
        </div>
      </div>
      {expanded && opensEditor ? (
        <div
          className="ml-6 mt-2 space-y-3 rounded-md border border-border/50 bg-muted/10 p-3"
          data-scorer-editor={row.id}
        >
          <RoleCell
            row={row}
            predicate={predicate}
            checkPolicy={checkPolicy}
            judgeDisabledReason={judgeDisabledReason}
            judgeEditable={judgeEditable}
            editable={editable}
            onPredicateChange={onPredicateChange}
            onJudgeRoleChange={onJudgeRoleChange}
          />
          {judgeEditable && row.thresholdKind === "judge" ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Threshold
              <JudgeThresholdInput
                judgeConfig={judgeConfig}
                onJudgeThresholdChange={onJudgeThresholdChange}
              />
            </label>
          ) : null}
          {showEditorFields && editorPredicate ? (
            <CheckRow
              noun="assertion"
              embedded
              readOnly={!editorWritable}
              predicate={editorPredicate}
              onChange={(next) => {
                if (editorWritable && row.predicateIndex !== undefined) {
                  onPredicateChange(row.predicateIndex, next);
                }
              }}
              onRemove={
                editorWritable && row.predicateIndex !== undefined
                  ? () => onPredicateRemove(row.predicateIndex!)
                  : undefined
              }
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The judge's threshold. Every other number an evaluator turns on is edited in
 * its own `CheckRow` body, opened from the row's title.
 */
function JudgeThresholdInput({
  judgeConfig,
  onJudgeThresholdChange,
}: {
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeThresholdChange: (threshold: number) => void;
}) {
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

function RoleCell({
  row,
  predicate,
  checkPolicy,
  judgeDisabledReason,
  judgeEditable,
  editable,
  onPredicateChange,
  onJudgeRoleChange,
}: {
  row: ScorerTableRow;
  predicate: Predicate | undefined;
  checkPolicy: boolean;
  judgeDisabledReason: string | undefined;
  /** The suite page edits the judge's role; a case only reads it. */
  judgeEditable: boolean;
  /** This page owns the assertion; an inherited one reads its role. */
  editable: boolean;
  onPredicateChange: (index: number, next: Predicate) => void;
  onJudgeRoleChange: (role: ScorerUiRole) => void;
}) {
  if (row.kind === "observed") return null;
  if (row.kind === "match") {
    return <RoleChip role="required" />;
  }
  if (row.kind === "preset") {
    return <RoleChip role={row.role} />;
  }
  if (row.kind === "judge") {
    if (row.judgeSlot === "groundedness" || !judgeEditable) {
      return <RoleChip role={row.role} />;
    }
    const requiredEnabled = judgeDisabledReason === undefined;
    // Two segments unconditionally. The judge-severity capability used to
    // decide whether a third segment, Warn, could be offered; with Warn and
    // Report collapsed into Advisory there is no third tier for it to gate.
    const roles: ScorerUiRole[] = ["required", "advisory"];
    return (
      <div className="space-y-1">
        <RoleSegmentGroup
          value={row.role}
          roles={roles}
          disabledRoles={requiredEnabled ? undefined : ["required"]}
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
  if (
    row.kind === "predicate" &&
    predicate &&
    row.predicateIndex !== undefined
  ) {
    if (!editable) {
      return <RoleChip role={row.role} />;
    }
    if (!checkPolicy) {
      // Read-only, but honest: an SDK- or CLI-authored advisory check still
      // reads Advisory here rather than being relabelled Required — and the
      // chip says why it is not a control.
      return <RoleChip role={row.role} note={BACKEND_SUPPORT_HINT} />;
    }
    // Observations get one segment, the same way groundedness does: a
    // heuristic must not decide a release, and offering a Required the schema
    // is going to refuse is a control that lies.
    return (
      <RoleSegmentGroup
        value={row.role}
        // An observation is a heuristic, so it is offered as Advisory only and
        // never as Required — the same rule the Zod schema enforces at the
        // save, surfaced as an absent segment rather than a refused save.
        roles={rolesForPredicateKind(predicate.type)}
        ariaLabel="Assertion role"
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
