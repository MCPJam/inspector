import { InsightPrimaryBlock } from "./insight-primary-block";

/**
 * Diff-based run insights (vs prior completed baseline).
 * Thin wrapper around the generic InsightPrimaryBlock with title="Run insights".
 */
export function RunInsightsPrimaryBlock(props: {
  summary: string | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
  /** When true, omit outer card chrome for use inside the run metrics stack. */
  embedded?: boolean;
}) {
  return <InsightPrimaryBlock title="Run insights" {...props} />;
}
