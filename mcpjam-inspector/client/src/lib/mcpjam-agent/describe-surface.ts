import { create } from "zustand";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";

/** Mounted Describe editor, independent of persisted chat/session state. */
export const useDescribeSurface = create<{ scope: EvalAgentScope | null }>(
  () => ({ scope: null }),
);
export function isDescribeTarget(
  scope: Pick<EvalAgentScope, "projectId" | "suiteId" | "caseId">,
) {
  const active = useDescribeSurface.getState().scope;
  return (
    !!active &&
    active.projectId === scope.projectId &&
    active.suiteId === scope.suiteId &&
    active.caseId === scope.caseId
  );
}
