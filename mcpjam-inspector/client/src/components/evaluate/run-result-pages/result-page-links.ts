import type { MouseEvent } from "react";
import {
  buildEvaluatePath,
  navigateApp,
  scopeNavigationTarget,
} from "@/lib/app-navigation";
import type { RunResultPageRoute } from "@/lib/eval-route-types";
import { useRunResultPagesEnabled } from "@/hooks/use-run-result-pages-enabled";
import type { RunResultsMatrixData } from "../run-results-matrix-model";
import type { IterationVia } from "./run-view-events";

export type MatrixTarget = RunResultsMatrixData["targets"][number];
export type RunRef = { suiteId: string; runId: string };

export const FROM_GRID_STATE = { runResultVia: "grid" } as const;
export const FROM_PAGER_STATE = { runResultVia: "pager" } as const;

/** A history entry keeps its state, so `via` is fixed for the whole view. */
export function viaFromState(state: unknown): IterationVia {
  const via =
    typeof state === "object" && state !== null && "runResultVia" in state
      ? state.runResultVia
      : undefined;
  return via === "grid" || via === "pager" ? via : "link";
}

/** Sibling runs can share a target key, so the run id names the column too. */
export function targetParam(target: MatrixTarget): string {
  return `${target.run._id}~${target.targetKey}`;
}

export function findTarget(
  targets: readonly MatrixTarget[],
  param: string,
): MatrixTarget | undefined {
  const split = param.indexOf("~");
  if (split < 0) return undefined;
  const runId = param.slice(0, split);
  const targetKey = param.slice(split + 1);
  return targets.find(
    (target) => target.run._id === runId && target.targetKey === targetKey,
  );
}

function resultPath(run: RunRef, resultPage?: RunResultPageRoute): string {
  return buildEvaluatePath({ type: "run-detail", ...run, resultPage });
}

export function resultHref(run: RunRef, resultPage?: RunResultPageRoute) {
  return scopeNavigationTarget(resultPath(run, resultPage));
}

export function openResult(
  run: RunRef,
  resultPage?: RunResultPageRoute,
  options?: { replace?: boolean; state?: unknown },
): void {
  navigateApp(resultPath(run, resultPage), options);
}

/** Modified and middle clicks stay with the browser, so results open in new tabs. */
export function followLink(
  event: MouseEvent<HTMLAnchorElement>,
  go: () => void,
): void {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  go();
}

export function useCaseResultLinks(run: { suiteId: string; _id: string }) {
  if (useRunResultPagesEnabled() !== true) return {};
  const ref = { suiteId: run.suiteId, runId: run._id };
  const page = (caseKey: string, target: MatrixTarget | null) => ({
    caseKey,
    ...(target ? { target: targetParam(target) } : {}),
  });
  return {
    caseResultHref: (caseKey: string, target: MatrixTarget | null) =>
      resultHref(ref, page(caseKey, target)),
    onOpenCaseResult: (caseKey: string, target: MatrixTarget | null) =>
      openResult(ref, page(caseKey, target), { state: FROM_GRID_STATE }),
    // The pages read back what the grid showed, so only they keep it.
    viewMemoryRunId: run._id,
  };
}
