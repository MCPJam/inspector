/**
 * Pure resolver for the Evaluate case workspace. No JSX.
 *
 * paneViewFor reproduces the shipped right-column precedence:
 *   explicit(!spec) › recording(!spec) › live(!spec) › latest › spec › empty
 * including the branch-4 quirk (a latest trial wins over "View spec").
 *
 * inspect and explicit are independent: a History pick sets both; "Edit case"
 * clears only inspect; typing touches neither; run start clears both.
 */

import { computeIterationResult } from "../../evals/pass-criteria";
import type {
  CompareRunRecord,
  EvalIteration,
  EvalSuiteRun,
} from "../../evals/types";
import {
  signaturesMatch,
  type CaseSnapshotFields,
} from "./case-snapshot-signature";

export type SelectedTrial =
  | {
      kind: "persisted";
      iteration: EvalIteration;
      source: "history" | "route" | "latest";
    }
  | { kind: "live"; record: CompareRunRecord };

export type PaneView =
  | { kind: "recording" }
  | { kind: "spec" }
  | { kind: "trial"; trial: SelectedTrial }
  | { kind: "empty" };

export type ExplicitSelection = {
  iteration: EvalIteration;
  source: "history" | "route";
};

export type TrialOverlay = {
  trial: SelectedTrial;
};

export type LeftView =
  | { kind: "editing"; overlay: TrialOverlay | null }
  | { kind: "inspecting"; iteration: EvalIteration };

export type LaunchSnapshot = CaseSnapshotFields & {
  runs?: number;
  namedHostId?: string;
  modelValue?: string;
};

export function createAttemptId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function paneViewFor(input: {
  explicit: ExplicitSelection | null;
  liveRecordMode: boolean;
  showLive: boolean;
  liveRecord: CompareRunRecord | null | undefined;
  latestCandidates: Array<EvalIteration | null | undefined>;
  specTrace: unknown | null | undefined;
  showSpecOverride: boolean;
}): PaneView {
  const { showSpecOverride } = input;
  if (input.explicit && !showSpecOverride) {
    return {
      kind: "trial",
      trial: {
        kind: "persisted",
        iteration: input.explicit.iteration,
        source: input.explicit.source,
      },
    };
  }
  if (input.liveRecordMode && !showSpecOverride) {
    return { kind: "recording" };
  }
  if (input.showLive && input.liveRecord && !showSpecOverride) {
    return { kind: "trial", trial: { kind: "live", record: input.liveRecord } };
  }
  const latest = input.latestCandidates.find(
    (iteration): iteration is EvalIteration =>
      !!iteration && !!(iteration.blob || iteration.chatSessionId),
  );
  if (latest) {
    return {
      kind: "trial",
      trial: { kind: "persisted", iteration: latest, source: "latest" },
    };
  }
  if (input.specTrace) {
    return { kind: "spec" };
  }
  return { kind: "empty" };
}

export function leftViewFor(input: {
  inspect: EvalIteration | null;
  draft: CaseSnapshotFields;
  selected: SelectedTrial | null;
}): LeftView {
  if (input.inspect) {
    return { kind: "inspecting", iteration: input.inspect };
  }
  const overlay =
    input.selected && trialMatchesDraft(input.selected, input.draft)
      ? { trial: input.selected }
      : null;
  return { kind: "editing", overlay };
}

export function trialKey(trial: SelectedTrial): string {
  if (trial.kind === "live") {
    return `attempt:${trial.record.attemptId ?? "unknown"}`;
  }
  return `iteration:${trial.iteration._id}`;
}

export function evidenceKey(trial: SelectedTrial): string {
  if (trial.kind === "persisted") {
    return (
      trial.iteration.blob ??
      trial.iteration.chatSessionId ??
      `iteration:${trial.iteration._id}`
    );
  }
  const iteration = trial.record.iteration;
  if (iteration?.blob || iteration?.chatSessionId) {
    return iteration.blob ?? iteration.chatSessionId!;
  }
  return `attempt:${trial.record.attemptId ?? "unknown"}`;
}

export function trialSnapshotFields(trial: SelectedTrial): CaseSnapshotFields {
  if (trial.kind === "live") {
    return trial.record.launchSnapshot ?? {};
  }
  const snapshot = trial.iteration.testCaseSnapshot;
  return {
    steps: snapshot?.steps,
    predicates: snapshot?.predicates,
    matchOptions: snapshot?.matchOptions,
    expectedOutput: snapshot?.expectedOutput,
  };
}

export function trialMatchesDraft(
  trial: SelectedTrial,
  draft: CaseSnapshotFields,
): boolean {
  return signaturesMatch(trialSnapshotFields(trial), draft);
}

export type TrialVerdictWord = "Running" | "Passed" | "Failed" | "No verdict";
export type TrialVerdictTone = "pending" | "success" | "destructive" | "muted";

export type TrialVerdict = {
  word: TrialVerdictWord;
  tone: TrialVerdictTone;
};

const LIFECYCLE_NO_VERDICT = new Set([
  "cancelled",
  "timed_out",
  "setup_failed",
  "skipped",
]);

function verdictFromComputed(
  computed: ReturnType<typeof computeIterationResult>,
  status: string,
): TrialVerdict {
  if (status === "running" || status === "pending") {
    return { word: "Running", tone: "pending" };
  }
  if (LIFECYCLE_NO_VERDICT.has(status)) {
    return { word: "No verdict", tone: "muted" };
  }
  if (computed === "passed") {
    return { word: "Passed", tone: "success" };
  }
  if (computed === "failed") {
    return { word: "Failed", tone: "destructive" };
  }
  return { word: "No verdict", tone: "muted" };
}

export function trialVerdict(trial: SelectedTrial): TrialVerdict {
  if (trial.kind === "persisted") {
    const iteration = trial.iteration;
    if (iteration.status === "running" || iteration.status === "pending") {
      return { word: "Running", tone: "pending" };
    }
    if (LIFECYCLE_NO_VERDICT.has(iteration.status)) {
      return { word: "No verdict", tone: "muted" };
    }
    if (iteration.result === "pending") {
      return { word: "No verdict", tone: "muted" };
    }
    return verdictFromComputed(
      computeIterationResult(iteration),
      iteration.status,
    );
  }

  const record = trial.record;
  if (record.status === "running") {
    return { word: "Running", tone: "pending" };
  }
  if (LIFECYCLE_NO_VERDICT.has(record.status)) {
    return { word: "No verdict", tone: "muted" };
  }
  if (record.status === "failed" && record.result !== "failed") {
    return { word: "No verdict", tone: "muted" };
  }
  if (record.iteration) {
    return verdictFromComputed(
      computeIterationResult(record.iteration),
      record.status,
    );
  }
  if (record.result === "passed") {
    return { word: "Passed", tone: "success" };
  }
  if (record.result === "failed") {
    return { word: "Failed", tone: "destructive" };
  }
  return { word: "No verdict", tone: "muted" };
}

export type TrialActivity = "Grading" | null;

export function trialActivity(input: {
  run?: Pick<EvalSuiteRun, "status" | "goalCompletionStatus"> | null;
  judgeCase?: { status?: string } | null;
}): TrialActivity {
  if (input.run?.status === "grading") return "Grading";
  if (input.run?.goalCompletionStatus === "pending") return "Grading";
  return null;
}

export function selectedTrialIteration(
  trial: SelectedTrial | null,
): EvalIteration | null {
  if (!trial) return null;
  if (trial.kind === "persisted") return trial.iteration;
  return trial.record.iteration ?? null;
}
