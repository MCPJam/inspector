import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
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

export function EvalGenerationWorkspace({
  projectId,
  suiteId,
  suiteName,
  autoStart = true,
  config,
}: {
  projectId: string;
  suiteId: string;
  suiteName: string;
  autoStart?: boolean;
  config?: GenerateCasesConfig;
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
  const [expectedCount] = useState(
    () => {
      const selected = config ?? loadGenerateConfig(suiteId);
      // Show placeholders for the lower bound; the final count is model-selected.
      if (selected.testSet) return selected.testSet === "quick" ? 5 : 20;
      return totalCases(selected) || totalCases(DEFAULT_GENERATE_CONFIG);
    },
  );
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
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Generate test cases</h2>
          <p className="text-xs text-muted-foreground">{suiteName}</p>
        </div>
        <div
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          {busy ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            !error && (
              <CheckCircle2 className="size-4 text-success" aria-hidden />
            )
          )}
          {running
            ? "Generating cases…"
            : revealing
              ? "Loading cases…"
              : error
                ? "Generation stopped"
                : "Generation complete"}
        </div>
      </header>
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
                {error}
              </p>
            )}
            <Button variant="outline" size="sm" onClick={start} disabled={busy}>
              Retry generation
            </Button>
          </div>
        )}
        {!busy && !error && !generation?.drafts.length && (
          <p className="text-sm text-muted-foreground">
            No generated drafts to review.
          </p>
        )}
      </div>
    </section>
  );
}
