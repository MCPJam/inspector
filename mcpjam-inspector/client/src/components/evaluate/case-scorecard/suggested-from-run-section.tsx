/**
 * Assembles the batch, its traces and the engine into the card.
 *
 * Everything that decides WHAT to suggest is pure and lives elsewhere; this
 * owns the reads and the once-per-batch telemetry. It is also where the
 * batch's population is filtered: a trial that never ran the case
 * (`setup_failed`, `skipped`) is not evidence about the case, and a batch
 * still in flight is not evidence at all yet.
 */

import { useEffect, useMemo, useRef } from "react";
import type { EvalIteration } from "@/components/evals/types";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";
import type { JudgeCase } from "@/components/evals/goal-completion-presentation";
import { track } from "@/lib/analytics";
import type { CaseRunBatch } from "@/components/evals/runs/group-case-iterations";
import { caseRunBatchTrigger } from "@/components/evals/runs/group-case-iterations";
import {
  buildCaseScorecard,
  type CaseScorecardInput,
} from "./case-scorecard-model";
import { trialFacts } from "./trial-run-facts";
import {
  suggestScorers,
  type Suggestion,
  type SuggestOutput,
} from "./suggest-from-run";
import { useTrialBlobs } from "./use-trial-blobs";
import { SuggestedFromRunCard } from "./suggested-from-run-card";

/** A trial that never executed the case says nothing about it. */
const NON_RUNNING: ReadonlySet<EvalIteration["status"]> = new Set([
  "setup_failed",
  "skipped",
]);

export function useSuggestedScorers({
  enabled,
  batch,
  authored,
  judgeFor,
  selectedBlob,
  prompts,
}: {
  enabled: boolean;
  batch: CaseRunBatch | null;
  authored: CaseScorecardInput;
  judgeFor?: (iteration: EvalIteration) => JudgeCase | null;
  selectedBlob?: { iterationId: string; blob: TraceEnvelope } | null;
  prompts: string[];
}): {
  output: SuggestOutput;
  read: { pending: number; failed: number; capped: number; total: number };
  of: number;
  waiting: boolean;
} {
  const population = useMemo(
    () => (batch?.iterations ?? []).filter((it) => !NON_RUNNING.has(it.status)),
    [batch],
  );
  // A batch with a trial still running is not a finished observation; its
  // numbers would move under the reader.
  const waiting = population.some(
    (it) => it.status === "pending" || it.status === "running",
  );

  const { reads, loading, capped } = useTrialBlobs({
    iterations: population,
    seed: selectedBlob ?? null,
    enabled: enabled && !waiting && population.length > 0,
  });

  const card = useMemo(() => buildCaseScorecard(authored), [authored]);
  const authoredHasGate = useMemo(
    () =>
      card.groups.some((group) =>
        group.rows.some(
          (row) => row.role === "gate" && row.provenance !== "judge",
        ),
      ),
    [card],
  );

  const output = useMemo<SuggestOutput>(() => {
    if (!enabled || waiting || population.length === 0) {
      return { suggestions: [], diagnosis: null };
    }
    const turnCountFromSteps = new Set(
      authored.steps.filter(
        (s) => s.kind === "prompt" || s.kind === "toolCall",
      ),
    ).size;
    const trials = population.map((iteration) => {
      const read = reads.get(iteration._id);
      return trialFacts(
        iteration,
        read?.state === "ok" ? read.blob : null,
        read?.state === "ok"
          ? { state: "ok" }
          : read?.state === "failed"
            ? { state: "failed" }
            : { state: "absent" },
        {
          judgeCase: judgeFor?.(iteration) ?? null,
          authoredHasGate,
          turnCountFromSteps,
        },
      );
    });
    return suggestScorers({
      trials,
      steps: authored.steps,
      casePredicates: authored.predicates,
      suiteDefaults: authored.suiteDefaultPredicates,
      goal: authored.expectedOutput,
      prompts,
      route: card.route.route ?? { kind: "unset" },
      routeKind: authored.kind ?? undefined,
    });
  }, [
    enabled,
    waiting,
    population,
    reads,
    authored,
    authoredHasGate,
    card,
    judgeFor,
    prompts,
  ]);

  const read = useMemo(() => {
    let pending = 0;
    let failed = 0;
    for (const value of reads.values()) {
      if (value.state === "pending") pending += 1;
      if (value.state === "failed") failed += 1;
    }
    return {
      pending: loading ? Math.max(pending, 1) : pending,
      failed,
      capped,
      total: population.length,
    };
  }, [reads, loading, capped, population.length]);

  return { output, read, of: population.length, waiting };
}

export function SuggestedFromRunSection({
  enabled,
  batch,
  authored,
  judgeFor,
  selectedBlob,
  prompts,
  dismissed,
  accepted,
  onAccept,
  onAcceptAll,
  onDismiss,
  onSeeFailure,
}: {
  enabled: boolean;
  batch: CaseRunBatch | null;
  authored: CaseScorecardInput;
  judgeFor?: (iteration: EvalIteration) => JudgeCase | null;
  selectedBlob?: { iterationId: string; blob: TraceEnvelope } | null;
  prompts: string[];
  dismissed: ReadonlySet<string>;
  accepted: ReadonlySet<string>;
  onAccept: (suggestion: Suggestion) => void;
  onAcceptAll: (all: Suggestion[]) => void;
  onDismiss: (suggestion: Suggestion) => void;
  onSeeFailure?: () => void;
}) {
  const { output, read, of, waiting } = useSuggestedScorers({
    enabled,
    batch,
    authored,
    judgeFor,
    selectedBlob,
    prompts,
  });

  const batchKey = batch?.key ?? "";
  const visible = useMemo(
    () =>
      output.suggestions.filter(
        (suggestion) => !dismissed.has(`${batchKey}|${suggestion.key}`),
      ),
    [output.suggestions, dismissed, batchKey],
  );

  const shownRef = useRef<string>("");
  const signature = `${batchKey}::${visible.map((s) => s.key).join(",")}`;
  useEffect(() => {
    if (!enabled || waiting || visible.length === 0) return;
    if (shownRef.current === signature) return;
    shownRef.current = signature;
    track("eval_suggestion_shown", {
      count: visible.length,
      of,
      unread: read.failed,
      capped: read.capped,
      tier2: read.failed === 0,
      by_role: {
        gate: visible.filter((s) => s.role === "gate").length,
        warn: visible.filter((s) => s.role === "warn").length,
        report: visible.filter((s) => s.role === "report").length,
      },
      diagnosis: output.diagnosis !== null,
      batch_trigger: batch ? caseRunBatchTrigger(batch) : undefined,
    });
  }, [signature, enabled, waiting, visible, of, read, output.diagnosis, batch]);

  if (!enabled || !batch) return null;
  if (waiting) {
    return (
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="suggested-from-run-waiting"
      >
        Waiting for {of} {of === 1 ? "trial" : "trials"} to finish…
      </p>
    );
  }
  if (visible.length === 0 && !output.diagnosis && read.pending === 0) {
    return null;
  }

  return (
    <SuggestedFromRunCard
      suggestions={visible}
      diagnosis={output.diagnosis}
      of={of}
      read={read}
      accepted={
        new Set(
          [...accepted]
            .filter((key) => key.startsWith(`${batchKey}|`))
            .map((key) => key.slice(batchKey.length + 1)),
        )
      }
      onAccept={onAccept}
      onAcceptAll={onAcceptAll}
      onDismiss={onDismiss}
      onSeeFailure={onSeeFailure}
    />
  );
}
