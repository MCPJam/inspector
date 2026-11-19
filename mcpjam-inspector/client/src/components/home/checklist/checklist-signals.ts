import type { ConformanceRunListItem } from "@/components/conformance/ConformanceHistory";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import type { ChecklistProgress } from "./checklist-progress";

export type StepId =
  | "connect"
  | "chat"
  | "onboard_agent"
  | "check_server"
  | "create_eval";

export interface ChecklistSignals {
  done: Record<StepId, boolean>;
  conformance: { run: ConformanceRunListItem | null };
  /** `suiteId` is the suite Run eval opens; `passRate` is its finished run's. */
  eval: { suiteId: string | null; passRate: number | null };
}

/**
 * Which steps the current user has already done in this project. A
 * conformance run counts once it finishes, failing checks included; an eval
 * counts once one of the user's suites has a finished run.
 */
export function computeChecklistSignals({
  hasServer,
  progress,
  userId,
  conformanceRuns,
  suites,
}: {
  hasServer: boolean;
  progress: ChecklistProgress;
  userId: string | null;
  conformanceRuns: ConformanceRunListItem[];
  suites: EvalSuiteOverviewEntry[];
}): ChecklistSignals {
  // Run rows name their author only once the backend projects `createdBy`;
  // until then a project's finished run counts for each member.
  const run =
    conformanceRuns
      .filter((candidate) => {
        const createdBy = (candidate as { createdBy?: string }).createdBy;
        return (
          candidate.status === "completed" &&
          (createdBy === undefined || createdBy === userId)
        );
      })
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  const ownSuites = userId
    ? suites.filter((entry) => entry.suite.createdBy === userId)
    : [];
  // Any finished run of theirs counts, not just the latest: a later run that
  // is still going, failed, or was a teammate's doesn't undo the step.
  let ran: { suiteId: string; passRate: number | null } | null = null;
  for (const entry of ownSuites) {
    const finished = [entry.latestRun, ...(entry.recentRuns ?? [])].find(
      (candidate) =>
        candidate?.status === "completed" && candidate.createdBy === userId,
    );
    if (finished) {
      ran = {
        suiteId: entry.suite._id,
        passRate: finished.summary?.passRate ?? null,
      };
      break;
    }
  }
  return {
    done: {
      connect: hasServer,
      chat: progress.chat === true,
      onboard_agent: progress.agent === true || progress.skippedAgent === true,
      check_server: run !== null,
      create_eval: ran !== null,
    },
    conformance: { run },
    eval: {
      suiteId: ran?.suiteId ?? ownSuites[0]?.suite._id ?? null,
      passRate: ran?.passRate ?? null,
    },
  };
}
