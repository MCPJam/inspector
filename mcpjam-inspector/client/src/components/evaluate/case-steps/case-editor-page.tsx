/**
 * The test case page (C7): the steps editor with the execution preview beside
 * it, and no past-runs pane. One page serves Suite settings › Test cases ›
 * case, New case, and Edit Test Case opened from a test run (D13), whose
 * breadcrumb and Back lead to that test run.
 */

import { useState } from "react";
import { ListChecks, Loader2 } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { EmptyState } from "@/components/ui/empty-state";
import { useAppRouteContext } from "@/lib/app-route-context";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useProjectServers } from "@/hooks/useProjects";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { Predicate } from "@/shared/eval-matching";
import { CaseStepsEditor } from "./case-steps-editor";
import { CasePageHeader } from "./case-page-header";
import {
  ExecutionPreviewPanel,
  useExecutionPreviewToggle,
} from "./execution-preview";
import { useCaseEditorDraft } from "./use-case-editor-draft";
import { useCaseTools } from "./use-case-tools";
import {
  caseBackTarget,
  caseIdOf,
  routeAfterSave,
  useEvaluateNavGo,
  type CaseEditorRoute,
} from "./case-editor-nav";

export function CaseEditorPage({ route }: { route: CaseEditorRoute }) {
  const { suiteId } = route;
  const caseId = caseIdOf(route);
  const { convexProjectId } = useAppRouteContext();
  const projectId: string | null = convexProjectId ?? null;
  const { isAuthenticated } = useConvexAuth();
  const canQuery = useActorCanQuery();
  const go = useEvaluateNavGo();
  const state = useCaseEditorDraft(suiteId, caseId);
  const { draft, suite } = state;
  const tools = useCaseTools({ suite, projectId, canQuery });
  const { servers: projectServers } = useProjectServers({
    isAuthenticated,
    projectId,
  });
  const { capabilities } = useSuiteCapabilities(suiteId);
  const preview = useExecutionPreviewToggle("editor");
  const [hasInvalidField, setHasInvalidField] = useState(false);

  const save = async () => {
    const savedId = await state.save();
    const next = savedId ? routeAfterSave(route, savedId) : null;
    if (next) go(next, "link", { replace: true });
    return savedId;
  };
  const openEvaluators = async () => {
    if (!caseId) return;
    if (state.isDirty && !(await state.save())) return;
    go({ type: "case-evaluators", suiteId, caseId }, "link");
  };

  if (state.status === "missing" || suite === null) {
    return (
      <div className="p-6">
        <EmptyState
          icon={ListChecks}
          title="Test case not found"
          description="It may have been deleted, or it belongs to another suite."
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => go(caseBackTarget(route).route, "back")}
          >
            {caseBackTarget(route).label}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const suiteDefaultPredicates = (suite?.defaultPredicates ??
    []) as Predicate[];
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="case-editor-page"
    >
      <CasePageHeader
        route={route}
        names={{ suiteName: suite?.name, caseName: draft?.title }}
        back={caseBackTarget(route)}
        onNavigate={go}
        title={
          <>
            <Input
              aria-label="Test case title"
              value={draft?.title ?? ""}
              disabled={!draft}
              onChange={(event) => state.update({ title: event.target.value })}
              className="h-9 max-w-md border-transparent bg-transparent px-2 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input"
            />
            {preview.button}
          </>
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!caseId || state.isSaving}
              title={caseId ? undefined : "Save the test case first."}
              onClick={() => void openEvaluators()}
            >
              <ListChecks className="size-4" aria-hidden="true" />
              Test Case Evaluators
            </Button>
            <Button
              type="button"
              variant={caseId ? "outline" : "default"}
              size="sm"
              disabled={
                !draft ||
                state.isSaving ||
                hasInvalidField ||
                (Boolean(caseId) && !state.isDirty)
              }
              onClick={() => void save()}
            >
              {state.isSaving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {caseId ? "Save" : "Create test case"}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
          <div className="mx-auto max-w-3xl">
            {draft ? (
              <CaseStepsEditor
                draft={draft}
                onDraftChange={state.update}
                suiteDefaultPredicates={suiteDefaultPredicates}
                suppressedSuiteStandardCheckIds={
                  state.testCase?.suppressedSuiteStandardCheckIds
                }
                suiteJudgeConfig={suite?.judgeConfig}
                capabilities={capabilities}
                availableTools={tools.availableTools}
                toolsStatus={tools.toolsStatus}
                onRetryTools={tools.retryTools}
                suiteServers={tools.suiteServers}
                projectServers={projectServers}
                onDraftValidityChange={setHasInvalidField}
                onOpenSuiteSettings={() =>
                  go(
                    { type: "suite-settings", suiteId, tab: "evaluators" },
                    "link",
                  )
                }
              />
            ) : (
              <div className="flex justify-center py-16 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" aria-label="Loading" />
              </div>
            )}
          </div>
        </main>
        {preview.open && draft ? (
          <ExecutionPreviewPanel
            input={{
              steps: draft.steps,
              predicates: draft.predicates,
              expectedOutput: draft.expectedOutput,
              suiteDefaultPredicates,
              suppressedSuiteStandardCheckIds:
                state.testCase?.suppressedSuiteStandardCheckIds,
            }}
            onClose={preview.close}
          />
        ) : null}
      </div>
    </div>
  );
}
