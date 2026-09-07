/**
 * Scorers as one table, in user-value-chain order.
 *
 * Configuration only. There is no Last run or Trend column — those are a
 * later slice that needs run data this page does not have.
 */

import { useMemo, useState } from "react";
import { type UserValueStage } from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import { STAGE_CHIP_TONE_CLASS } from "@/components/evaluate/stage-chain-model";
import { StageChainCards } from "@/components/evaluate/stage-chain-cards";
import { cn } from "@/lib/utils";
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
  ROLE_LEGEND,
  buildScorerTable,
  withGoalCompletionRole,
  withPredicateRole,
  type ScorerTableRow,
  type ScorerUiRole,
} from "./suite-scorer-table-model";
import { groupGradersByStage } from "./suite-grading-model";
import type { EvalJudgeConfig } from "./types";

export function SuiteScorerTable({
  matchOptions,
  onMatchOptionsChange,
  predicates,
  onPredicatesChange,
  judgeConfig,
  onJudgeConfigChange,
  availableModels,
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
  matchOptions: EvalMatchOptions | undefined;
  onMatchOptionsChange: (next: EvalMatchOptions | undefined) => void;
  predicates: Predicate[];
  onPredicatesChange: (
    next: Predicate[] | ((previous: Predicate[]) => Predicate[]),
  ) => void;
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeConfigChange: (next: EvalJudgeConfig | undefined) => void;
  availableModels: ModelDefinition[];
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
  const model = useMemo(
    () => groupGradersByStage({ matchOptions, predicates, judgeConfig }),
    [matchOptions, predicates, judgeConfig],
  );
  const table = useMemo(
    () =>
      buildScorerTable({
        model,
        predicates,
        judgeConfig,
        judgeCapabilities: capabilities?.judge,
      }),
    [model, predicates, judgeConfig, capabilities?.judge],
  );
  const [selected, setSelected] = useState<UserValueStage | null>(null);
  const [expandedPredicate, setExpandedPredicate] = useState<number | null>(
    null,
  );
  const [matchEditorOpen, setMatchEditorOpen] = useState(false);
  const checkPolicy = capabilities?.scorers?.checkPolicy === true;
  const judgeDisabledReason = gateSwitchDisabledReason(
    capabilities?.judge,
    unavailableReason,
  );
  const judgeSeveritySupported = hasJudgeSeverityCapability(capabilities);

  const updatePredicate = (index: number, next: Predicate) => {
    onPredicatesChange((previous) => {
      const copy = previous.slice();
      copy[index] = next;
      return copy;
    });
  };
  const removePredicate = (index: number) => {
    onPredicatesChange((previous) => {
      const copy = previous.slice();
      copy.splice(index, 1);
      return copy;
    });
    setExpandedPredicate(null);
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
            onAdd={(kind) =>
              onPredicatesChange((previous) => [
                ...previous,
                blankPredicate(kind),
              ])
            }
          />
        </div>
        {scenarioMigrationNotice ? (
          <div className="mb-4">{scenarioMigrationNotice}</div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
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
                  <th
                    colSpan={4}
                    className="pb-1 pt-5 text-left font-normal"
                  >
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
                      colSpan={4}
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
                      predicates={predicates}
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
                      onPredicateChange={updatePredicate}
                      onPredicateRemove={removePredicate}
                      onJudgeRoleChange={(role) => {
                        onJudgeConfigChange({
                          ...judgeConfig,
                          goalCompletion: withGoalCompletionRole(
                            judgeConfig?.goalCompletion ?? {},
                            role,
                          ),
                        });
                      }}
                      onJudgeThresholdChange={(threshold) => {
                        onJudgeConfigChange({
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
                {group.stage === "selection" ? (
                  <tr>
                    <td colSpan={4} className="pb-3 pt-1">
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
                {group.stage === "userValue" ? (
                  <tr>
                    <td colSpan={4} className="pb-3 pt-1">
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

function ScorerRow({
  row,
  predicates,
  checkPolicy,
  judgeDisabledReason,
  judgeSeveritySupported,
  judgeConfig,
  expanded,
  onToggleExpand,
  onPredicateChange,
  onPredicateRemove,
  onJudgeRoleChange,
  onJudgeThresholdChange,
  facts,
}: {
  row: ScorerTableRow;
  predicates: Predicate[];
  checkPolicy: boolean;
  judgeDisabledReason: string | undefined;
  judgeSeveritySupported: boolean;
  judgeConfig: EvalJudgeConfig | undefined;
  expanded: boolean;
  onToggleExpand: () => void;
  onPredicateChange: (index: number, next: Predicate) => void;
  onPredicateRemove: (index: number) => void;
  onJudgeRoleChange: (role: ScorerUiRole) => void;
  onJudgeThresholdChange: (threshold: number) => void;
  facts?: React.ReactNode;
}) {
  const predicate =
    row.predicateIndex !== undefined
      ? predicates[row.predicateIndex]
      : undefined;

  return (
    <>
      <tr
        className={cn(
          "border-b border-border/40 align-top",
          row.muted && "text-muted-foreground",
        )}
        data-scorer-row={row.kind}
        data-scorer-id={row.id}
      >
        <td className="py-2 pr-3">
          {row.kind === "predicate" ? (
            <button
              type="button"
              className="text-left text-xs text-foreground hover:underline"
              onClick={onToggleExpand}
              aria-expanded={expanded}
            >
              {row.name}
            </button>
          ) : (
            <span
              className="text-xs"
              data-stage-empty={
                row.kind === "observed" ? row.observedStage : undefined
              }
            >
              {row.name}
            </span>
          )}
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
          <ThresholdCell
            row={row}
            predicate={predicate}
            judgeConfig={judgeConfig}
            onPredicateChange={onPredicateChange}
            onJudgeThresholdChange={onJudgeThresholdChange}
          />
        </td>
        <td className="py-2">
          <RoleCell
            row={row}
            predicate={predicate}
            checkPolicy={checkPolicy}
            judgeDisabledReason={judgeDisabledReason}
            judgeSeveritySupported={judgeSeveritySupported}
            onPredicateChange={onPredicateChange}
            onJudgeRoleChange={onJudgeRoleChange}
          />
        </td>
      </tr>
      {expanded && predicate && row.predicateIndex !== undefined ? (
        <tr className="border-b border-border/40">
          <td colSpan={4} className="pb-3 pt-1">
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
          const next = Number(event.target.value);
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
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            onPredicateChange(row.predicateIndex!, {
              ...predicate,
              tokens: Math.floor(next),
            });
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
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
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
  onPredicateChange,
  onJudgeRoleChange,
}: {
  row: ScorerTableRow;
  predicate: Predicate | undefined;
  checkPolicy: boolean;
  judgeDisabledReason: string | undefined;
  judgeSeveritySupported: boolean;
  onPredicateChange: (index: number, next: Predicate) => void;
  onJudgeRoleChange: (role: ScorerUiRole) => void;
}) {
  if (row.kind === "observed") return null;
  if (row.kind === "match") {
    return <RoleChip role="gate" />;
  }
  if (row.kind === "judge") {
    if (row.judgeSlot === "groundedness") {
      return <RoleChip role={row.role} />;
    }
    const gateEnabled = judgeDisabledReason === undefined;
    const roles: ScorerUiRole[] = judgeSeveritySupported
      ? ["gate", "warn", "report"]
      : ["gate", "report"];
    return (
      <div className="space-y-1">
        <div
          role="group"
          aria-label="Judge role"
          className="inline-flex rounded-md border border-border/60"
        >
          {roles.map((role) => (
            <RoleSegment
              key={role}
              pressed={row.role === role}
              disabled={role === "gate" && !gateEnabled}
              onClick={() => onJudgeRoleChange(role)}
            >
              {ROLE_LEGEND[role].label}
            </RoleSegment>
          ))}
        </div>
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
      return <RoleChip role="gate" />;
    }
    return (
      <div
        role="group"
        aria-label="Check role"
        className="inline-flex rounded-md border border-border/60"
      >
        {(["gate", "warn", "report"] as const).map((role) => (
          <RoleSegment
            key={role}
            pressed={row.role === role}
            onClick={() =>
              onPredicateChange(
                row.predicateIndex!,
                withPredicateRole(predicate, role),
              )
            }
          >
            {ROLE_LEGEND[role].label}
          </RoleSegment>
        ))}
      </div>
    );
  }
  return <RoleChip role={row.role} />;
}

function RoleChip({ role }: { role: ScorerUiRole }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-sm border border-border/60 px-1.5 py-px text-[10px] uppercase tracking-[0.06em]",
        role === "gate" ? "text-foreground" : STAGE_CHIP_TONE_CLASS.unmeasured,
      )}
    >
      {ROLE_LEGEND[role].label}
    </span>
  );
}

function RoleSegment({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "px-2 py-1 text-[10px] uppercase tracking-[0.06em] first:rounded-l-[5px] last:rounded-r-[5px]",
        pressed
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}
