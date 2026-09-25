import type { GoalJudgePolicy } from "@/shared/judge-defaults";
import { useMemo } from "react";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Switch } from "@mcpjam/design-system/switch";
import type { ModelDefinition } from "@/shared/types";
import {
  MANAGED_DEFAULT_JUDGE_MODEL,
  RESERVED_JUDGE_SLOTS,
  type GoalCompletionJudgeSlot,
  type GoalJudgeConfig as EvalJudgeConfig,
} from "@/components/shared/session-quality/judge-config";
import { selectionBesideLegacyId } from "@/components/chat-v2/shared/model-selection";
import { useModelSelectionsSupported } from "@/hooks/use-project-environment-capability";

/**
 * Suite-level authoritative judge config. Mirrors the `ValidatorsSection`
 * pattern (props: value / onChange / title / description) so the suite
 * settings page can drop it next to ValidatorsSection. V1 carries one
 * judge — Goal Completion — but the envelope is forward-compatible with
 * additional judges (refusal judge, etc.) without a second pass on the
 * surface.
 *
 * The card on the run-detail page reads the snapshotted suite config from
 * `run.configSnapshot.judgeConfig` and displays it read-only; this is the
 * one place a user can change the suite contract.
 */

interface JudgesSectionProps {
  policy?: GoalJudgePolicy;
  value: EvalJudgeConfig | undefined;
  onChange: (next: EvalJudgeConfig | undefined) => void;
  availableModels: ModelDefinition[];
  /**
   * Save the picked row's model selection beside `judgeModel`. Defaults to
   * whether the active project's deployment stores selections
   * (`useModelSelectionsSupported`); when false only the legacy id is
   * written, which every deployment accepts.
   */
  saveModelSelections?: boolean;
  title?: string;
  description?: string;
  /**
   * "panel" (default) renders the full card with title block + nested
   * sub-card chrome. "bare" strips all framing and produces a flat row
   * sequence suitable for hosts that provide their own section header
   * (e.g. the suite settings sheet).
   */
  chrome?: "panel" | "bare";
  /**
   * Bare-chrome auto-grade row copy. Defaults to the eval-suite phrasing
   * ("every run / each case's objective"); other products pass their own so
   * the one shared control reads correctly in context (Swarm journeys grade
   * "every session against the journey goal"). Ignored in panel chrome.
   */
  bareAutoGradeBlurb?: string;
  bareAutoGradeAriaLabel?: string;
}

/**
 * Drop a judge config that carries no information, keep one that does.
 *
 * Exported for its own test: the rule it encodes — every field that means
 * something counts — is easy to break by adding a field and forgetting this
 * list, and the symptom is a setting silently disappearing on an unrelated
 * edit rather than anything that looks like a bug.
 */
export function pruneEmpty(
  value: EvalJudgeConfig,
): EvalJudgeConfig | undefined {
  const gc = value.goalCompletion;
  const hasGoalCompletion = Boolean(
    gc &&
    (gc.enabled !== undefined ||
      (gc.judgeModel !== undefined && gc.judgeModel !== "") ||
      gc.threshold !== undefined ||
      gc.autoRun !== undefined ||
      // `role` counts, and it is the one field here that must never be dropped
      // by accident: a suite carrying only `role: "gating"` — legal, because an
      // absent `enabled` already resolves to on — would otherwise have its whole
      // judge config discarded the moment someone reset the model to the managed
      // default, silently erasing a gate the organization had to earn.
      gc.role !== undefined ||
      // Same for presentation severity: a suite whose only authored field is
      // `severity: "warn"` would otherwise vanish on an unrelated model reset.
      gc.severity !== undefined),
  );
  // Every other slot is kept whenever it is present: this section edits goal
  // completion only, and dropping a slot it does not own would read as a
  // deliberate clear of that judge's settings.
  const reserved = Object.fromEntries(
    RESERVED_JUDGE_SLOTS.filter((slot) => value[slot] !== undefined).map(
      (slot) => [slot, value[slot]],
    ),
  ) as Partial<Pick<EvalJudgeConfig, (typeof RESERVED_JUDGE_SLOTS)[number]>>;
  if (!hasGoalCompletion && Object.keys(reserved).length === 0)
    return undefined;
  return {
    ...(hasGoalCompletion ? { goalCompletion: gc } : {}),
    ...reserved,
  };
}

/**
 * The goal-completion patch for a judge-model pick: the id plus, when the
 * picked row can be saved as one beside that id, its model selection. Both
 * are always written together (a stale selection naming the previous judge
 * would be refused), and both clear for the managed default.
 */
export function judgeModelPatch(
  next: string,
  availableModels: readonly ModelDefinition[],
  /** The deployment stores selections (`modelSelectionsSupported`). */
  saveModelSelection = true,
): Pick<GoalCompletionJudgeSlot, "judgeModel" | "judgeSelection"> {
  if (next === MANAGED_DEFAULT_JUDGE_MODEL) {
    return { judgeModel: undefined, judgeSelection: undefined };
  }
  // The option list keeps the FIRST row per id; save that same row.
  const row = saveModelSelection
    ? availableModels.find((model) => String(model.id) === next)
    : undefined;
  return {
    judgeModel: next,
    judgeSelection: row ? selectionBesideLegacyId(row, "judge") : undefined,
  };
}

export function JudgesSection({
  policy,
  value,
  onChange,
  availableModels,
  title = "LLM as Judge",
  description = "Advisory grading of run results against rubric anchors. Calibrate per suite — scores aren't comparable across domains.",
  chrome = "panel",
  bareAutoGradeBlurb = "Grade every run automatically against each case’s objective. Uses credits.",
  bareAutoGradeAriaLabel = "Auto-grade every run with LLM as Judge",
  saveModelSelections,
}: JudgesSectionProps) {
  // Explicit prop wins; otherwise ask the active project's deployment.
  const deploymentStoresSelections = useModelSelectionsSupported();
  const saveSelections = saveModelSelections ?? deploymentStoresSelections;
  const isBare = chrome === "bare";
  const gc = value?.goalCompletion;
  // Default-on: GOAL_COMPLETION_DEFAULTS.enabled = true. Only an explicit
  // `enabled: false` flips the toggle off, matching what the resolver
  // does at run time.
  const enabled = gc?.enabled !== false;
  const judgeModel = gc?.judgeModel ?? MANAGED_DEFAULT_JUDGE_MODEL;
  const autoRun = gc?.autoRun ?? policy?.effective.autoRun;

  const stateUnknown = enabled && autoRun === undefined;
  const sectionOn = enabled && autoRun === true;
  const handleMainToggle = (checked: boolean) => {
    update({ enabled: checked, autoRun: checked });
  };

  const modelOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of availableModels) {
      const id = String(model.id);
      if (id && !map.has(id)) {
        map.set(id, model.name ?? id);
      }
    }
    // Always keep the managed default + the current selection selectable,
    // even before the async model catalog loads.
    if (!map.has(MANAGED_DEFAULT_JUDGE_MODEL)) {
      map.set(MANAGED_DEFAULT_JUDGE_MODEL, MANAGED_DEFAULT_JUDGE_MODEL);
    }
    if (judgeModel && !map.has(judgeModel)) {
      map.set(judgeModel, judgeModel);
    }
    return Array.from(map, ([id, label]) => ({ id, label }));
  }, [availableModels, judgeModel]);

  const update = (
    patch: Partial<NonNullable<EvalJudgeConfig["goalCompletion"]>>,
  ) => {
    const nextGC = { ...(gc ?? {}), ...patch };
    const nextConfig: EvalJudgeConfig = { ...value, goalCompletion: nextGC };
    onChange(pruneEmpty(nextConfig));
  };

  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {isBare ? (
            // Parent `SettingsSection` already labels "LLM as Judge" and
            // describes it; surfacing the same name + blurb here would just
            // repeat the section header. In `panel` chrome there's no outer
            // label, so we keep the sub-heading + description.
            <p className="text-[12px] text-muted-foreground">
              {bareAutoGradeBlurb}
            </p>
          ) : (
            <>
              <span className="text-sm font-medium text-foreground">
                LLM as Judge
              </span>
              <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                Automatically grades the full recorded trace against each
                case&apos;s objective. Uses credits.
              </p>
            </>
          )}
        </div>
        {stateUnknown ? (
          <span className="text-xs text-muted-foreground">
            Grading state unavailable
          </span>
        ) : (
          <Switch
            checked={sectionOn}
            onCheckedChange={handleMainToggle}
            aria-label={
              isBare
                ? bareAutoGradeAriaLabel
                : "Enable LLM as Judge for this suite"
            }
          />
        )}
      </div>

      {sectionOn ? (
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 pt-1">
          <Label
            htmlFor="suite-goal-judge-model"
            className="text-sm text-muted-foreground"
          >
            Judge model
          </Label>
          <Select
            value={judgeModel}
            onValueChange={(next) =>
              update(judgeModelPatch(next, availableModels, saveSelections))
            }
          >
            <SelectTrigger
              id="suite-goal-judge-model"
              className="h-8 w-[14rem] text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </>
  );

  if (isBare) {
    return (
      <div aria-label={title} className="space-y-3">
        {body}
      </div>
    );
  }

  return (
    <section
      aria-label={title}
      className="rounded-lg border border-border/40 bg-card/30 p-4 space-y-4"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? (
          <p className="text-[12px] text-muted-foreground">{description}</p>
        ) : null}
      </div>

      <div className="space-y-3 rounded-md border border-border/30 bg-background/60 p-3">
        {body}

        {sectionOn ? (
          <p className="text-[11px] text-muted-foreground/70">
            Runs grade against this config. Individual runs can apply a one-off
            override from the run detail page — overridden runs show a banner on
            the run card so their scores aren&apos;t mistaken for suite-contract
            calibration.
          </p>
        ) : null}
      </div>
    </section>
  );
}
