import { useModelMatrixCapability } from "@/hooks/use-model-matrix-capability";

/**
 * Can this project compose client × model cells?
 *
 * THE SPLIT THIS ENCODES. Two different things used to share one PostHog flag:
 *
 *  - NAMED environments — the picker, the Environments page, the skills slot,
 *    and every surface that prints an environment's name or revision. Those
 *    stay behind `project-environments-enabled` (`useProjectEnvironmentsEnabled`).
 *  - AD-HOC cells — the nameless, content-addressed rows a client × model
 *    choice mints. The backend calls them "launch-path substrate" and gates
 *    none of them (`convex/projectEnvironments.ts ensureAdhocEnvironments`,
 *    `testSuites.ts setSuiteEnvironments`, `startTestSuiteRun`), which is why
 *    `mcpjam eval --compose-model` already works for an unflagged user. Only
 *    the browser was withholding the matrix.
 *
 * So the honest question for the compose strip is not "is the feature on" but
 * "does this deployment accept a model on a cell" — the `modelMatrix`
 * capability probe, which is a VERSION-SKEW signal, not a feature flag.
 *
 * `pending` is its own answer on purpose: the probe returns `undefined` while
 * in flight, and treating that as "not capable" would render the legacy strip
 * for a frame and then swap it, which reads as the page changing its mind.
 * Callers show the compose strip disabled instead.
 */
export function useEvalComposeCapable(projectId: string | null | undefined): {
  capable: boolean;
  pending: boolean;
} {
  const modelMatrix = useModelMatrixCapability(projectId ?? null);
  // Cells are project-scoped rows, so a suite with no project can only ever run
  // the legacy axes — no capability makes that untrue.
  const hasProject = Boolean(projectId);
  return {
    capable: hasProject && modelMatrix === true,
    pending: hasProject && modelMatrix === undefined,
  };
}
