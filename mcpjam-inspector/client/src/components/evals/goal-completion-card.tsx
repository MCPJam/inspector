import { useMemo, useState } from "react";
import { Loader2, RotateCw, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
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
import type { EvalIteration, EvalSuiteRun } from "./types";
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
}

function clampThreshold(value: number): number {
  if (Number.isNaN(value)) {
    return DEFAULT_THRESHOLD;
  }
  return Math.min(1, Math.max(0, value));
}

function formatScore(score: number): string {
  return `${Math.round(clampThreshold(score) * 100)}%`;
}

function ScoreBadge({ passed }: { passed: boolean }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        passed
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
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
}: GoalCompletionCardProps) {
  const completedRun = run.status === "completed";

  const [selectedModelId, setSelectedModelId] = useState<string>(
    goalCompletion?.modelUsed && goalCompletion.modelUsed !== "n/a"
      ? goalCompletion.modelUsed
      : DEFAULT_JUDGE_MODEL,
  );
  const [thresholdInput, setThresholdInput] = useState<string>(
    String(goalCompletion?.threshold ?? DEFAULT_THRESHOLD),
  );

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

  const handleRun = (force: boolean) => {
    onRun(
      {
        judgeModel: selectedModelId || undefined,
        threshold: clampThreshold(Number(thresholdInput)),
      },
      force,
    );
  };

  const cases = goalCompletion?.cases ?? [];
  const advisoryPassed = cases.filter((c) => c.passed).length;

  const headerSubtitle = (() => {
    if (pending) return "Grading…";
    if (error || failedGeneration) return "Grading failed";
    if (!goalCompletion && requested) return "Requesting…";
    if (!goalCompletion) return "Not run yet";
    if (cases.length === 0) return "Summary only";
    return `${advisoryPassed}/${cases.length} meet goal (advisory)`;
  })();

  const runLabel = goalCompletion ? "Re-run judge" : "Run judge";

  return (
    <section className="rounded-lg border border-border bg-card text-card-foreground">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            Goal completion
          </span>
          <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            advisory · LLM judge
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
            disabled={!completedRun || pending || requested}
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </Button>
        ) : null}
      </header>

      {/* Controls: judge model + threshold + run */}
      <div className="flex flex-wrap items-end gap-3 border-t border-border/50 px-3 py-3">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <Label htmlFor="goal-judge-model" className="text-xs">
            Judge model
          </Label>
          <Select
            value={selectedModelId}
            onValueChange={setSelectedModelId}
            disabled={pending}
          >
            <SelectTrigger id="goal-judge-model" className="h-8 w-full text-sm">
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
        <div className="flex w-24 flex-col gap-1">
          <Label htmlFor="goal-threshold" className="text-xs">
            Threshold
          </Label>
          <Input
            id="goal-threshold"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            onBlur={() =>
              setThresholdInput(String(clampThreshold(Number(thresholdInput))))
            }
            disabled={pending}
            className="h-8 text-sm"
          />
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1 text-xs"
          // force when re-grading an existing result OR retrying a failed run,
          // so the shared insight lifecycle re-requests instead of no-opping.
          onClick={() => handleRun(Boolean(goalCompletion) || failedGeneration)}
          // `requested` blocks the gap between click and the run doc flipping to
          // `pending`, so a double-click can't spend a second judge call.
          disabled={!completedRun || pending || requested}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {runLabel}
        </Button>
      </div>

      <p className="px-3 pb-3 text-[11px] text-muted-foreground/70">
        Threshold is the advisory pass cutoff (score ≥ threshold). Calibrate it
        per suite against a labeled set — LLM-judge scores are not comparable
        across domains.
      </p>

      <div className="border-t border-border/50">
        {pending ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Grading final answers against expected output…
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
            Grade whether each case's final answer satisfied its expected
            output. Pick a judge model and threshold, then run — this is
            advisory and never changes the run's pass/fail.
          </div>
        ) : cases.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {goalCompletion.summary?.trim() ||
              "No anchored cases to grade (cases need an expected output)."}
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
    </section>
  );
}
