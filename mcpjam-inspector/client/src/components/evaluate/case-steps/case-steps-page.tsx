/**
 * New case, Test case and Edit Test Case (from a test run): the steps editor
 * with its execution preview, under the page's own crumb bar and title row.
 * case-settings and test-run-edit render the same editor; only the crumbs,
 * Back and where Delete lands differ.
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { UNSAFE_LocationContext } from "react-router";
import { Button } from "@mcpjam/design-system/button";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { EvalExportModal } from "@/components/evals/eval-export-modal";
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import { useSelectedRun } from "@/components/evals/use-selected-run";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import type { Predicate } from "@/shared/eval-matching";
import { EvalCrumbBar } from "../evals-header";
import { SuiteRunReview } from "../suite-run-review";
import { trackEvalNav, useEvalNavPageView } from "../nav/eval-nav-analytics";
import {
  buildEvalBack,
  buildEvalCrumbs,
  type EvalNavNames,
} from "../nav/eval-nav-crumbs";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import { useEvalNavArrival } from "../nav/eval-nav-state";
import { readCaseStepParam } from "./case-step-deep-link";
import { CaseStepsEditor } from "./case-steps-editor";
import {
  CaseHeader,
  DeleteCaseDialog,
  NewCaseHeader,
  SuiteSettingsBanner,
} from "./case-steps-header";
import { buildExecutionPreview } from "./case-steps-model";
import {
  ExecutionPreviewPanel,
  ExecutionPreviewToggle,
  useExecutionPreviewOpen,
} from "./execution-preview-panel";
import { CaseLayout, NewCaseLayout } from "./case-steps-layout";
import { useCasePageActions } from "./use-case-page-actions";
import { useCaseStepJump } from "./use-case-step-jump";
import { useCaseStepsDraft } from "./use-case-steps-draft";
import { useCaseTools } from "./use-case-tools";

type CasePageRoute = Extract<
  EvalNavPageProps["route"],
  { type: "case-new" | "case-settings" | "test-run-edit" }
>;

export function CaseStepsNavPage({ route, projectId }: EvalNavPageProps) {
  if (
    route.type !== "case-new" &&
    route.type !== "case-settings" &&
    route.type !== "test-run-edit"
  )
    return null;
  return <CaseStepsPage route={route} projectId={projectId} />;
}

/** "This test case no longer exists." with a way back to the case list. */
export function MissingCase({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">
      <p>This test case no longer exists.</p>
      <Button
        type="button"
        variant="link"
        className="h-auto px-0"
        onClick={onOpen}
      >
        Open Suite settings
      </Button>
    </div>
  );
}

function CaseStepsPage({
  route,
  projectId,
}: {
  route: CasePageRoute;
  projectId: string | null;
}) {
  const isNew = route.type === "case-new";
  const data = useCaseStepsDraft({
    suiteId: route.suiteId,
    testCaseId: isNew ? null : route.testCaseId,
  });
  const { run } = useSelectedRun(
    route.suiteId,
    route.type === "test-run-edit" ? route.runId : null,
  );
  const names: EvalNavNames = {
    suiteName: data.suite ? stripTimestampSuffix(data.suite.name) : undefined,
    testCaseTitle: data.testCase?.title,
    runNumber: run?.runNumber ?? undefined,
  };
  const { from } = useEvalNavArrival();
  useEvalNavPageView(route, { projectId, ui: "nav", enabled: true });
  const actions = useCasePageActions({ route, names, data });
  const tools = useCaseTools(projectId, data.suite);
  const appState = useOptionalSharedAppState();

  const [previewOpen, setPreviewOpen] = useExecutionPreviewOpen();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const jump = useCaseStepJump({
    onOpenKeyChange: setOpenKey,
    onClosePreview: () => setPreviewOpen(false),
  });
  const items = useMemo(
    () => (data.previewInput ? buildExecutionPreview(data.previewInput) : []),
    [data.previewInput],
  );

  // ?step= opens the editor at a row, once per case, once the draft exists.
  const search = useContext(UNSAFE_LocationContext)?.location.search ?? "";
  const arrivedFor = useRef<string | null>(null);
  const caseKey = isNew ? "new" : route.testCaseId;
  useEffect(() => {
    if (data.status !== "ready" || !data.draft) return;
    if (arrivedFor.current === caseKey) return;
    arrivedFor.current = caseKey;
    const key = readCaseStepParam(search, data.draft.steps);
    if (key) jump.arriveAt(key);
  }, [data.status, data.draft, caseKey, search, jump.arriveAt]);

  const crumbBar = (
    <EvalCrumbBar
      crumbs={buildEvalCrumbs(route, names) ?? []}
      back={buildEvalBack(route, names, from)}
    />
  );
  if (data.status === "missing") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {crumbBar}
        <MissingCase onOpen={() => actions.openSuiteSettings("cases")} />
      </div>
    );
  }
  const { draft, card, suite } = data;
  if (data.status === "loading" || !draft || !card || !suite) {
    return <div className="flex min-h-0 flex-1 flex-col">{crumbBar}</div>;
  }

  const setTitle = (title: string) =>
    data.setDraft((current) => ({ ...current, title }));
  const toggle = (
    <ExecutionPreviewToggle
      open={previewOpen}
      onToggle={() => {
        // A user's click only; restoring the stored open state sends nothing.
        if (!previewOpen)
          trackEvalNav("eval_execution_preview_opened", {
            surface: "editor",
            project_id: projectId,
          });
        setPreviewOpen(!previewOpen);
      }}
    />
  );
  const panel = previewOpen ? (
    <ExecutionPreviewPanel
      items={items}
      variant="editor"
      flashKey={jump.flashKey}
      onJump={jump.jumpTo}
      onClose={() => setPreviewOpen(false)}
    />
  ) : null;
  const editor = (
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
      projectServers={actions.services.projectServers}
      readOnly={data.readOnly}
      openKey={openKey}
      onOpenKeyChange={setOpenKey}
      flashKey={jump.flashKey}
      arriving={jump.arriving}
      onOpenSuiteSettings={actions.openSuiteSettings}
      onDraftValidityChange={data.setInvalidField}
    />
  );
  const exportModal = (
    <EvalExportModal
      open={actions.exporting.open}
      onOpenChange={actions.exporting.setOpen}
      scope="test-case"
      projectId={projectId}
      suite={suite}
      cases={actions.exporting.open ? actions.exporting.cases() : []}
      serverEntries={appState?.servers ?? {}}
    />
  );

  if (isNew) {
    const saveDisabled = !draft.steps.some(
      (step) => step.kind === "prompt" && step.prompt.trim(),
    );
    const body = (
      <>
        <SuiteSettingsBanner
          onOpen={() => actions.openSuiteSettings("evaluators")}
        />
        {editor}
      </>
    );
    return (
      <>
        <NewCaseLayout
          crumbBar={crumbBar}
          panel={panel}
          header={
            <NewCaseHeader
              title={draft.title}
              onTitleChange={setTitle}
              previewToggle={toggle}
              saveDisabled={saveDisabled || data.readOnly}
              onSave={() => void actions.saveCase()}
              onExport={() => actions.exporting.setOpen(true)}
            />
          }
        >
          {body}
        </NewCaseLayout>
        {exportModal}
      </>
    );
  }

  const testCase = data.testCase;
  const runDisabledReason = actions.services.evalRunsDisabledReason;
  return (
    <>
      <CaseLayout
        crumbBar={crumbBar}
        panel={panel}
        header={
          <CaseHeader
            title={draft.title}
            savedTitle={testCase?.title ?? ""}
            onTitleChange={setTitle}
            previewToggle={toggle}
            dirty={data.dirty}
            readOnly={data.readOnly}
            runDisabledReason={runDisabledReason}
            onDelete={() => actions.remove.setOpen(true)}
            onSave={() => void data.save()}
            onOpenEvaluators={() => void actions.openEvaluators()}
            onRun={() => actions.run.setOpen(true)}
          />
        }
      >
        {editor}
      </CaseLayout>
      {actions.run.open && testCase ? (
        <SuiteRunReview
          {...actions.services.launchReview(suite)}
          cases={[testCase]}
          caseTitle={draft.title || testCase.title}
          initialIterations={draft.runs}
          onClose={() => actions.run.setOpen(false)}
          onStart={actions.run.start}
          saveBeforeRun={
            data.dirty
              ? async () => (await data.save({ quiet: true })).ok
              : undefined
          }
        />
      ) : null}
      <DeleteCaseDialog
        open={actions.remove.open}
        title={draft.title}
        deleting={actions.remove.deleting}
        onOpenChange={actions.remove.setOpen}
        onConfirm={() => void actions.remove.confirm()}
      />
      {exportModal}
    </>
  );
}
