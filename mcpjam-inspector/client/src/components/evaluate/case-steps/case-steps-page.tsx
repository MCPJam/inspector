/**
 * A test case on today's address, behind `eval-test-case-steps-editor`: the
 * steps editor at full width under its title row, with no past-results pane.
 * Test Case Evaluators, suite settings, runs and delete go through the suite
 * view's own routes and handlers. A New case (Add manually) opens here too;
 * Save case creates it and opens its page.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import type { RemoteServer } from "@/hooks/useProjects";
import { parseDraftTestCaseId } from "@/components/evals/draft-test-case";
import { CaseAccountPicker } from "@/components/evals/shared-account-pickers";
import { getStepsBlockReason } from "@/components/evals/test-template-editor";
import type {
  CaseRunLaunchOptions,
  EvalCase,
  EvalSuite,
} from "@/components/evals/types";
import { SuiteRunReview, type SuiteRunReviewProps } from "../suite-run-review";
import { CaseStepsEditor } from "./case-steps-editor";
import {
  CaseHeader,
  DeleteCaseDialog,
  NewCaseHeader,
} from "./case-steps-header";
import { caseStepsSuiteFacts } from "./case-steps-suite";
import { useCaseStepsDraft } from "./use-case-steps-draft";
import { useCaseTools } from "./use-case-tools";

/** The suite view's routes this page leaves by. `SuiteNavigation` fits it. */
export type CaseStepsPageNavigation = {
  toSuiteOverview: (suiteId: string, view?: "test-cases") => void;
  toTestEdit: (
    suiteId: string,
    testId: string,
    options?: { checks?: boolean; replace?: boolean },
  ) => void;
  toSuiteEdit: (
    suiteId: string,
    fromCaseChecks?: string,
    tab?: "evaluators",
  ) => void;
};

/**
 * Whether a suite route opens in this page: a saved case's own page, or a New
 * case from Add manually. Describe and Record drafts, a connected server's
 * draft, the evaluators page and links into past results keep today's editor.
 */
export function opensInStepsEditor(route: {
  type: string;
  testId?: string;
  checks?: boolean;
  openCompare?: boolean;
  iteration?: string;
  fromEvalServer?: string;
}): boolean {
  const draftKind = parseDraftTestCaseId(route.testId);
  return (
    route.type === "test-edit" &&
    !route.checks &&
    !route.openCompare &&
    !route.iteration &&
    !route.fromEvalServer &&
    (draftKind === null || draftKind === "prompt")
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
  /** Why this case's run would be refused for credits, as the suite view says. */
  runOutOfCreditsReason?: (testCase: EvalCase) => string | null;
  /** Deletes cases; absent hides Delete. */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  navigation: CaseStepsPageNavigation;
};

/** A case, or its suite, that is gone, with a way back to the list. */
function MissingCase({
  suiteGone,
  onOpen,
}: {
  suiteGone: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">
      <p>
        {suiteGone
          ? "This suite no longer exists."
          : "This test case no longer exists."}
      </p>
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
  runOutOfCreditsReason,
  onDeleteTestCasesBatch,
  navigation,
}: CaseStepsPageProps) {
  const isNew = parseDraftTestCaseId(testCaseId) === "prompt";
  const data = useCaseStepsDraft({
    suiteId,
    testCaseId: isNew ? null : testCaseId,
  });
  const tools = useCaseTools(projectId, data.suite);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Where this page is now, so a create that ends after the user moved on stays put.
  const here = useRef<string | null>(null);
  useEffect(() => {
    here.current = `${suiteId}/${testCaseId}`;
    return () => {
      here.current = null;
    };
  }, [suiteId, testCaseId]);

  const openTestCases = () => navigation.toSuiteOverview(suiteId, "test-cases");
  if (data.status === "missing")
    return <MissingCase suiteGone={!data.suite} onOpen={openTestCases} />;
  const { draft, card, suite, testCase } = data;
  if (!draft || !card || !suite || (!isNew && !testCase)) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        aria-busy="true"
      >
        <Loader2
          className="h-6 w-6 animate-spin text-primary"
          aria-label="Loading test case"
        />
      </div>
    );
  }
  // Nothing saves while locked: Save, Evaluators and Run's save step all stop.
  const locked = readOnly || data.readOnly;
  const editor = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6">
        <CaseStepsEditor
          draft={draft}
          onDraftChange={data.setDraft}
          card={card}
          suite={caseStepsSuiteFacts(suite, data.capabilities)}
          availableTools={tools}
          projectServers={projectServers}
          // Edits wait for a running save, so what it saves is what follows.
          readOnly={locked || data.saving}
          openKey={openKey}
          onOpenKeyChange={setOpenKey}
          onOpenSuiteSettings={() =>
            navigation.toSuiteEdit(suiteId, undefined, "evaluators")
          }
          onDraftValidityChange={data.setInvalidField}
        />
      </div>
    </div>
  );
  const setTitle = (title: string) =>
    data.setDraft((current) => ({ ...current, title }));

  if (isNew || !testCase) {
    const create = async () => {
      const startedOn = `${suiteId}/${testCaseId}`;
      const result = await data.save();
      if (result.ok && result.testCaseId && here.current === startedOn)
        navigation.toTestEdit(suiteId, result.testCaseId, { replace: true });
    };
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-testid="case-steps-page"
      >
        <NewCaseHeader
          title={draft.title}
          saving={data.saving}
          lockedReason={
            data.readOnly
              ? "This suite is managed by CI, so cases can't be added here."
              : readOnly
                ? "This suite is read-only, so cases can't be added here."
                : null
          }
          onTitleChange={setTitle}
          onSave={() => void create()}
        />
        {editor}
      </div>
    );
  }

  const unsaved = !locked && data.dirty;
  const runDisabledReason =
    launchReview.disabledReason ??
    (data.invalidField ? "Complete the highlighted fields first." : null) ??
    getStepsBlockReason(draft.steps) ??
    runOutOfCreditsReason?.(testCase) ??
    null;

  // Today's evaluators page reads the stored case, so pending edits save first.
  const openEvaluators = async () => {
    if (unsaved && !(await data.save()).ok) return;
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
    } catch {
      // The batch delete logs the failure; the toast says what to retry.
      toast.error("Could not delete the test case. Try again.");
      return;
    } finally {
      setDeleting(false);
    }
    toast.success("Test case deleted");
    setDeleteOpen(false);
    openTestCases();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="case-steps-page">
      <CaseHeader
        title={draft.title}
        savedTitle={testCase.title}
        onTitleChange={setTitle}
        dirty={data.dirty}
        saving={data.saving}
        readOnly={locked}
        runDisabledReason={runDisabledReason}
        onDelete={
          onDeleteTestCasesBatch ? () => setDeleteOpen(true) : undefined
        }
        onSave={() => void data.save()}
        onOpenEvaluators={locked ? undefined : () => void openEvaluators()}
        onRun={onRunCase ? () => setRunOpen(true) : undefined}
      />
      <CaseAccountPicker
        suite={suite}
        projectId={projectId}
        selections={draft.accounts ?? testCase.accounts}
        disabled={locked || data.saving}
        onChange={(accounts) => data.setDraft((current) => ({ ...current, accounts }))}
        className="shrink-0 space-y-1 px-2.5 pb-2 sm:px-4.5"
      />
      {editor}
      {runOpen && onRunCase ? (
        <SuiteRunReview
          {...launchReview}
          disabledReason={runDisabledReason}
          cases={[draft.accounts === undefined ? testCase : { ...testCase, accounts: draft.accounts }]}
          caseTitle={draft.title || testCase.title}
          initialIterations={draft.runs}
          onClose={() => setRunOpen(false)}
          onStart={startRun}
          saveBeforeRun={
            unsaved
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
