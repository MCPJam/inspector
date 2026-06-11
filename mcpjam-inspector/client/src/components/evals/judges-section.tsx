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
import type { EvalJudgeConfig } from "./types";

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

const MANAGED_DEFAULT_JUDGE_MODEL = "openai/gpt-5.4-mini";

interface JudgesSectionProps {
  value: EvalJudgeConfig | undefined;
  onChange: (next: EvalJudgeConfig | undefined) => void;
  availableModels: ModelDefinition[];
  title?: string;
  description?: string;
  /**
   * "panel" (default) renders the full card with title block + nested
   * sub-card chrome. "bare" strips all framing and produces a flat row
   * sequence suitable for hosts that provide their own section header
   * (e.g. the suite settings sheet).
   */
  chrome?: "panel" | "bare";
}

function pruneEmpty(value: EvalJudgeConfig): EvalJudgeConfig | undefined {
  if (!value.goalCompletion) return undefined;
  const gc = value.goalCompletion;
  const hasAnyField =
    gc.enabled !== undefined ||
    (gc.judgeModel !== undefined && gc.judgeModel !== "") ||
    gc.threshold !== undefined ||
    gc.autoRun !== undefined;
  if (!hasAnyField) return undefined;
  return { goalCompletion: gc };
}

export function JudgesSection({
  value,
  onChange,
  availableModels,
  title = "LLM as Judge",
  description = "Advisory grading of run results against rubric anchors. Calibrate per suite — scores aren't comparable across domains.",
  chrome = "panel",
}: JudgesSectionProps) {
  const isBare = chrome === "bare";
  const gc = value?.goalCompletion;
  // Default-on: GOAL_COMPLETION_DEFAULTS.enabled = true. Only an explicit
  // `enabled: false` flips the toggle off, matching what the resolver
  // does at run time. Cost stays gated by `autoRun: false` + the explicit
  // Run judge click on the run-detail card.
  const enabled = gc?.enabled !== false;
  const judgeModel = gc?.judgeModel ?? MANAGED_DEFAULT_JUDGE_MODEL;
  const autoRun = gc?.autoRun === true;

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

  const update = (patch: Partial<NonNullable<EvalJudgeConfig["goalCompletion"]>>) => {
    const nextGC = { ...(gc ?? {}), ...patch };
    const nextConfig: EvalJudgeConfig = { goalCompletion: nextGC };
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
              Grade each case&apos;s final answer against its objective.
            </p>
          ) : (
            <>
              <span className="text-sm font-medium text-foreground">
                LLM as Judge
              </span>
              <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                Grades each case&apos;s final answer against its objective.
              </p>
            </>
          )}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked: boolean) =>
            // Persist EXPLICIT true/false. `undefined` means "inherit the
            // default" — which is `enabled: true` — so writing
            // `enabled: undefined` here would silently re-enable a suite
            // the user just disabled.
            update({ enabled: checked })
          }
          aria-label="Enable LLM as Judge for this suite"
        />
      </div>

      {enabled ? (
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
              update({
                judgeModel:
                  next === MANAGED_DEFAULT_JUDGE_MODEL ? undefined : next,
              })
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

          {/* Threshold is hidden from the suite UI — runs grade against a
              fixed default and surface only the model choice. Auto-run is
              still configurable in the full panel chrome. */}
          {!isBare ? (
            <>
              <Label
                htmlFor="suite-goal-auto-run"
                className="text-sm text-muted-foreground"
              >
                Auto-run on every run
              </Label>
              <Switch
                id="suite-goal-auto-run"
                checked={autoRun}
                onCheckedChange={(checked: boolean) =>
                  update({ autoRun: checked || undefined })
                }
                aria-label="Auto-run the LLM as Judge on every new completed run"
              />
            </>
          ) : null}
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

        {enabled ? (
          <p className="text-[11px] text-muted-foreground/70">
            Runs grade against this config. Individual runs can apply a one-off
            override from the run detail page — overridden runs show a banner
            on the run card so their scores aren&apos;t mistaken for
            suite-contract calibration.
          </p>
        ) : null}
      </div>
    </section>
  );
}
