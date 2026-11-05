import { useState } from "react";
import { ChevronDown, FileUp, Plus, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  generationEnvironmentChoices,
  generationEnvironmentId,
} from "../../evals/helpers";
import { TestCasesOverview } from "../../evals/test-cases-overview";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { useCaseAuthoringTakeovers } from "../case-authoring-takeovers";
import { CopyCaseMenu, useCopyCaseToSuite } from "./copy-case-to-suite";
import { ImportDatasetDialog } from "../import-dataset-dialog";
import type { SuiteGenerateState } from "./suite-generate-state";

const NO_RUN_TREND: never[] = [];

/**
 * Suite settings › Test cases: the case list, Add case, and the Generate and
 * Import flows, which take over this tab while they run (DD4). Cases save on
 * their own pages, so this tab has no Save bar (DD3).
 */
export function SuiteSettingsCasesTab({
  suite,
  cases,
  runs,
  projectId,
  editingDisabled,
  generateState,
  connectedServerNames,
  onAddCase,
  onOpenCase,
  onOpenCopy,
  onDeleteCases,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  runs: EvalSuiteRunListItem[];
  projectId: string | null;
  /** CI-owned or read-only: the list shows, nothing in it can be changed. */
  editingDisabled: boolean;
  generateState: SuiteGenerateState | null;
  connectedServerNames: Set<string>;
  onAddCase: () => void;
  onOpenCase: (caseId: string) => void;
  /** Opens a copy this tab just made in another suite. */
  onOpenCopy: (suiteId: string, caseId: string) => void;
  onDeleteCases: (caseIds: string[]) => Promise<void>;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const authoring = useCaseAuthoringTakeovers({
    suite,
    projectId,
    readOnlyConfig: editingDisabled,
    canGenerateTestCases: generateState?.canGenerate ?? false,
  });
  const copy = useCopyCaseToSuite({
    projectId,
    sourceSuiteId: suite._id,
    onOpenCopy,
  });
  if (authoring.takeover) return authoring.takeover;

  const canImport = Boolean(projectId) && !editingDisabled;
  const generateDisabled =
    !authoring.canGenerate || authoring.generation?.status === "running";

  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-6"
      data-testid="suite-settings-cases-tab"
    >
      {authoring.generateDialog}
      {canImport && projectId ? (
        <ImportDatasetDialog
          key={suite._id}
          open={importOpen}
          onOpenChange={setImportOpen}
          projectId={projectId}
          suiteId={suite._id}
          environmentChoices={generationEnvironmentChoices(suite)}
          environmentId={generationEnvironmentId(suite)}
        />
      ) : null}
      {editingDisabled ? null : (
        <div className="flex items-center justify-end">
          <div className="inline-flex shrink-0 items-center">
            <Button
              type="button"
              size="sm"
              className="gap-1.5 rounded-r-none"
              onClick={onAddCase}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add case
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  className="rounded-l-none border-l border-primary-foreground/30 px-2"
                  aria-label="More ways to add cases"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={generateDisabled}
                  onSelect={authoring.handleGenerateCases}
                  title={generateState?.disabledReason}
                >
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Generate cases
                </DropdownMenuItem>
                {canImport ? (
                  <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                    <FileUp className="h-4 w-4" aria-hidden />
                    Import from a file
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
      <TestCasesOverview
        suite={suite}
        cases={cases}
        runs={runs}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={() => undefined}
        hideViewModeSelect
        onTestCaseClick={onOpenCase}
        clickHint="Click a case to open it."
        runTrendData={NO_RUN_TREND}
        modelStats={NO_RUN_TREND}
        runsLoading={false}
        connectedServerNames={connectedServerNames}
        onDeleteTestCasesBatch={editingDisabled ? undefined : onDeleteCases}
        onCreateTestCase={editingDisabled ? undefined : onAddCase}
        onGenerateTestCases={
          editingDisabled ? undefined : authoring.handleGenerateCases
        }
        canGenerateTestCases={!generateDisabled}
        generateTestCasesDisabledReason={generateState?.disabledReason}
        renderRowActions={(testCase) => (
          <CopyCaseMenu
            testCase={testCase}
            targets={copy.targets}
            copying={copy.copyingCaseId === testCase._id}
            onCopy={(source, target) => void copy.copyCase(source, target)}
          />
        )}
      />
    </div>
  );
}
