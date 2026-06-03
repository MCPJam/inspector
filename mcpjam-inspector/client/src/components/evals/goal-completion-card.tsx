import { useMemo, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";
import type { EvalIteration, EvalJudgeConfig, EvalSuiteRun } from "./types";
import type { GoalCompletionRequestArgs } from "./use-goal-completion";

/** Managed default judge model (mirrors GOAL_COMPLETION_MODEL in the backend). */
const DEFAULT_JUDGE_MODEL = "openai/gpt-5.4-mini";
// A reasonable starting cutoff only — LLM-as-judge scores aren't comparable
// across domains, so teams should recalibrate this against a labeled set.
const DEFAULT_THRESHOLD = 0.7;

export interface GoalCompletionCardProps {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  goalCompletion: EvalSuiteRun["goalCompletion"] | null;
  availableModels: ModelDefinition[];
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  onRun: (args: GoalCompletionRequestArgs, force?: boolean) => void;
  /**
   * Current suite-level judge config (live, not snapshotted on the run).
   * When the suite has the judge enabled NOW, the card lets the user re-run
   * even on older runs whose snapshot didn't have it on. When omitted,
   * the card falls back to the run's snapshot — older parents
   * (e.g. commit-detail) don't need to thread suite data through.
   */
  currentSuiteJudgeConfig?: EvalJudgeConfig | null;
}

function formatScore(score: number): string {
  // Don't route the score through clampThreshold: its NaN→DEFAULT_THRESHOLD
  // fallback is right for the threshold input but would render a corrupt/NaN
  // score as "70%" (the pass cutoff). Show a neutral dash instead, and clamp
  // finite scores into [0,1].
  if (!Number.isFinite(score)) {
    return "—";
  }
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

function ScoreBadge({ passed }: { passed: boolean }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        passed
          ? "bg-success/50 text-foreground"
          : "bg-warning/50 text-foreground",
      )}
    >
      {passed ? "meets goal" : "below threshold"}
    </span>
  );
}

export function GoalCompletionCard({
  run,
  iterations,
  goalCompletion,
  availableModels,
  pending,
  requested,
  failedGeneration,
  error,
  onRun,
  currentSuiteJudgeConfig,
}: GoalCompletionCardProps) {
  const completedRun = run.status === "completed";

  // Seed inputs from (in order): persisted run override → suite snapshot →
  // managed defaults. This way reopening a run with an override pre-populates
  // it; reopening a run without one pre-populates suite config (so a click
  // submits the suite default and the override field stays cleared on the
  // backend).
  const initialModel =
    run.judgeConfigOverride?.goalCompletion?.judgeModel ??
    run.configSnapshot?.judgeConfig?.goalCompletion?.judgeModel ??
    (goalCompletion?.modelUsed && goalCompletion.modelUsed !== "n/a"
      ? goalCompletion.modelUsed
      : DEFAULT_JUDGE_MODEL);
  const [selectedModelId, setSelectedModelId] =
    useState<string>(initialModel);

  // Always keep the managed default + the current selection selectable, even
  // before the async model catalog loads (or when BYOK has none configured).
  const modelOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of availableModels) {
      const id = String(model.id);
      if (id && !map.has(id)) {
        map.set(id, model.name ?? id);
      }
    }
    if (!map.has(DEFAULT_JUDGE_MODEL)) {
      map.set(DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_MODEL);
    }
    if (selectedModelId && !map.has(selectedModelId)) {
      map.set(selectedModelId, selectedModelId);
    }
    return Array.from(map, ([value, label]) => ({ value, label }));
  }, [availableModels, selectedModelId]);

  const titleByCaseKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const iter of iterations) {
      const caseKey = iter.testCaseSnapshot?.caseKey;
      const title = iter.testCaseSnapshot?.title;
      if (caseKey && title && !map.has(caseKey)) {
        map.set(caseKey, title);
      }
    }
    return map;
  }, [iterations]);

  // Read the suite's effective config from the run's snapshot. The card
  // displays this read-only; the model + threshold inputs on this card now
  // populate a per-run *override* (run.judgeConfigOverride) instead of being
  // the primary config source. Suite settings is the new home for default
  // config (see JudgesSection in suite-iterations-view.tsx).
  const suiteConfig = run.configSnapshot?.judgeConfig?.goalCompletion;
  const suiteModel = suiteConfig?.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const suiteThreshold = suiteConfig?.threshold ?? DEFAULT_THRESHOLD;
  // Backend default is `enabled: true` (see GOAL_COMPLETION_DEFAULTS in
  // convex/lib/judgeConfig.ts) — only an explicit `enabled: false` turns
  // the judge off. The current suite config takes precedence over the
  // snapshot when provided, so flipping the toggle on today re-opens the
  // controls for older runs whose snapshot didn't have it set.
  // Cost is gated by `autoRun: false` (default) + the explicit Run judge
  // click, so an unconfigured/enabled-by-default suite still spends nothing
  // until a click.
  const currentSuiteGoalCompletion = currentSuiteJudgeConfig?.goalCompletion;
  const resolvedEnabled =
    currentSuiteGoalCompletion?.enabled ?? suiteConfig?.enabled;
  const isJudgeConfigured = resolvedEnabled !== false;
  // The persisted run override (`run.judgeConfigOverride.goalCompletion`)
  // tells the trend story (this data point isn't graded against the suite
  // contract). Surfacing it prominently is how the comparability promise
  // is delivered — otherwise the persistence is invisible.
  const runOverride = run.judgeConfigOverride?.goalCompletion;
  const overrideModel =
    runOverride?.judgeModel && runOverride.judgeModel !== suiteModel
      ? runOverride.judgeModel
      : undefined;
  const overrideThresholdValue =
    runOverride?.threshold !== undefined &&
    runOverride.threshold !== suiteThreshold
      ? runOverride.threshold
      : undefined;
  const hasMeaningfulOverride =
    overrideModel !== undefined || overrideThresholdValue !== undefined;

  const handleRun = (force: boolean) => {
    // Only send a runOverride when the user's model selection DIFFERS from the
    // suite config. Threshold is no longer adjustable from this card — it
    // always inherits the suite default.
    const overrideModel =
      selectedModelId && selectedModelId !== suiteModel
        ? selectedModelId
        : undefined;
    const runOverride = overrideModel
      ? { judgeModel: overrideModel }
      : undefined;
    onRun({ runOverride }, force);
  };

  const cases = goalCompletion?.cases ?? [];
  const advisoryPassed = cases.filter((c) => c.passed).length;
  // Treat an in-flight request (clicked, before the run doc flips to `pending`)
  // as a grading state, so a re-run doesn't keep showing the previous run's
  // stale scores/counts as if they were current.
  const inFlight = pending || requested;

  const headerSubtitle = (() => {
    if (pending) return "Grading…";
    if (requested) return "Requesting…";
    if (error || failedGeneration) return "Grading failed";
    if (!isJudgeConfigured) return "Disabled";
    if (!goalCompletion) return "Not run yet";
    if (cases.length === 0) return "Summary only";
    return `${advisoryPassed}/${cases.length} meet goal (advisory)`;
  })();

  const runLabel = goalCompletion ? "Re-run judge" : "Run judge";

  return (
    <section className="rounded-lg border border-border bg-card text-card-foreground">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            LLM as Judge
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {headerSubtitle}
          </span>
        </div>
        {error || failedGeneration ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => handleRun(true)}
            disabled={!completedRun || inFlight}
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </Button>
        ) : null}
      </header>

      {isJudgeConfigured ? (
        <>
          {/* Controls: judge model + threshold + run. Only shown when the
              suite has goal completion enabled — otherwise we render the
              "Configure on suite" CTA below so the user can't accidentally
              trigger a no-op grading that still spends an LLM call. */}
          <div className="flex flex-wrap items-end gap-3 border-t border-border/50 px-3 py-3">
            <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
              <Label htmlFor="goal-judge-model" className="text-xs">
                Judge model
              </Label>
              <Select
                value={selectedModelId}
                onValueChange={setSelectedModelId}
                disabled={inFlight}
              >
                <SelectTrigger
                  id="goal-judge-model"
                  className="h-8 w-full text-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1 text-xs"
              // force when re-grading an existing result OR retrying a failed run,
              // so the shared insight lifecycle re-requests instead of no-opping.
              onClick={() =>
                handleRun(Boolean(goalCompletion) || failedGeneration)
              }
              // `inFlight` (pending OR requested) blocks the gap between the click
              // and the run doc flipping to `pending`, so a double-click can't spend
              // a second judge call.
              disabled={!completedRun || inFlight}
            >
              {inFlight ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {runLabel}
            </Button>
          </div>

          {hasMeaningfulOverride ? (
            <div className="mx-3 mb-3 rounded-md border border-warning/50 bg-warning/50 px-3 py-2 text-[12px]">
              <div className="font-medium text-foreground">
                This run used an override
              </div>
              <div className="mt-0.5 text-muted-foreground">
                Suite default:{" "}
                <span className="font-mono text-foreground/80">
                  {suiteModel} @ {suiteThreshold}
                </span>{" "}
                · This run:{" "}
                <span className="font-mono text-foreground/80">
                  {overrideModel ?? suiteModel} @{" "}
                  {overrideThresholdValue ?? suiteThreshold}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground/80">
                Scores from this run aren't directly comparable to the
                suite's trend. Re-run with the override cleared to re-grade
                against the suite contract.
              </div>
            </div>
          ) : null}
        </>
      ) : (
        // Suite explicitly disabled the judge. Don't render run controls —
        // clicking them would spend an LLM call to grade nothing. The
        // suite settings toggle is the path back on.
        <div className="border-t border-border/50 px-3 py-3 text-[12px] text-muted-foreground">
          Disabled in suite settings. Turn it on to grade this run.
        </div>
      )}

      {/* Skip the bottom body band entirely in the quiet "disabled, no
          prior result" state — the CTA above is the whole story, no need
          for an empty bordered strip below it. */}
      {!isJudgeConfigured &&
      !goalCompletion &&
      !inFlight &&
      !error &&
      !failedGeneration ? null : (
      <div className="border-t border-border/50">
        {inFlight ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Grading final answers…
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-sm text-destructive">{error}</div>
        ) : failedGeneration ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            We could not finish grading. Adjust the model or threshold and
            retry.
          </div>
        ) : !goalCompletion ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Advisory grading against each case&apos;s objective. Never
            changes the run&apos;s pass/fail.
          </div>
        ) : cases.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            This run wasn&apos;t graded — no completed cases were available to
            judge. Re-run the judge to grade against the current suite config.
          </div>
        ) : (
          <>
            {goalCompletion.summary?.trim() ? (
              <p className="border-b border-border/40 px-3 py-2.5 text-sm text-muted-foreground">
                {goalCompletion.summary.trim()}
              </p>
            ) : null}
            <ul className="divide-y divide-border/40">
              {cases.map((c) => {
                const title = titleByCaseKey.get(c.caseKey) ?? c.caseKey;
                return (
                  <li
                    key={c.caseKey}
                    className="flex items-start gap-3 px-3 py-2.5"
                  >
                    <span className="mt-0.5 w-10 shrink-0 text-right text-sm font-semibold tabular-nums">
                      {formatScore(c.score)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {title}
                        </span>
                        <ScoreBadge passed={c.passed} />
                      </div>
                      {c.reason ? (
                        <div className="mt-0.5 text-[13px] text-muted-foreground">
                          {c.reason}
                        </div>
                      ) : null}
                      {c.rubricHits.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.rubricHits.map((hit, i) => (
                            <span
                              key={`${c.caseKey}-hit-${i}`}
                              className="rounded-sm bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            >
                              {hit}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="px-3 py-2 text-[11px] text-muted-foreground/70">
              Judged by {goalCompletion.modelUsed} · pass when score ≥{" "}
              {goalCompletion.threshold}. Advisory only — the deterministic
              tool-call verdict above is the run's pass/fail.
            </p>
          </>
        )}
      </div>
      )}
    </section>
  );
}
