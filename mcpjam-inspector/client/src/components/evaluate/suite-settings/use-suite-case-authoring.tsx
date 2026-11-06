import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  evalSuiteKey,
  followAuthoringJob,
  markImportReviewSeen,
  reopenImportReview,
  useEvalGeneration,
} from "@/lib/mcpjam-agent/eval-workspace";
import type { GenerateCasesConfig } from "@/lib/evals/eval-generation-config";
import {
  generationEnvironmentChoices,
  generationEnvironmentId,
} from "@/components/evals/helpers";
import type { EvalSuite } from "@/components/evals/types";
import { GenerateCasesDialog } from "../generate-cases-dialog";
import { EvalGenerationWorkspace } from "../eval-generation-workspace";
import { EvalGeneratedDrafts } from "../eval-generated-drafts";
import { ImportDatasetDialog } from "../import-dataset-dialog";
import { SuiteEmptyCasesHero } from "../suite-detail-overview";
import type { AddCaseItem } from "./suite-cases-card";

/** Reveal imported drafts one at a time, so the list reads as being built. */
function useDraftReveal(draftIds: readonly string[]) {
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const nextId = draftIds.find((id) => !visible.has(id));
  useEffect(() => {
    if (!nextId) return;
    const timer = window.setTimeout(
      () => setVisible((shown) => new Set([...shown, nextId])),
      220,
    );
    return () => window.clearTimeout(timer);
  }, [nextId]);
  return visible;
}

/**
 * Generate and Import for the Test cases tab: the add-case items, the
 * takeovers that replace the card while they run, and their dialogs. The
 * rules follow the Suite page these surfaces came from.
 */
export function useSuiteCaseAuthoring(args: {
  suite: EvalSuite;
  projectId: string | null;
  locked: boolean;
  importJobId: string | null;
  onClearImportJob(): void;
  onDescribe(): void;
  onAddManually(): void;
  canGenerate: boolean;
  generateDisabledReason?: string;
}): {
  addCaseItems: AddCaseItem[] | null;
  takeover: ReactNode | null;
  dialogs: ReactNode;
  reviewDraftsButton: ReactNode | null;
  emptyHero: ReactNode;
} {
  const { suite, projectId, locked, importJobId } = args;
  const suiteId = suite._id;
  const generation = useEvalGeneration((state) =>
    projectId && !locked
      ? state.suites[evalSuiteKey({ projectId, suiteId })]
      : undefined,
  );
  const isGenerating = generation?.status === "running";
  const canGenerate = args.canGenerate && Boolean(projectId) && !locked;
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationConfig, setGenerationConfig] =
    useState<GenerateCasesConfig>();
  const [importOpen, setImportOpen] = useState(false);

  // Imported drafts carry document provenance; generated ones do not.
  const importedDrafts =
    generation?.drafts.filter((draft) => draft.authoring?.source) ?? [];
  useEffect(() => {
    if (!projectId || !importJobId) return;
    // Opening a review link IS the request to review that job.
    void followAuthoringJob({ projectId, suiteId }, importJobId, {
      takeOver: true,
      source: "import",
    });
  }, [projectId, importJobId, suiteId]);
  const importRunning =
    isGenerating &&
    (generation?.authoringSource === "import" ||
      generation?.authoringSource === "markdown");
  const reviewingImport = Boolean(
    projectId &&
    (importedDrafts.length || importRunning) &&
    (Boolean(importJobId) ||
      importRunning ||
      generation?.reviewRequestId !== generation?.reviewSeenId),
  );
  const visibleDraftIds = useDraftReveal(importedDrafts.map((d) => d.id));
  // Read through a ref: callers pass inline arrows.
  const onClearImportJobRef = useRef(args.onClearImportJob);
  useEffect(() => {
    onClearImportJobRef.current = args.onClearImportJob;
  }, [args.onClearImportJob]);
  const exitImportReview = useCallback(() => {
    if (projectId) markImportReviewSeen({ projectId, suiteId });
    onClearImportJobRef.current();
  }, [projectId, suiteId]);

  const openGenerate = () => {
    if (projectId) setGenerationOpen(true);
  };
  const openImport = projectId && !locked ? () => setImportOpen(true) : null;
  const exitGeneration = useCallback(() => setGenerationConfig(undefined), []);

  const addCaseItems: AddCaseItem[] | null = locked
    ? null
    : [
        {
          label: "Describe",
          description: "Tell us a behavior. Chat drafts the case",
          onSelect: args.onDescribe,
        },
        {
          label: "Generate",
          description: "From live discovery of your servers",
          onSelect: openGenerate,
          disabled: !canGenerate || isGenerating,
          busyLabel: isGenerating ? "Generating…" : undefined,
        },
        ...(openImport
          ? [
              {
                label: "Import" as const,
                description: "Document → draft cases",
                onSelect: openImport,
              },
            ]
          : []),
        {
          label: "Add manually",
          description: "Write the steps and assertions yourself",
          onSelect: args.onAddManually,
        },
      ];

  let takeover: ReactNode | null = null;
  if (generationConfig && projectId) {
    takeover = (
      <div className="flex min-h-[24rem] flex-col">
        <EvalGenerationWorkspace
          key={`${projectId}:${suiteId}`}
          config={generationConfig}
          environmentId={generationEnvironmentId(
            suite,
            generationConfig.environmentId,
          )}
          projectId={projectId}
          suiteId={suiteId}
          suiteName={suite.name}
          onChangeSettings={() => {
            setGenerationConfig(undefined);
            setGenerationOpen(true);
          }}
          onDone={exitGeneration}
        />
      </div>
    );
  } else if (reviewingImport && projectId) {
    takeover = (
      <div data-testid="suite-import-review">
        <EvalGeneratedDrafts
          visibleDraftIds={visibleDraftIds}
          key={`${projectId}:${suiteId}:import`}
          projectId={projectId}
          suiteId={suiteId}
          suiteName={suite.name}
        />
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            data-testid="suite-import-review-close"
            onClick={exitImportReview}
          >
            Back to test cases
          </Button>
        </div>
      </div>
    );
  }

  const dialogs = (
    <>
      {generationOpen ? (
        <GenerateCasesDialog
          key={suiteId}
          suiteId={suiteId}
          environmentChoices={generationEnvironmentChoices(suite)}
          onClose={() => setGenerationOpen(false)}
          onGenerate={(config) => {
            setGenerationOpen(false);
            setGenerationConfig(config);
          }}
        />
      ) : null}
      {projectId && !locked ? (
        <ImportDatasetDialog
          key={suiteId}
          open={importOpen}
          onOpenChange={setImportOpen}
          projectId={projectId}
          suiteId={suiteId}
          environmentChoices={generationEnvironmentChoices(suite)}
          environmentId={generationEnvironmentId(suite)}
        />
      ) : null}
    </>
  );

  const reviewDraftsButton =
    importedDrafts.length && !reviewingImport ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        data-testid="suite-resume-import-review"
        onClick={() => projectId && reopenImportReview({ projectId, suiteId })}
      >
        {importedDrafts.length === 1
          ? "Review 1 draft case"
          : `Review ${importedDrafts.length} draft cases`}
      </Button>
    ) : null;

  const emptyHero = (
    <SuiteEmptyCasesHero
      readOnly={locked}
      onDescribe={args.onDescribe}
      onGenerate={openGenerate}
      canGenerate={canGenerate}
      generateDisabledReason={args.generateDisabledReason}
      isGenerating={isGenerating}
      onImport={openImport ?? undefined}
      fillRemaining={false}
    />
  );

  return { addCaseItems, takeover, dialogs, reviewDraftsButton, emptyHero };
}
