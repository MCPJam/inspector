import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "../../evals/eval-surface-chrome";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "../../evals/constants";
import type { EvalCase, EvalSuite } from "../../evals/types";
import {
  buildSuiteTestCaseRows,
  type SuiteTestCaseRow,
} from "../suite-detail-model";
import { SuiteEmptyCasesHero } from "../suite-detail-overview";
import { useSuiteCaseAuthoring } from "../suite-case-authoring";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";

export type SuiteTestCasesTabProps = {
  suite: EvalSuite;
  cases: EvalCase[];
  projectId: string | null;
  /** This surface offers no suite settings at all (desktop CI). */
  readOnlyConfig: boolean;
  /** CI owns the suite: cases open read-only and cannot be added. */
  configLocked: boolean;
  /** Absent hides each row's Delete. */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  /** Absent hides Import. */
  onImportCases?: () => void;
  /** Generate is offered and the suite can generate. */
  canGenerate: boolean;
  generateDisabledReason?: string;
  isGenerating: boolean;
  /** Extra buttons on each row, before Delete (Copy to another suite). */
  rowActions?: (row: SuiteTestCaseRow) => ReactNode;
};

/**
 * Suite settings › Test cases: the suite's cases, Add case, and the Generate
 * and Import reviews. It has no Save: each case saves on its own page.
 */
export function SuiteTestCasesTab({
  suite,
  cases,
  projectId,
  readOnlyConfig,
  configLocked,
  onDeleteTestCasesBatch,
  onImportCases,
  canGenerate,
  generateDisabledReason,
  isGenerating: isGeneratingTestCases,
  rowActions,
}: SuiteTestCasesTabProps) {
  const authoring = useSuiteCaseAuthoring({
    suite,
    projectId,
    readOnlyConfig,
    canGenerateTestCases: canGenerate,
    importJobId: null,
  });
  const rows = useMemo(() => buildSuiteTestCaseRows(cases), [cases]);
  const [caseToDelete, setCaseToDelete] = useState<SuiteTestCaseRow | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const readOnly = readOnlyConfig || configLocked;
  const canDelete = Boolean(onDeleteTestCasesBatch) && !readOnly;
  const isGenerating =
    isGeneratingTestCases || authoring.generation?.status === "running";
  const openCase = (testCaseId: string) =>
    navigatePlaygroundEvalsRoute({
      type: "case-settings",
      suiteId: suite._id,
      testCaseId,
    });
  const newCase = () =>
    navigatePlaygroundEvalsRoute({ type: "case-new", suiteId: suite._id });

  const confirmDelete = async () => {
    if (!caseToDelete || !onDeleteTestCasesBatch) return;
    setIsDeleting(true);
    try {
      await onDeleteTestCasesBatch([caseToDelete.caseId]);
      toast.success("Test case deleted");
      setCaseToDelete(null);
    } catch (error) {
      console.error("Failed to delete test case:", error);
      toast.error("Could not delete the test case. Try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  if (authoring.takeover) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col gap-3"
        data-testid="suite-settings-cases-takeover"
      >
        {authoring.exitTakeover ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={authoring.exitTakeover}
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to test cases
          </Button>
        ) : null}
        {authoring.takeover}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="suite-settings-cases">
      {authoring.generateDialog}
      {rows.length === 0 ? (
        <SuiteEmptyCasesHero
          readOnly={readOnly}
          onDescribe={newCase}
          onGenerate={authoring.openGenerate}
          canGenerate={authoring.canGenerate}
          generateDisabledReason={generateDisabledReason}
          isGenerating={isGenerating}
          onImport={onImportCases}
          fillRemaining={false}
        />
      ) : (
        <section className={evalSurfaceCardClass}>
          <div
            className={cn(
              evalSurfaceHeaderClass,
              "flex items-center justify-between gap-3 bg-muted/55 px-4 py-3",
            )}
          >
            <h3 className="text-sm font-semibold text-foreground">
              Test Cases
            </h3>
            {readOnly ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="sm" className="h-8 gap-1.5">
                    <Plus className="size-3.5" aria-hidden /> Add case
                    <ChevronDown className="size-3.5" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onSelect={newCase}>
                    New case
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!authoring.canGenerate || isGenerating}
                    onSelect={authoring.openGenerate}
                  >
                    {isGenerating ? "Generating…" : "Generate"}
                  </DropdownMenuItem>
                  {(!authoring.canGenerate || isGenerating) &&
                  generateDisabledReason ? (
                    <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                      {generateDisabledReason}
                    </p>
                  ) : null}
                  {onImportCases ? (
                    <DropdownMenuItem onSelect={onImportCases}>
                      Import
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <ul className="divide-y divide-border/40">
            {rows.map((row) => (
              <li
                key={row.caseId}
                className={cn(
                  "group flex items-center gap-1 pr-2",
                  evalSurfaceRowHoverClass,
                )}
              >
                <button
                  type="button"
                  data-testid={`suite-settings-case-${row.caseId}`}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left"
                  onClick={() => openCase(row.caseId)}
                >
                  <span className="text-sm font-medium text-foreground">
                    {row.title}
                  </span>
                  {row.summary ? (
                    <span className="text-xs text-muted-foreground">
                      {row.summary}
                    </span>
                  ) : null}
                </button>
                {rowActions?.(row)}
                {canDelete ? (
                  <button
                    type="button"
                    data-testid={`suite-settings-case-delete-${row.caseId}`}
                    onClick={() => setCaseToDelete(row)}
                    title="Delete test case"
                    aria-label={`Delete test case: ${row.title}`}
                    className="shrink-0 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog
        open={caseToDelete != null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setCaseToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-destructive" aria-hidden />
              Delete test case
            </DialogTitle>
            <DialogDescription>
              Delete “{caseToDelete?.title}”? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCaseToDelete(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
              data-testid="suite-settings-case-delete-confirm"
              onClick={confirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
