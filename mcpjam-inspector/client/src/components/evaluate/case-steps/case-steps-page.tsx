/**
 * A saved test case on today's address, behind `eval-test-case-steps-editor`:
 * the steps editor at full width under its title row, with no past-results
 * pane. Test Case Evaluators, suite settings, runs and delete go through the
 * suite view's own routes and handlers.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import type { RemoteServer } from "@/hooks/useProjects";
import { isDraftTestCaseId } from "@/components/evals/draft-test-case";
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import type { CaseRunLaunchOptions, EvalSuite } from "@/components/evals/types";
import type { Predicate } from "@/shared/eval-matching";
import { SuiteRunReview, type SuiteRunReviewProps } from "../suite-run-review";
import { CaseStepsEditor } from "./case-steps-editor";
import { CaseHeader, DeleteCaseDialog } from "./case-steps-header";
import { useCaseStepsDraft } from "./use-case-steps-draft";
import { useCaseTools } from "./use-case-tools";

/** The suite view's routes this page leaves by. `SuiteNavigation` fits it. */
export type CaseStepsPageNavigation = {
  toSuiteOverview: (suiteId: string, view?: "test-cases") => void;
  toTestEdit: (
    suiteId: string,
    testId: string,
    options?: { checks?: boolean },
  ) => void;
  toSuiteEdit: (
    suiteId: string,
    fromCaseChecks?: string,
    tab?: "evaluators",
  ) => void;
};

/**
 * Whether a suite route opens in this page: a saved case's own page. A new
 * draft, the evaluators page and links into past results keep today's editor.
 */
export function opensInStepsEditor(route: {
  type: string;
  testId?: string;
  checks?: boolean;
  openCompare?: boolean;
  iteration?: string;
}): boolean {
  return (
    route.type === "test-edit" &&
    !route.checks &&
    !route.openCompare &&
    !route.iteration &&
    !isDraftTestCaseId(route.testId)
  );
}

export type CaseStepsPageProps = {
  suiteId: string;
  testCaseId: string;
  projectId: string | null;
  /** The suite view's own lock (read-only config, locked suite). */
  readOnly: boolean;
  projectServers?: RemoteServer[];
  launchReview: Omit<
    SuiteRunReviewProps,
    "cases" | "caseTitle" | "initialIterations" | "onClose" | "onStart"
  >;
  /** Absent where this viewer cannot launch runs; Run is hidden then. */
  onRunCase?: (
    caseId: string,
    opts?: CaseRunLaunchOptions,
  ) => void | Promise<void>;
  /** Deletes cases; absent hides Delete. */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  navigation: CaseStepsPageNavigation;
};

/** "This test case no longer exists." with a way back to the list. */
function MissingCase({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">
      <p>This test case no longer exists.</p>
      <Button
        type="button"
        variant="link"
        className="h-auto px-0"
        onClick={onOpen}
      >
        Open test cases
      </Button>
    </div>
  );
}

export function CaseStepsPage({
  suiteId,
  testCaseId,
  projectId,
  readOnly,
  projectServers,
  launchReview,
  onRunCase,
  onDeleteTestCasesBatch,
  navigation,
}: CaseStepsPageProps) {
  const data = useCaseStepsDraft({ suiteId, testCaseId });
  const tools = useCaseTools(projectId, data.suite);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const openTestCases = () => navigation.toSuiteOverview(suiteId, "test-cases");
  if (data.status === "missing") return <MissingCase onOpen={openTestCases} />;
  const { draft, card, suite, testCase } = data;
  if (!draft || !card || !suite || !testCase) {
    return <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" />;
  }
  const locked = readOnly || data.readOnly;

  // Today's evaluators page reads the stored case, so pending edits save first.
  const openEvaluators = async () => {
    if (data.dirty && !(await data.save()).ok) return;
    navigation.toTestEdit(suiteId, testCaseId, { checks: true });
  };

  const startRun = (
    launchSuite: EvalSuite,
    options: CaseRunLaunchOptions & { iterationOverride: number },
  ) =>
    onRunCase?.(testCase._id, {
      ...options,
      suiteOverride: launchSuite,
      skipJudge: draft.judgeConfigOverride?.goalCompletion?.enabled === false,
    });

  const confirmDelete = async () => {
    if (!onDeleteTestCasesBatch || deleting) return;
    setDeleting(true);
    try {
      await onDeleteTestCasesBatch([testCase._id]);
      toast.success("Test case deleted");
      setDeleteOpen(false);
      openTestCases();
    } catch {
      // The batch delete logs the failure; the toast says what to retry.
      toast.error("Could not delete the test case. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="case-steps-page">
      <CaseHeader
        title={draft.title}
        savedTitle={testCase.title}
        onTitleChange={(title) =>
          data.setDraft((current) => ({ ...current, title }))
        }
        dirty={data.dirty}
        readOnly={locked}
        runDisabledReason={launchReview.disabledReason ?? null}
        onDelete={
          onDeleteTestCasesBatch ? () => setDeleteOpen(true) : undefined
        }
        onSave={() => void data.save()}
        onOpenEvaluators={() => void openEvaluators()}
        onRun={onRunCase ? () => setRunOpen(true) : undefined}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6">
          <CaseStepsEditor
            draft={draft}
            onDraftChange={data.setDraft}
            card={card}
            suite={{
              name: stripTimestampSuffix(suite.name),
              judgeConfig: suite.judgeConfig,
              defaultPredicates: (suite.defaultPredicates ?? []) as Predicate[],
              servers: getEffectiveSuiteServers(suite),
              defaultMatchOptions: suite.defaultMatchOptions,
            }}
            availableTools={tools}
            projectServers={projectServers}
            readOnly={locked}
            openKey={openKey}
            onOpenKeyChange={setOpenKey}
            onOpenSuiteSettings={() =>
              navigation.toSuiteEdit(suiteId, undefined, "evaluators")
            }
            onDraftValidityChange={data.setInvalidField}
          />
        </div>
      </div>
      {runOpen && onRunCase ? (
        <SuiteRunReview
          {...launchReview}
          cases={[testCase]}
          caseTitle={draft.title || testCase.title}
          initialIterations={draft.runs}
          onClose={() => setRunOpen(false)}
          onStart={startRun}
          saveBeforeRun={
            data.dirty
              ? async () => (await data.save({ quiet: true })).ok
              : undefined
          }
        />
      ) : null}
      <DeleteCaseDialog
        open={deleteOpen}
        title={draft.title}
        deleting={deleting}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
