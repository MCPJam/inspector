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
import { Button } from "@mcpjam/design-system/button";
import { useInsightsEnvelope } from "@/components/shared/actionable-insights/use-insights-envelope";
import { UnifiedFindingsPanel } from "@/components/shared/actionable-insights/unified-findings-panel";
import { useUnifiedFindings } from "@/components/shared/actionable-insights/use-unified-findings";
import type { BorrowedGenerationController } from "@/components/shared/actionable-insights/use-unified-findings";
import type { FindingEvidenceLocator } from "@/components/shared/actionable-insights/finding-evidence";
import type { EvalIteration } from "../evals/types";
import { affectedRowsById } from "./affected-iteration-rows";

export type UnifiedFindingsSectionProps = {
  suiteRunId: string;
  iterations?: readonly EvalIteration[];
  scopeControl?: React.ReactNode;
  /** The page's existing serverQuality controller. */
  generation: BorrowedGenerationController;
  /** Focus one iteration's evidence through the app's own routing. */
  onOpenIteration?: (iterationId: string) => void;
  /** The run's client, shown on each affected iteration row. */
  clientLabel?: string | null;
  /** Shown when no findings have been built, so the slot is never empty. */
  fallback?: React.ReactNode;
};

function UnifiedFindingsBody({
  suiteRunId,
  iterations = [],
  generation,
  scopeControl,
  onOpenIteration,
  clientLabel,
  fallback,
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
    <section data-testid="unified-findings-section">
      <div>
        <UnifiedFindingsPanel
          runPending={iterations.some(
            (iteration) =>
              iteration.status === "pending" || iteration.status === "running",
          )}
          analysis={state.experiment?.analysis}
          snapshot={state.experiment?.snapshot ?? null}
          findings={state.findings}
          provenance={state.provenance}
          observationState={state.envelope?.observationState ?? null}
          observationCoverage={state.envelope?.observationCoverage ?? null}
          mode={state.mode}
          analyze={state.analyze}
          analysisFailure={state.analysisFailure}
          build={state.build}
          scopeControl={scopeControl}
          iterationRows={affectedRowsById(iterations, clientLabel)}
          {...(fallback !== undefined ? { fallback } : {})}
          backendUnavailableNote={state.backendUnavailableNote}
          context={{ rerunLabel: "this eval suite" }}
          {...(onOpenEvidence ? { onOpenEvidence } : {})}
        />
      </div>
    </section>
  );
}

export function UnifiedFindingsSection(props: UnifiedFindingsSectionProps) {
  return (
    <ErrorBoundary
      key={props.suiteRunId}
      name="evaluate-unified-findings"
      fallback={({ reset }) => (
        <div role="alert" className="py-3">
          <p className="text-sm">Findings could not be loaded for this run.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={reset}>
            Retry findings
          </Button>
        </div>
      )}
    >
      <UnifiedFindingsBody {...props} />
    </ErrorBoundary>
  );
}
