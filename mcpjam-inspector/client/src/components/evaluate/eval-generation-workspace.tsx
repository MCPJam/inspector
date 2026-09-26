import { useEffect, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import {
  evalSuiteKey,
  startEvalGeneration,
  useEvalGeneration,
} from "@/lib/mcpjam-agent/eval-workspace";
import {
  loadGenerateConfig,
  totalCases,
  DEFAULT_GENERATE_CONFIG,
  toGenerationOptions,
  type GenerateCasesConfig,
} from "@/lib/evals/eval-generation-config";
import { EvalGeneratedDrafts } from "./eval-generated-drafts";
import { describeMCPJamLimitMessage } from "@/lib/mcpjam-limit";
import { isUnretryableGenerationScope } from "@/shared/eval-generation-errors";

export function EvalGenerationWorkspace({
  projectId,
  suiteId,
  suiteName,
  autoStart = true,
  config,
  onChangeSettings,
  onDone,
}: {
  projectId: string;
  suiteId: string;
  suiteName: string;
  autoStart?: boolean;
  config?: GenerateCasesConfig;
  /** Reopen the scope dialog, for a failure that retrying cannot fix. */
  onChangeSettings?: () => void;
  /** Back to the suite, once there is nothing left to do here. */
  onDone?: () => void;
}) {
  const generation = useEvalGeneration(
    (s) => s.suites[evalSuiteKey({ projectId, suiteId })],
  );
  const started = useRef(false);
  const initialIds = useRef(
    new Set(generation?.drafts.map((draft) => draft.id)),
  );
  const [visibleIds, setVisibleIds] = useState(
    () => new Set(initialIds.current),
  );
  const [startError, setStartError] = useState<string>();
  const [expectedCount] = useState(() => {
    const selected = config ?? loadGenerateConfig(suiteId);
    // Show placeholders for the lower bound; the final count is model-selected.
    if (selected.testSet) return selected.testSet === "quick" ? 5 : 20;
    return totalCases(selected) || totalCases(DEFAULT_GENERATE_CONFIG);
  });
  const start = () => {
    initialIds.current = new Set(generation?.drafts.map((draft) => draft.id));
    setVisibleIds(new Set(initialIds.current));
    setStartError(undefined);
    try {
      startEvalGeneration(
        {
          kind: "evals",
          version: 1,
          id: `generate:${suiteId}`,
          projectId,
          suiteId,
          suiteName,
        },
        "Generate discovery-backed test cases for this suite using its connected servers. Stage the cases for review; do not save or run them.",
        config ? toGenerationOptions(config) : undefined,
      );
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    useAgentPanelStore.getState().setOpen(false);
    if (started.current || !autoStart) return;
    started.current = true;
    if (generation?.status !== "running") start();
    // Generation is launched once on entry, including under Strict Mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nextDraftId = generation?.drafts.find(
    (draft) => !visibleIds.has(draft.id),
  )?.id;
  useEffect(() => {
    if (!nextDraftId) return;
    const timer = window.setTimeout(() => {
      setVisibleIds((current) => new Set([...current, nextDraftId]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [nextDraftId]);

  const error = startError || generation?.error;
  // The limit dialog already opened on the refusal; the inline line only has
  // to say why generation stopped, not echo the raw JSON body.
  const errorText = error
    ? (describeMCPJamLimitMessage(error) ?? error)
    : undefined;
  const scopeIsUnfixableByRetry = isUnretryableGenerationScope(error);
  /**
   * An empty list reads as "nothing was generated", but the usual way to
   * reach it is the opposite: every draft was saved or discarded, and the
   * list emptied as they went. Remember that a draft was here.
   *
   * Cleared when a run starts with nothing carried over: a retry that returns
   * no cases at all is the "nothing was generated" case again, and a flag that
   * only ever latched true reported the previous run's drafts as this one's.
   */
  const [sawDraft, setSawDraft] = useState(false);
  const draftCount = generation?.drafts.length ?? 0;
  const generationStatus = generation?.status;
  useEffect(() => {
    if (draftCount > 0) setSawDraft(true);
    else if (generationStatus === "running") setSawDraft(false);
  }, [draftCount, generationStatus]);
  const running = generation?.status === "running" || (!generation && !error);
  const revealing = Boolean(nextDraftId);
  const busy = running || revealing;
  const revealedCount = [...visibleIds].filter(
    (id) => !initialIds.current.has(id),
  ).length;
  const waitingCount =
    generation?.drafts.filter((draft) => !visibleIds.has(draft.id)).length ?? 0;
  const skeletonCount = running
    ? Math.max(expectedCount - revealedCount, waitingCount)
    : waitingCount;

  return (
    <section
      data-testid="suite-case-generation-workspace"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      {/* No title and no status line here: the breadcrumb above reads
          Evaluate / <suite> / Generate test cases, and the drafts panel below
          carries the state — how many are written, the failure, and the retry.
          A second "Generating cases…" in the corner said it twice. */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {running && (
          <p className="text-sm text-muted-foreground">
            Discovering your servers and drafting cases…
          </p>
        )}
        <EvalGeneratedDrafts
          projectId={projectId}
          suiteId={suiteId}
          suiteName={suiteName}
          visibleDraftIds={visibleIds}
          hideChat
        />
        {Array.from({ length: skeletonCount }, (_, index) => (
          <div
            key={index}
            data-testid="generating-case-skeleton"
            className="space-y-3 rounded-xl border border-border bg-card p-5"
            aria-hidden="true"
          >
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-3 w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
        {error && (
          <div className="space-y-3">
            {(startError || !generation?.drafts.length) && (
              <p role="alert" className="text-sm text-destructive">
                {errorText}
              </p>
            )}
            {/* Retrying a scope the servers cannot satisfy fails identically
                every time. Offer the setting that would fix it instead. */}
            {scopeIsUnfixableByRetry && onChangeSettings ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onChangeSettings}
                disabled={busy}
              >
                Change generation settings
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={start}
                disabled={busy}
              >
                Retry generation
              </Button>
            )}
          </div>
        )}
        {!busy && !error && !generation?.drafts.length && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {sawDraft
                ? "Every generated case has been reviewed."
                : "No cases were generated."}
            </p>
            {/* The breadcrumb is the only other way back, and it does not
                read as the next step once the work here is done. */}
            {onDone && (
              <Button variant="outline" size="sm" onClick={onDone}>
                Back to {suiteName}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
