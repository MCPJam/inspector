import type { ReactNode } from "react";
import type { EvalRoute } from "@/lib/eval-route-types";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";
import { useIterationCrumbNumber } from "../test-run/iteration-page";
import { EvalHeaderActionsSlot } from "./eval-header-actions";
import {
  buildEvalBreadcrumbs,
  evalRouteTestCaseId,
  evalsHeaderTrailProps,
  type EvalCrumbNames,
  type EvalsHeaderTrailProps,
} from "./eval-breadcrumbs";

/**
 * `EvalsHeader`'s trail for the new pages, from the address alone, with the
 * slot for page buttons; null while they are off. Every crumb slot is set,
 * so it replaces today's trail whole.
 */
export function useEvalNavTrail(
  route: EvalRoute,
  {
    enabled,
    cases,
    ...names
  }: Pick<EvalCrumbNames, "suite" | "runNumber" | "server"> & {
    enabled: boolean;
    cases: readonly { _id: string; title: string }[] | undefined;
  },
):
  | (EvalsHeaderTrailProps & {
      onEvaluateClick: () => void;
      actions: ReactNode;
    })
  | null {
  const iterationNumber = useIterationCrumbNumber(route, enabled);
  if (!enabled) return null;
  const caseId = evalRouteTestCaseId(route);
  const crumbs = buildEvalBreadcrumbs(route, {
    ...names,
    testCase: caseId ? cases?.find(({ _id }) => _id === caseId)?.title : null,
    iterationNumber,
  });
  const openCrumb = (target: EvalRoute) =>
    navigatePlaygroundEvalsRoute(target, { via: "crumb" });
  return {
    parentCrumb: undefined,
    children: undefined,
    onCurrentCrumbClick: undefined,
    detailCrumb: undefined,
    onEvaluateClick: () => openCrumb({ type: "list" }),
    actions: <EvalHeaderActionsSlot />,
    ...evalsHeaderTrailProps(crumbs, openCrumb),
  };
}
