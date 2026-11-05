/**
 * The case pages of the new Evaluate flow: Test case, New case, Test Case
 * Evaluators, and the editor opened from a test run. Rendered only with
 * `evaluate-nav-enabled` on; each route says where Back leads.
 */

import { Loader2 } from "lucide-react";
import { buildEvaluatePath, navigateApp } from "@/lib/app-navigation";
import type { EvalRoute } from "@/lib/eval-route-types";
import type { RemoteServer } from "@/hooks/useProjects";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";
import { useEvalNavPageViewed } from "../nav/eval-nav-link";
import type { EvalNavPageId } from "../nav/eval-nav-pages";
import { CaseStepsPage, type CaseRunOutcome } from "./case-steps-page";
import { CaseEvaluatorsPage } from "./case-evaluators-page";
import type { EditorAnchor } from "./case-steps-model";
import { anchorSearch } from "./editor-rows";

export type CaseStepsRoute = Extract<
  EvalRoute,
  { type: "case-settings" | "case-new" | "case-evaluators" | "test-run-edit" }
>;

const PAGE_OF: Record<CaseStepsRoute["type"], EvalNavPageId> = {
  "case-settings": "case",
  "case-new": "case-new",
  "case-evaluators": "case-evaluators",
  "test-run-edit": "test-run-edit",
};

export function isCaseStepsRoute(route: EvalRoute): route is CaseStepsRoute {
  return Object.hasOwn(PAGE_OF, route.type);
}

/** Where Back leads from each case page, and what it says. */
export function caseBackTarget(route: CaseStepsRoute): {
  label: string;
  to: EvalRoute;
} {
  switch (route.type) {
    case "case-evaluators":
      return {
        label: "Back to test case",
        to: {
          type: "case-settings",
          suiteId: route.suiteId,
          testCaseId: route.testCaseId,
        },
      };
    case "test-run-edit":
      return {
        label: "Back to test run",
        to: {
          type: "test-run",
          suiteId: route.suiteId,
          runId: route.runId,
          testCaseId: route.testCaseId,
        },
      };
    default:
      return {
        label: "Back to suite settings",
        to: { type: "suite-settings", suiteId: route.suiteId, tab: "cases" },
      };
  }
}

/** Opens the editor at one step, as a preview item on another page does. */
export function openCaseEditorAt(route: EvalRoute, anchor: EditorAnchor) {
  navigateApp(`${buildEvaluatePath(route)}${anchorSearch(anchor)}`);
}

export function CaseStepsNavPage({
  route,
  suite,
  cases,
  projectId,
  projectServers,
  readOnly,
  onRunCase,
  onDeleteCase,
}: {
  route: CaseStepsRoute;
  suite: EvalSuite;
  cases: EvalCase[];
  projectId?: string | null;
  projectServers?: RemoteServer[];
  readOnly: boolean;
  /** Evaluate's quick run of one case; resolves to its first iteration. */
  onRunCase: (
    testCase: EvalCase,
    options: { location: string; suppressCompletionToasts: boolean },
  ) => Promise<{ iteration?: { suiteRunId?: string | null } } | null>;
  onDeleteCase?: (testCaseId: string) => Promise<unknown>;
}) {
  const page = PAGE_OF[route.type];
  const caseId = route.type === "case-new" ? null : route.testCaseId;
  useEvalNavPageViewed(page, true);

  const back = caseBackTarget(route);
  const backButton = {
    label: back.label,
    onClick: () => navigatePlaygroundEvalsRoute(back.to),
  };
  const suiteSettings = (tab: "cases" | "evaluators") => () =>
    navigatePlaygroundEvalsRoute({
      type: "suite-settings",
      suiteId: suite._id,
      tab,
    });
  const testCase = caseId
    ? (cases.find((item) => item._id === caseId) ?? null)
    : null;

  if (caseId && !testCase) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading test case…
      </div>
    );
  }

  if (route.type === "case-evaluators" && testCase) {
    return (
      <CaseEvaluatorsPage
        key={testCase._id}
        suite={suite}
        testCase={testCase}
        readOnly={readOnly}
        back={backButton}
        onConfigureSuite={suiteSettings("evaluators")}
      />
    );
  }

  return (
    <CaseStepsPage
      key={caseId ?? "new"}
      suite={suite}
      testCase={testCase}
      suiteCases={cases}
      projectId={projectId}
      projectServers={projectServers}
      readOnly={readOnly}
      back={backButton}
      onCreated={(testCaseId) =>
        navigatePlaygroundEvalsRoute(
          { type: "case-settings", suiteId: suite._id, testCaseId },
          { replace: true },
        )
      }
      onOpenEvaluators={(testCaseId) =>
        navigatePlaygroundEvalsRoute({
          type: "case-evaluators",
          suiteId: suite._id,
          testCaseId,
        })
      }
      onOpenSuiteSettings={suiteSettings("evaluators")}
      onRunCase={async (runnable): Promise<CaseRunOutcome | null> => {
        const data = await onRunCase(runnable, {
          location: "case_steps_editor",
          // The page confirms the run itself, with a link to it.
          suppressCompletionToasts: true,
        });
        return data ? { suiteRunId: data.iteration?.suiteRunId ?? null } : null;
      }}
      onOpenTestRun={(runId, testCaseId) =>
        navigatePlaygroundEvalsRoute({
          type: "test-run",
          suiteId: suite._id,
          runId,
          testCaseId,
        })
      }
      onDeleteCase={
        onDeleteCase
          ? async (testCaseId) => {
              await onDeleteCase(testCaseId);
              suiteSettings("cases")();
            }
          : undefined
      }
    />
  );
}
