/**
 * The unified-findings experiment, mounted on the Evaluate run page.
 *
 * Its own error boundary and its own subscription, for the same reason
 * `ActionableFindings` has them: Convex's `useQuery` throws when the deployed
 * backend has no such function, and a hook called in the run page's own body
 * would take the whole page down during the window when the two repos are not
 * yet paired. The subscription lives inside the boundary, so "degrades on an
 * older backend" is actually true.
 *
 * It does NOT create a generation controller. The run page already has one
 * (`useServerQuality`, with auto-request off); this section borrows it so a
 * click cannot become two billable requests.
 */
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useInsightsEnvelope } from "@/components/shared/actionable-insights/use-insights-envelope";
import { UnifiedFindingsPanel } from "@/components/shared/actionable-insights/unified-findings-panel";
import { useUnifiedFindings } from "@/components/shared/actionable-insights/use-unified-findings";
import type { BorrowedGenerationController } from "@/components/shared/actionable-insights/use-unified-findings";
import type { FindingEvidenceLocator } from "@/components/shared/actionable-insights/finding-evidence";

export type UnifiedFindingsSectionProps = {
  suiteRunId: string;
  /** The page's existing serverQuality controller. */
  generation: BorrowedGenerationController;
  /** Focus one iteration's evidence through the app's own routing. */
  onOpenIteration?: (iterationId: string) => void;
};

function UnifiedFindingsBody({
  suiteRunId,
  generation,
  onOpenIteration,
}: UnifiedFindingsSectionProps) {
  const envelope = useInsightsEnvelope({ kind: "eval_run", suiteRunId });
  const state = useUnifiedFindings({ suiteRunId, envelope, generation });

  const onOpenEvidence = onOpenIteration
    ? (locator: FindingEvidenceLocator) => {
        // A TYPED locator: this page routes iterations and nothing else, and
        // it says so rather than guessing from the id's shape.
        if (locator.kind !== "iteration") return;
        onOpenIteration(locator.id);
      }
    : undefined;

  return (
    <section
      className="border-t border-border/40"
      data-testid="unified-findings-section"
    >
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="text-[13px] font-semibold text-foreground">
            What broke, and what to do about it
          </h3>
          <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            Experiment
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            Built from this run&apos;s recorded evidence.
          </span>
        </div>
        <div className="mt-3">
          <UnifiedFindingsPanel
            snapshot={state.experiment?.snapshot ?? null}
            findings={state.findings}
            provenance={state.provenance}
            observationState={state.envelope?.observationState ?? null}
            observationCoverage={state.envelope?.observationCoverage ?? null}
            mode={state.mode}
            onModeChange={state.setMode}
            build={state.build}
            enrich={state.enrich}
            backendUnavailableNote={state.backendUnavailableNote}
            context={{ rerunLabel: "this eval suite" }}
            {...(onOpenEvidence ? { onOpenEvidence } : {})}
          />
        </div>
      </div>
    </section>
  );
}

export function UnifiedFindingsSection(props: UnifiedFindingsSectionProps) {
  return (
    <ErrorBoundary name="evaluate-unified-findings" fallback={null}>
      <UnifiedFindingsBody {...props} />
    </ErrorBoundary>
  );
}
