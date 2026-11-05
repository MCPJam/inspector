import { useCallback, useEffect, useRef, useState } from "react";
import type { GenerateCasesConfig } from "@/lib/evals/eval-generation-config";
import {
  evalSuiteKey,
  followAuthoringJob,
  markImportReviewSeen,
  useEvalGeneration,
} from "@/lib/mcpjam-agent/eval-workspace";
import {
  generationEnvironmentChoices,
  generationEnvironmentId,
} from "../evals/helpers";
import type { EvalSuite } from "../evals/types";
import { EvalGeneratedDrafts } from "./eval-generated-drafts";
import { EvalGenerationWorkspace } from "./eval-generation-workspace";
import { GenerateCasesDialog } from "./generate-cases-dialog";

export interface CaseAuthoringTakeoverOptions {
  suite: EvalSuite;
  projectId: string | null;
  readOnlyConfig: boolean;
  canGenerateTestCases: boolean;
  /** An authoring job whose drafts to open on (`?importJob=`). */
  importJobId?: string | null;
  /** Drop `?importJob=` from the URL. */
  onClearImportJob?: () => void;
  /** Reports a takeover opening and closing, with the way back out of it. */
  onGeneratingChange?: (
    state: { exit: () => void; label?: string } | null,
  ) => void;
}

/**
 * The Generate and Import review flows that take over a case list: the
 * generation scope dialog, the generation workspace, and the imported-drafts
 * review. Shared by the suite page and Suite settings › Test cases (DD4).
 */
export function useCaseAuthoringTakeovers({
  suite,
  projectId,
  readOnlyConfig,
  canGenerateTestCases,
  importJobId = null,
  onClearImportJob,
  onGeneratingChange,
}: CaseAuthoringTakeoverOptions) {
  const generation = useEvalGeneration((state) =>
    projectId && !readOnlyConfig
      ? state.suites[evalSuiteKey({ projectId, suiteId: suite._id })]
      : undefined,
  );
  /**
   * Imported drafts get their OWN surface, the way generation does. They are
   * not in the suite and cannot run, so listing them beside real cases invited
   * exactly one reading: that the import had already landed.
   *
   * What marks a draft as imported is document provenance: the authoring job
   * cites the file it read. Generation invents cases from the suite's tools and
   * has nothing to cite, so it never reaches this surface.
   */
  const importedDrafts =
    generation?.drafts.filter((draft) => draft.authoring?.source) ?? [];
  useEffect(() => {
    // Linked-to jobs are followed, not assumed: the poll stages whatever the
    // job still holds, and committed drafts are already excluded from it, so
    // the surface opens on exactly the cases that still need a person.
    if (!projectId || !importJobId) return;
    // `takeOver`, because opening a review link IS the request to review that
    // job. Without it the link stood down to whatever id the suite still
    // held, and a failed job keeps its id: a colleague's link then showed the
    // reader their own dead import instead of the job they were sent.
    void followAuthoringJob({ projectId, suiteId: suite._id }, importJobId, {
      takeOver: true,
      // `?importJob=` is only ever handed out by an import.
      source: "import",
    });
  }, [projectId, importJobId, suite._id]);
  /**
   * An import lands on its drafts; a later visit lands on the suite.
   *
   * The difference is whether the reader has been shown THESE drafts, which is
   * a fact about the import and not about this component — the page unmounts
   * on navigation and on reload, so component state made a dismissal look like
   * a fresh import and a fresh import look like one already dismissed. The
   * store answers it instead. A review link is always the request to review.
   */
  // A running import belongs here from the moment it starts, before it has
  // produced a draft: otherwise the wait happens behind "No cases yet", which
  // is a page about a suite that has nothing in it rather than one about the
  // document being read.
  const importRunning =
    generation?.status === "running" &&
    (generation?.authoringSource === "import" ||
      generation?.authoringSource === "markdown");
  const reviewingImport = Boolean(
    projectId &&
    (importedDrafts.length || importRunning) &&
    (Boolean(importJobId) ||
      importRunning ||
      generation?.reviewRequestId !== generation?.reviewSeenId),
  );
  /**
   * Reveal imported drafts one at a time.
   *
   * The worker authors five cases per model call, so a six-case document lands
   * as five at once and then one — which reads as a stall and then a dump. The
   * drafts are already written by then; this only paces how they appear, so
   * the reader sees the list being built rather than replaced.
   */
  const [visibleDraftIds, setVisibleDraftIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const nextDraftId = importedDrafts.find(
    (draft) => !visibleDraftIds.has(draft.id),
  )?.id;
  useEffect(() => {
    if (!nextDraftId) return;
    const timer = window.setTimeout(
      () => setVisibleDraftIds((shown) => new Set([...shown, nextDraftId])),
      220,
    );
    return () => window.clearTimeout(timer);
  }, [nextDraftId]);
  // Read through a ref, never listed as a dependency. The parent passes an
  // inline arrow, so its identity changes every render; as a dependency it
  // re-created `exitImportReview`, which re-ran the effect below, which sets
  // the parent's state, which re-rendered the parent: an update loop that
  // React stops with "Maximum update depth exceeded", shown as "Could not
  // load Testing" the moment an import started.
  const onClearImportJobRef = useRef(onClearImportJob);
  useEffect(() => {
    onClearImportJobRef.current = onClearImportJob;
  }, [onClearImportJob]);
  const exitImportReview = useCallback(() => {
    if (projectId) markImportReviewSeen({ projectId, suiteId: suite._id });
    // Both, or the reader does not leave: `reviewingImport` is true whenever
    // the param is set, whatever the store says about drafts being seen.
    onClearImportJobRef.current?.();
  }, [projectId, suite._id]);
  useEffect(() => {
    if (!reviewingImport) return;
    onGeneratingChange?.({
      exit: exitImportReview,
      label: "Import test cases",
    });
    return () => onGeneratingChange?.(null);
  }, [reviewingImport, exitImportReview, onGeneratingChange]);

  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationConfig, setGenerationConfig] =
    useState<GenerateCasesConfig>();
  const handleGenerateCases = () => {
    if (projectId) setGenerationOpen(true);
  };
  // Generation needs a project to run against; without one the button can
  // only fail silently.
  const canGenerate = canGenerateTestCases && Boolean(projectId);

  const generating = Boolean(generationConfig && projectId);
  const exitGeneration = useCallback(() => setGenerationConfig(undefined), []);
  /**
   * Back to the suite WITH the scope dialog open. Reopening it in place would
   * not show: the generation view returns before the dialog is rendered.
   */
  const changeGenerationSettings = useCallback(() => {
    setGenerationConfig(undefined);
    setGenerationOpen(true);
  }, []);
  useEffect(() => {
    if (!generating) return;
    onGeneratingChange?.({ exit: exitGeneration });
    return () => onGeneratingChange?.(null);
  }, [generating, exitGeneration, onGeneratingChange]);

  const takeover = (() => {
    if (generationConfig && projectId)
      return (
        <EvalGenerationWorkspace
          key={`${projectId}:${suite._id}`}
          config={generationConfig}
          environmentId={generationEnvironmentId(
            suite,
            generationConfig.environmentId,
          )}
          projectId={projectId}
          suiteId={suite._id}
          suiteName={suite.name}
          onChangeSettings={changeGenerationSettings}
          onDone={exitGeneration}
        />
      );

    if (reviewingImport && projectId)
      return (
        <div
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-8"
          data-testid="suite-import-review"
        >
          <div className="mx-auto w-full max-w-5xl">
            <EvalGeneratedDrafts
              visibleDraftIds={visibleDraftIds}
              key={`${projectId}:${suite._id}:import`}
              projectId={projectId}
              suiteId={suite._id}
              suiteName={suite.name}
            />
          </div>
        </div>
      );
    return null;
  })();
  const generateDialog = generationOpen ? (
    <GenerateCasesDialog
      key={suite._id}
      suiteId={suite._id}
      environmentChoices={generationEnvironmentChoices(suite)}
      onClose={() => setGenerationOpen(false)}
      onGenerate={(config) => {
        setGenerationOpen(false);
        setGenerationConfig(config);
      }}
    />
  ) : null;

  return {
    generation,
    importedDrafts,
    reviewingImport,
    canGenerate,
    handleGenerateCases,
    takeover,
    generateDialog,
  };
}
