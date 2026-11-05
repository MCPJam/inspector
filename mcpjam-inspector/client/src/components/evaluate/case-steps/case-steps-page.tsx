/**
 * The Test case page: the steps editor, reached from Suite settings (or from
 * a test run). It shows no results; those live on Test run pages.
 *
 * Header: the case title and the execution preview toggle. Delete, Test
 * Case Evaluators, Run and Back sit in the breadcrumb bar, with Save while
 * there are unsaved edits. Run
 * saves first, keeps the user here and confirms with a toast that links to
 * the new test run (plan O4).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Diamond, ListChecks, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import type { RemoteServer } from "@/hooks/useProjects";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import { EvalHeaderActions, EvalHeaderBack } from "../nav/eval-header-actions";
import { trackEvalNav } from "../nav/eval-nav-events";
import { buildExecutionPreview, type EditorAnchor } from "./case-steps-model";
import { caseSavePayload, draftScorecard } from "./case-steps-draft";
import { useCaseStepsDraft } from "./use-case-steps-draft";
import { useCaseTools } from "./use-case-tools";
import { anchorFromSearch, endOfRunOf, revealAnchor } from "./editor-rows";
import { CaseStepsEditor } from "./case-steps-editor";
import { ExecutionPreviewPanel } from "./execution-preview-panel";
import { DeleteCaseDialog } from "./delete-case-dialog";

export type CaseRunOutcome = { suiteRunId: string | null };

export type CaseStepsPageProps = {
  suite: EvalSuite;
  /** Null on New case. */
  testCase: EvalCase | null;
  suiteCases: EvalCase[];
  projectId?: string | null;
  projectServers?: RemoteServer[];
  readOnly: boolean;
  back: { label: string; onClick: () => void };
  onCreated: (testCaseId: string) => void;
  onOpenEvaluators: (testCaseId: string) => void;
  onOpenSuiteSettings: () => void;
  onRunCase: (testCase: EvalCase) => Promise<CaseRunOutcome | null>;
  onOpenTestRun: (runId: string, testCaseId: string) => void;
  onDeleteCase?: (testCaseId: string) => Promise<void>;
};

export function CaseStepsPage({
  suite,
  testCase,
  suiteCases,
  projectId,
  projectServers,
  readOnly,
  back,
  onCreated,
  onOpenEvaluators,
  onOpenSuiteSettings,
  onRunCase,
  onOpenTestRun,
  onDeleteCase,
}: CaseStepsPageProps) {
  const { draft, update, dirty, edited, discard, saving, save } =
    useCaseStepsDraft({ suiteId: suite._id, testCase, suiteCases, onCreated });
  // Leaving with edits asks first. A save in flight lets New case move to
  // its saved address, and a deleted case takes its edits with it.
  const deletingCase = useRef(false);
  const letsThrough = useCallback(() => deletingCase.current, []);
  useUnsavedChangesGuard(
    edited && !saving,
    discard,
    "You have unsaved changes to this test case. Leave without saving?",
    false,
    letsThrough,
  );
  const { capabilities } = useSuiteCapabilities(suite._id);
  const { tools } = useCaseTools(suite, projectId);
  const suiteServers = useMemo(() => getEffectiveSuiteServers(suite), [suite]);
  const card = useMemo(
    () =>
      draftScorecard(draft, suite, capabilities?.judges?.goalCompletion.policy),
    [draft, suite, capabilities],
  );
  const preview = useMemo(
    () => buildExecutionPreview(draft.steps, card),
    [draft.steps, card],
  );
  const endOfRun = endOfRunOf(preview);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeAnchor, setActiveAnchor] = useState<EditorAnchor | null>(() =>
    anchorFromSearch(window.location.search),
  );
  const editorRef = useRef<HTMLDivElement>(null);
  const arrivalAnchor = useRef(activeAnchor);

  // Opened at a step (`?step=…`, from a preview on the Test run page): scroll to it once
  // the steps have rendered. Later moves go through `openAnchor`.
  useLayoutEffect(() => {
    const anchor = arrivalAnchor.current;
    if (anchor && editorRef.current) revealAnchor(editorRef.current, anchor);
  }, []);
  useEffect(() => {
    if (!activeAnchor) return;
    const timer = setTimeout(() => setActiveAnchor(null), 2400);
    return () => clearTimeout(timer);
  }, [activeAnchor]);

  const openAnchor = (anchor: EditorAnchor) => {
    setActiveAnchor(anchor);
    if (editorRef.current) revealAnchor(editorRef.current, anchor);
  };
  const togglePreview = () => {
    if (!previewOpen)
      trackEvalNav("eval_execution_preview_opened", { surface: "editor" });
    setPreviewOpen(!previewOpen);
  };

  const run = async () => {
    if (!testCase || running) return;
    if (dirty && !(await save())) return;
    setRunning(true);
    try {
      const outcome = await onRunCase({
        ...testCase,
        ...caseSavePayload(draft),
      });
      if (!outcome) return;
      const runId = outcome.suiteRunId;
      toast.success("Test run finished", {
        action: runId
          ? {
              label: "Open test run",
              onClick: () => onOpenTestRun(runId, testCase._id),
            }
          : undefined,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <EvalHeaderActions>
        {!readOnly && dirty ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={() => void save()}
          >
            {testCase ? "Save changes" : "Create test case"}
          </Button>
        ) : null}
        {testCase && onDeleteCase && !readOnly ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Delete test case"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!testCase}
          title={testCase ? undefined : "Create the test case first."}
          onClick={() => testCase && onOpenEvaluators(testCase._id)}
        >
          <ListChecks className="size-4" aria-hidden="true" />
          Test Case Evaluators
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!testCase || running || saving}
          title={testCase ? undefined : "Create the test case first."}
          onClick={() => void run()}
        >
          <Play className="size-4" aria-hidden="true" />
          {running ? "Running…" : "Run"}
        </Button>
        <EvalHeaderBack label={back.label} onClick={back.onClick} />
      </EvalHeaderActions>
      <header className="mx-6 flex flex-wrap items-center gap-3 border-b border-border py-4">
        <Input
          aria-label="Test case title"
          value={draft.title}
          readOnly={readOnly}
          onChange={(event) => update({ title: event.target.value })}
          className="h-9 w-auto min-w-0 max-w-xl border-transparent bg-transparent px-1 text-lg font-semibold shadow-none [field-sizing:content] md:text-lg hover:border-border focus-visible:border-border"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn("size-8", previewOpen && "bg-muted")}
          aria-pressed={previewOpen}
          aria-label="Execution preview"
          title="Execution preview"
          onClick={togglePreview}
        >
          <Diamond className="size-4" />
        </Button>
      </header>
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-8",
          previewOpen && "lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]",
        )}
      >
        {previewOpen ? (
          <div className="lg:sticky lg:top-0 lg:self-start">
            <ExecutionPreviewPanel
              items={preview}
              onOpenStep={openAnchor}
              onClose={() => setPreviewOpen(false)}
            />
          </div>
        ) : null}
        <div ref={editorRef} className="mx-auto w-full max-w-4xl">
          <CaseStepsEditor
            draft={draft}
            onChange={update}
            card={card}
            endOfRun={endOfRun}
            suiteServers={suiteServers}
            projectServers={projectServers}
            availableTools={tools}
            capabilities={capabilities}
            readOnly={readOnly}
            activeAnchor={activeAnchor}
            onOpenSuiteSettings={onOpenSuiteSettings}
          />
        </div>
      </div>
      {testCase && onDeleteCase ? (
        <DeleteCaseDialog
          open={deleting}
          title={testCase.title}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            deletingCase.current = true;
            try {
              await onDeleteCase(testCase._id);
            } finally {
              deletingCase.current = false;
              setDeleting(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
