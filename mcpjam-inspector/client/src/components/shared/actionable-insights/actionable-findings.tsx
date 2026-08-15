/**
 * The mountable actionable-findings surface: subscription + panel + its own
 * error boundary, in one component.
 *
 * WHY THIS EXISTS RATHER THAN CALLING THE HOOK AT EACH CALL SITE. Convex's
 * `useQuery` throws when the deployed backend has no such function, which is
 * exactly the state during the deploy window this program ships in (backend
 * first, then client — but nothing enforces the order). A hook called in a
 * detail view's own body throws in THAT component's render, so a boundary the
 * caller wraps around the panel never sees it and the whole page dies. Moving
 * the subscription inside a child of the boundary is what makes the documented
 * "degrades silently on an older backend" actually true.
 *
 * Callers pass a surface descriptor and get nothing at all when there is no
 * envelope — no spinner, no empty frame.
 */
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ActionableFindingsPanel } from "./actionable-findings-panel";
import {
  useInsightsEnvelope,
  type InsightsEnvelopeSurface,
} from "./use-insights-envelope";
import type { FindingPromptContext } from "./finding-prompts";

function ActionableFindingsInner({
  surface,
  context,
  onOpenSession,
}: {
  surface: InsightsEnvelopeSurface;
  context?: FindingPromptContext;
  onOpenSession?: (sessionId: string) => void;
}) {
  const envelope = useInsightsEnvelope(surface);
  return (
    <ActionableFindingsPanel
      envelope={envelope}
      context={context}
      onOpenSession={onOpenSession}
    />
  );
}

export function ActionableFindings(props: {
  surface: InsightsEnvelopeSurface;
  context?: FindingPromptContext;
  onOpenSession?: (sessionId: string) => void;
  /** Distinguishes this mount in error telemetry. */
  boundaryName?: string;
}) {
  const { boundaryName = "actionable-findings", ...inner } = props;
  return (
    <ErrorBoundary name={boundaryName} fallback={null}>
      <ActionableFindingsInner {...inner} />
    </ErrorBoundary>
  );
}
